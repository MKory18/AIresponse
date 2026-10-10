import { enqueueJob } from "@/modules/jobs/service";
import { childLogger } from "@/core/logger";
import { deriveInstagramEventId } from "./normalizer";
import { InstagramChannelAdapter } from "./adapter";
import { getChannelAdapter } from "../registry";
import { ChannelNotSupportedError } from "../types";
import type { Db } from "@/modules/customers/service";

const log = childLogger("webhooks.instagram");

export interface InstagramIngestResult {
  status: "OK" | "DUPLICATE" | "UNKNOWN_ACCOUNT" | "NON_INSTAGRAM_OBJECT";
  normalizedCount?: number;
}

/**
 * Instagram webhook ingestion (P5-B): object "instagram" → account routing
 * by IGID → raw persist (idempotent) → normalize via the registry-resolved
 * real adapter → enqueue the SHARED channel-inbound job.
 */
export async function ingestInstagramWebhook(
  db: Db,
  payload: unknown
): Promise<InstagramIngestResult> {
  const object = (payload as { object?: string }).object;
  if (object !== "instagram") {
    return { status: "NON_INSTAGRAM_OBJECT" };
  }
  const entries = (payload as { entry?: { id?: string }[] }).entry ?? [];
  if (entries.length === 0 || !entries[0]?.id) return { status: "NON_INSTAGRAM_OBJECT" };

  const distinctIds = [...new Set(entries.map((e) => e?.id).filter(Boolean))] as string[];
  let total = 0;
  let lastStatus: InstagramIngestResult["status"] = "OK";
  let allDuplicate = true;
  for (const igId of distinctIds) {
    const res = await ingestSingleAccount(db, { object: "instagram", entry: entries.filter((e) => e?.id === igId) }, igId);
    total += res.normalizedCount ?? 0;
    if (res.status !== "DUPLICATE") allDuplicate = false;
    if (res.status !== "OK" && res.status !== "DUPLICATE") lastStatus = res.status;
  }
  // A pure replay reports DUPLICATE (observable at-most-once); mixed batches
  // follow the Meta convention (OK + counts).
  if (distinctIds.length > 0 && allDuplicate) return { status: "DUPLICATE", normalizedCount: 0 };
  return { status: lastStatus, normalizedCount: total };
}

async function ingestSingleAccount(db: Db, payload: unknown, igId: string): Promise<InstagramIngestResult> {
  // Two-step lookup (no relation include): identical on Postgres and doubles.
  const account = await (db as any).channelAccount?.findFirst?.({
    where: { provider: "INSTAGRAM", externalAccountId: igId },
  });
  const channel = (account as { channelId?: string } | null)?.channelId
    ? ((await db.channel.findUnique({
        where: { id: (account as { channelId: string }).channelId },
        select: { id: true, workspaceId: true, status: true },
      })) as { id: string; workspaceId: string; status: string } | null)
    : null;
  if (!account || !channel?.workspaceId || channel?.status !== "CONNECTED") {
    const msgCount = ((payload as { entry?: { messaging?: unknown[] }[] }).entry ?? [])
      .flatMap((e) => e?.messaging ?? []).length;
    log.error({ igId, droppedMessages: msgCount }, "webhook_account_not_connected");
    return { status: "UNKNOWN_ACCOUNT" };
  }
  const workspaceId = channel.workspaceId as string;

  const externalEventId = deriveInstagramEventId(payload);
  let webhookEvent;
  try {
    webhookEvent = await (db as any).webhookEvent.create({
      data: {
        workspaceId,
        channelType: "INSTAGRAM",
        externalEventId,
        source: "instagram",
        payload: payload as object,
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      log.info({ event: "instagram.webhook.duplicate", igId });
      return { status: "DUPLICATE" };
    }
    throw err;
  }

  const adapter = getChannelAdapter("INSTAGRAM", {
    instagram: { igId, channelAccountId: (account as { id: string }).id, channelId: (channel as { id?: string }).id },
  });
  if (!(adapter instanceof InstagramChannelAdapter)) {
    throw new ChannelNotSupportedError("INSTAGRAM");
  }
  const normalized = adapter.receiveMessage(payload);
  if (normalized.length > 0) {
    await enqueueJob(db, {
      workspaceId,
      type: "process_channel_inbound",
      payload: {
        webhookEventId: webhookEvent.id,
        workspaceId,
        channelType: "INSTAGRAM",
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
  return { status: "OK", normalizedCount: normalized.length };
}
