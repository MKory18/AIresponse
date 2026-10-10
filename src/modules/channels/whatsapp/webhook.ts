import { enqueueJob } from "@/modules/jobs/service";
import { childLogger } from "@/core/logger";
import { deriveWhatsAppEventId } from "./normalizer";
import { WhatsAppChannelAdapter } from "./adapter";
import { getChannelAdapter } from "../registry";
import { ChannelNotSupportedError } from "../types";
import type { Db } from "@/modules/customers/service";

const log = childLogger("webhooks.whatsapp");

export interface WhatsAppIngestResult {
  status: "OK" | "DUPLICATE" | "UNKNOWN_NUMBER" | "NON_WHATSAPP_OBJECT";
  normalizedCount?: number;
}

/**
 * WhatsApp webhook ingestion (P5-D): object "whatsapp_business_account" →
 * number routing by metadata.phone_number_id → raw persist → normalize via
 * the registry adapter → shared channel-inbound job. Statuses-only posts
 * (delivery/read signals) normalize to zero messages and are acknowledged.
 */
export async function ingestWhatsAppWebhook(
  db: Db,
  payload: unknown
): Promise<WhatsAppIngestResult> {
  const object = (payload as { object?: string }).object;
  if (object !== "whatsapp_business_account") {
    return { status: "NON_WHATSAPP_OBJECT" };
  }
  const changes =
    (payload as { entry?: { changes?: { value?: { metadata?: { phone_number_id?: string } } }[] }[] }).entry?.flatMap(
      (e) => e.changes ?? []
    ) ?? [];
  const numberIds = [...new Set(changes.map((c) => c.value?.metadata?.phone_number_id).filter(Boolean))] as string[];
  if (numberIds.length === 0) return { status: "NON_WHATSAPP_OBJECT" };

  let total = 0;
  let lastStatus: WhatsAppIngestResult["status"] = "OK";
  let allDuplicate = true;
  for (const phoneNumberId of numberIds) {
    const res = await ingestSingleNumber(db, payload, phoneNumberId);
    total += res.normalizedCount ?? 0;
    if (res.status !== "DUPLICATE") allDuplicate = false;
    if (res.status !== "OK" && res.status !== "DUPLICATE") lastStatus = res.status;
  }
  if (numberIds.length > 0 && allDuplicate) return { status: "DUPLICATE", normalizedCount: 0 };
  return { status: lastStatus, normalizedCount: total };
}

async function ingestSingleNumber(db: Db, payload: unknown, phoneNumberId: string): Promise<WhatsAppIngestResult> {
  // Two-step lookup (no relation include): identical on Postgres and doubles.
  const account = await (db as any).channelAccount?.findFirst?.({
    where: { provider: "WHATSAPP", externalAccountId: phoneNumberId },
  });
  const channel = (account as { channelId?: string } | null)?.channelId
    ? ((await db.channel.findUnique({
        where: { id: (account as { channelId: string }).channelId },
        select: { id: true, workspaceId: true, status: true },
      })) as { id: string; workspaceId: string; status: string } | null)
    : null;
  if (!account || !channel?.workspaceId || channel?.status !== "CONNECTED") {
    log.error({ phoneNumberId }, "webhook_number_not_connected");
    return { status: "UNKNOWN_NUMBER" };
  }
  const workspaceId = channel.workspaceId as string;

  const externalEventId = deriveWhatsAppEventId(payload);
  let webhookEvent;
  try {
    webhookEvent = await (db as any).webhookEvent.create({
      data: {
        workspaceId,
        channelType: "WHATSAPP",
        externalEventId,
        source: "whatsapp",
        payload: payload as object,
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return { status: "DUPLICATE" };
    }
    throw err;
  }

  const adapter = getChannelAdapter("WHATSAPP", {
    whatsapp: { phoneNumberId, channelAccountId: (account as { id: string }).id, channelId: (channel as { id?: string }).id },
  });
  if (!(adapter instanceof WhatsAppChannelAdapter)) {
    throw new ChannelNotSupportedError("WHATSAPP");
  }
  const normalized = adapter.receiveMessage(payload).filter((m) =>
    (m.metadata as { phoneNumberId?: string } | undefined)?.phoneNumberId === phoneNumberId
  );
  if (normalized.length > 0) {
    await enqueueJob(db, {
      workspaceId,
      type: "process_channel_inbound",
      payload: {
        webhookEventId: webhookEvent.id,
        workspaceId,
        channelType: "WHATSAPP",
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
