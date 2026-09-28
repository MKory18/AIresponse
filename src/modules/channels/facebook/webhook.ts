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

  const entries = (payload as { entry?: { id?: string }[] }).entry ?? [];
  if (entries.length === 0 || !entries[0]?.id) return { status: "NON_PAGE_OBJECT" };

  // Meta may batch entries for different pages in one POST — route per entry
  // so page B's messages are never recorded under page A's workspace.
  const distinctPageIds = [...new Set(entries.map((e) => e?.id).filter(Boolean))] as string[];
  if (distinctPageIds.length <= 1) {
    return ingestSinglePage(db, payload, distinctPageIds[0]);
  }

  let total = 0;
  let lastStatus: IngestResult["status"] = "OK";
  for (const pageId of distinctPageIds) {
    const subPayload = { object: "page", entry: entries.filter((e) => e?.id === pageId) };
    const res = await ingestSinglePage(db, subPayload, pageId);
    total += res.normalizedCount ?? 0;
    if (res.status !== "OK" && res.status !== "DUPLICATE") lastStatus = res.status;
  }
  return { status: lastStatus, normalizedCount: total };
}

async function ingestSinglePage(db: Db, payload: unknown, pageId: string): Promise<IngestResult> {

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
  } catch (err) {
    // Only unique violations are duplicates; real DB errors must surface
    // so the job retries instead of silently dropping the webhook.
    const code = (err as { code?: string })?.code;
    if (code === "P2002") {
      log.info({ event: "facebook.webhook.duplicate", pageId });
      return { status: "DUPLICATE" };
    }
    throw err;
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
