import { enqueueJob } from "@/modules/jobs/service";
import { atomically } from "../webhook-tx";
import { readChannelSecret } from "../secret-at-rest";
import { childLogger } from "@/core/logger";
import { deriveTelegramEventId, verifyTelegramWebhook } from "./normalizer";
import { TelegramChannelAdapter } from "./adapter";
import { getChannelAdapter } from "../registry";
import { ChannelNotSupportedError } from "../types";
import type { Db } from "@/modules/customers/service";

const log = childLogger("webhooks.telegram");

export interface TelegramIngestResult {
  status: "OK" | "DUPLICATE" | "UNKNOWN_BOT" | "INVALID_SECRET" | "IGNORED";
  normalizedCount?: number;
}

/**
 * Telegram webhook ingestion (P5-C): secret-header verification → bot
 * routing (secret is per-channel metadata) → raw persist → normalize via
 * the registry adapter → shared channel-inbound job.
 */
export async function ingestTelegramWebhook(
  db: Db,
  payload: unknown,
  secretHeader: string | null
): Promise<TelegramIngestResult> {
  const updateId = (payload as { update_id?: number }).update_id;
  if (typeof updateId !== "number") return { status: "IGNORED" };

  // Route by secret: each connected bot owns a unique webhook secret stored
  // encrypted in its channel metadata (legacy plaintext rows still verify;
  // never the bot token itself). Two-step lookup (no relation include)
  // behaves identically on Postgres and the test double.
  const accounts = await (db as any).channelAccount?.findMany?.({
    where: { provider: "TELEGRAM" },
  });
  let match: { id: string; workspaceId?: string; status?: string } | null = null;
  for (const a of ((accounts ?? []) as Array<{ id: string; channelId?: string; metadata?: Record<string, unknown> }>)) {
    // OCR-2026-10-16: السّر مشفّر وسكونًا (_Enc) — الصفوف النصية القديمة
    // بضلّوا تتسرب من قارئ متسامح لحد ما تسير إعادة ببون الصف.
    if (!verifyTelegramWebhook(secretHeader, readChannelSecret(a.metadata, "tgWebhookSecretEnc", "tgWebhookSecret") ?? undefined)) continue;
    const ch = a.channelId
      ? ((await db.channel.findUnique({ where: { id: a.channelId }, select: { id: true, workspaceId: true, status: true } })) as {
          id: string;
          workspaceId: string;
          status: string;
        } | null)
      : null;
    if (ch && ch.status === "CONNECTED") {
      match = { id: a.id, workspaceId: ch.workspaceId, status: ch.status };
      (match as { channelId?: string }).channelId = ch.id;
      break;
    }
  }
  if (!match?.workspaceId) {
    log.warn("telegram.webhook.rejected");
    return { status: "INVALID_SECRET" };
  }
  const workspaceId = match.workspaceId;
  const channelId = (match as { channelId?: string }).channelId;

  const externalEventId = deriveTelegramEventId(payload as { update_id?: number });

  // OCR-2026-10-16: التسوية النقية قبل فتح أي أثر (الانهيار = إعادة تسليم
  // نظيفة من تيليجرام بلا صف يتيم).
  const adapter = getChannelAdapter("TELEGRAM", { telegram: { channelAccountId: match.id, channelId } });
  if (!(adapter instanceof TelegramChannelAdapter)) {
    throw new ChannelNotSupportedError("TELEGRAM");
  }
  const normalized = adapter.receiveMessage(payload);

  // OCR-2026-10-16 (سباق): «إنشاء الحدث ← الطابور» بمعاملة واحدة عند توفرها.
  let webhookEvent: { id: string } | undefined;
  let duplicate = false;
  await atomically(db, async (tx) => {
    try {
      webhookEvent = (await (tx as unknown as typeof db).webhookEvent.create({
        data: {
          workspaceId,
          channelType: "TELEGRAM",
          externalEventId,
          source: "telegram",
          payload: payload as object,
        },
      })) as { id: string };
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        duplicate = true;
        return;
      }
      throw err;
    }
    if (normalized.length > 0) {
      await enqueueJob(tx, {
        workspaceId,
        type: "process_channel_inbound",
        payload: {
          webhookEventId: webhookEvent.id,
          workspaceId,
          channelType: "TELEGRAM",
          channelId,
          messages: normalized,
        },
      });
    } else {
      await (tx as unknown as typeof db).webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processedAt: new Date() },
      });
    }
  });
  if (duplicate) {
    return { status: "DUPLICATE" };
  }
  return { status: "OK", normalizedCount: normalized.length };
}
