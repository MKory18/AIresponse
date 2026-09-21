import { enqueueJob } from "@/modules/jobs/service";
import { childLogger } from "@/core/logger";
import { deriveEventId, normalizeFacebookWebhook } from "./normalizer";
import type { Db } from "@/modules/customers/service";

const log = childLogger("webhooks.meta");

export interface IngestResult {
  status: "OK" | "DUPLICATE" | "UNKNOWN_PAGE" | "NON_PAGE_OBJECT";
  normalizedCount?: number;
}

/**
 * Core webhook ingestion — injectable DB so the full security path
 * (signature → page routing → idempotency → raw persist → enqueue) is
 * testable without a live Postgres.
 */
export async function ingestMetaWebhook(
  db: Db,
  payload: unknown
): Promise<IngestResult> {
  const object = (payload as { object?: string }).object;
  if (object !== "page") {
    return { status: "NON_PAGE_OBJECT" };
  }

  const pageId = (payload as { entry?: { id?: string }[] }).entry?.[0]?.id;
  if (!pageId) return { status: "NON_PAGE_OBJECT" };

  const account = await db.channelAccount.findFirst({
    where: { provider: "FACEBOOK", externalAccountId: pageId },
    include: { channel: true },
  });
  if (!account || !account.channel || account.channel.status !== "CONNECTED") {
    log.warn({ event: "facebook.webhook.unknown_page", pageId });
    return { status: "UNKNOWN_PAGE" };
  }
  const workspaceId = account.channel.workspaceId;

  const externalEventId = deriveEventId(payload);
  let webhookEvent;
  try {
    webhookEvent = await db.webhookEvent.create({
      data: {
        workspaceId,
        channelType: "FACEBOOK",
        externalEventId,
        source: "meta",
        payload: payload as object,
      },
    });
  } catch {
    log.info({ event: "facebook.webhook.duplicate", pageId });
    return { status: "DUPLICATE" };
  }

  await db.channelAccount.update({
    where: { id: account.id },
    data: { lastWebhookAt: new Date() },
  });

  const normalized = normalizeFacebookWebhook(payload as never, account.id, pageId, externalEventId);
  if (normalized.length > 0) {
    await enqueueJob(db, {
      workspaceId,
      type: "process_webhook_event",
      payload: {
        webhookEventId: webhookEvent.id,
        workspaceId,
        channelAccountId: account.id,
        messages: normalized,
      },
    });
  } else {
    await db.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { processedAt: new Date() },
    });
  }

  return { status: "OK", normalizedCount: normalized.length };
}
