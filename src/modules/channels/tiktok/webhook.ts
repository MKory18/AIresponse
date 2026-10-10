import { enqueueJob } from "@/modules/jobs/service";
import { childLogger } from "@/core/logger";
import { deriveTikTokEventId, normalizeTikTokEvent, verifyTikTokWebhook, type AssumedTikTokEvent } from "./normalizer";
import { TikTokChannelAdapter } from "./adapter";
import { getChannelAdapter } from "../registry";
import { ChannelNotSupportedError } from "../types";
import type { Db } from "@/modules/customers/service";

const log = childLogger("webhooks.tiktok");

export interface TikTokIngestResult {
  status: "OK" | "DUPLICATE" | "UNKNOWN_ACCOUNT" | "INVALID_SECRET" | "IGNORED";
  normalizedCount?: number;
}

/**
 * TikTok webhook ingestion (P5-E — LOCAL ONLY). Routes by the configured
 * business account id, verifies the interim shared secret, persists raw,
 * and enqueues the shared channel-inbound job. Live traffic is BLOCKED
 * until Business Messaging access is approved for the account.
 */
export async function ingestTikTokWebhook(
  db: Db,
  payload: unknown,
  secretHeader: string | null,
  businessAccountId: string | null
): Promise<TikTokIngestResult> {
  const event = payload as AssumedTikTokEvent;
  if (!event.conversation_id || !event.message_id) return { status: "IGNORED" };
  if (!businessAccountId) return { status: "UNKNOWN_ACCOUNT" };

  // Two-step lookup (no relation include): identical on Postgres and doubles.
  const account = await (db as any).channelAccount?.findFirst?.({
    where: { provider: "TIKTOK", externalAccountId: businessAccountId },
  });
  const channel = (account as { channelId?: string } | null)?.channelId
    ? ((await db.channel.findUnique({
        where: { id: (account as { channelId: string }).channelId },
        select: { id: true, workspaceId: true, status: true },
      })) as { id: string; workspaceId: string; status: string } | null)
    : null;
  if (!account || !channel?.workspaceId || channel?.status !== "CONNECTED") {
    return { status: "UNKNOWN_ACCOUNT" };
  }
  const meta = ((account as { metadata?: Record<string, unknown> }).metadata ?? {}) as { ttWebhookSecret?: string };
  if (!verifyTikTokWebhook(secretHeader, meta.ttWebhookSecret)) {
    log.warn("tiktok.webhook.rejected");
    return { status: "INVALID_SECRET" };
  }
  const workspaceId = channel.workspaceId as string;

  const externalEventId = deriveTikTokEventId(event);
  let webhookEvent;
  try {
    webhookEvent = await (db as any).webhookEvent.create({
      data: {
        workspaceId,
        channelType: "TIKTOK",
        externalEventId,
        source: "tiktok",
        payload: payload as object,
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return { status: "DUPLICATE" };
    }
    throw err;
  }

  const adapter = getChannelAdapter("TIKTOK", {
    tiktok: { channelAccountId: (account as { id: string }).id, channelId: (channel as { id?: string }).id },
  });
  if (!(adapter instanceof TikTokChannelAdapter)) {
    throw new ChannelNotSupportedError("TIKTOK");
  }
  const normalized = adapter.receiveMessage(payload);
  if (normalized.length > 0) {
    await enqueueJob(db, {
      workspaceId,
      type: "process_channel_inbound",
      payload: {
        webhookEventId: webhookEvent.id,
        workspaceId,
        channelType: "TIKTOK",
        channelId: (channel as { id?: string }).id,
        messages: normalized,
      },
    });
  } else {
    await (db as any).webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { processedAt: new Date() },
    });
  }
  // Non-text payloads normalize to zero messages (acknowledged, stored).
  return { status: "OK", normalizedCount: normalized.length };
}
