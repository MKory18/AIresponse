import { enqueueJob } from "@/modules/jobs/service";
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
  // in its channel metadata (never the bot token itself). Two-step lookup
  // (no relation include) behaves identically on Postgres and the test double.
  const accounts = await (db as any).channelAccount?.findMany?.({
    where: { provider: "TELEGRAM" },
  });
  let match: { id: string; metadata?: { tgWebhookSecret?: string }; workspaceId?: string; status?: string } | null = null;
  for (const a of ((accounts ?? []) as Array<{ id: string; channelId?: string; metadata?: { tgWebhookSecret?: string } }>)) {
    if (!verifyTelegramWebhook(secretHeader, a.metadata?.tgWebhookSecret)) continue;
    const ch = a.channelId
      ? ((await db.channel.findUnique({ where: { id: a.channelId }, select: { id: true, workspaceId: true, status: true } })) as {
          id: string;
          workspaceId: string;
          status: string;
        } | null)
      : null;
    if (ch && ch.status === "CONNECTED") {
      match = { id: a.id, metadata: a.metadata, workspaceId: ch.workspaceId, status: ch.status };
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
  let webhookEvent;
  try {
    webhookEvent = await (db as any).webhookEvent.create({
      data: {
        workspaceId,
        channelType: "TELEGRAM",
        externalEventId,
        source: "telegram",
        payload: payload as object,
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return { status: "DUPLICATE" };
    }
    throw err;
  }

  const adapter = getChannelAdapter("TELEGRAM", { telegram: { channelAccountId: match.id, channelId } });
  if (!(adapter instanceof TelegramChannelAdapter)) {
    throw new ChannelNotSupportedError("TELEGRAM");
  }
  const normalized = adapter.receiveMessage(payload);
  if (normalized.length > 0) {
    await enqueueJob(db, {
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
    await (db as any).webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { processedAt: new Date() },
    });
  }
  return { status: "OK", normalizedCount: normalized.length };
}
