import { childLogger } from "@/core/logger";
import type { NormalizedIncomingMessage } from "./types";
import type { Db } from "@/modules/customers/service";

const log = childLogger("jobs.channel-inbound");

/**
 * Shared channel-inbound job (P5): every non-Messenger channel enqueues
 * normalized messages here after provider verification + raw persistence.
 * Each message is processed idempotently via processIncomingMessage; the
 * batch fails if any message fails (full-batch retry is safe by
 * idempotency) — the same contract as the Facebook webhook-event job.
 */
/**
 * واتساب بس: الرسالة إجت بمعرّف وسيط بلا رابط — منصفّ مهمة تحميل بتوكن
 * القناة. مفتاح عدم التكرار فيه المساحة والـ wamid، فإعادة الحدث ما
 * بتنزّل الوسيط مرتين. فشل الصف ما بيوقف معالجة الرسالة نفسها.
 */
async function enqueueWhatsAppMediaDownload(
  db: Db,
  workspaceId: string,
  m: NormalizedIncomingMessage
): Promise<void> {
  if (m.channelType !== "WHATSAPP" || m.mediaUrl) return;
  const waMedia = (m.metadata ?? {})["waMedia"] as
    | { id?: string; mimeType?: string | null; filename?: string | null }
    | undefined;
  if (!waMedia?.id || !m.channelId) return;
  try {
    const { enqueueJob } = await import("@/modules/jobs/service");
    await enqueueJob(db, {
      workspaceId,
      type: "download_whatsapp_media",
      payload: {
        workspaceId,
        channelId: m.channelId,
        externalMessageId: m.externalMessageId,
        mediaId: waMedia.id,
        mimeType: waMedia.mimeType ?? null,
        filename: waMedia.filename ?? null,
      },
      idempotencyKey: `wa-media:${workspaceId}:${m.externalMessageId}`,
      // رابط ميتا مؤقت والمهمة ممكن تسبق حفظ الرسالة — ميزانية إعادة أوسع.
      maxAttempts: 8,
    });
  } catch (err) {
    log.warn(
      {
        workspaceId,
        externalMessageId: m.externalMessageId,
        error: err instanceof Error ? err.message : String(err),
      },
      "whatsapp_media_enqueue_failed"
    );
  }
}

export async function handleChannelInbound(
  db: Db,
  payload: Record<string, unknown>
): Promise<{ success: boolean; error?: string }> {
  const workspaceId = String(payload.workspaceId ?? "");
  const messages = (payload.messages as NormalizedIncomingMessage[]) ?? [];
  if (!workspaceId || messages.length === 0) {
    return { success: true };
  }
  const { processIncomingMessage } = await import("@/modules/conversations/service");
  let processed = 0;
  let failed = 0;
  for (const m of messages) {
    try {
      await processIncomingMessage(db, {
        workspaceId,
        channelType: m.channelType,
        channelId: m.channelId,
        externalUserId: m.externalUserId,
        externalUserName: m.externalUserName ?? null,
        externalConversationId: m.externalConversationId,
        externalMessageId: m.externalMessageId,
        externalEventId: m.externalEventId,
        provider: m.provider,
        type: m.type,
        text: m.text ?? null,
        mediaUrl: m.mediaUrl ?? null,
        metadata: m.metadata ?? {},
        sentAt: m.sentAt ? new Date(m.sentAt) : undefined,
      });
      processed += 1;
      await enqueueWhatsAppMediaDownload(db, workspaceId, m);
    } catch (err) {
      failed += 1;
      log.warn(
        { workspaceId, externalEventId: m.externalEventId, error: err instanceof Error ? err.message : String(err) },
        "channel_inbound_message_failed"
      );
    }
  }
  log.info({ workspaceId, processed, failed }, "channel_inbound_processed");
  if (failed > 0 && processed === 0) {
    return { success: false, error: `${failed} channel messages failed` };
  }
  return { success: true };
}
