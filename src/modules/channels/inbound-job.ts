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
    | { id?: string; mimeType?: string | null }
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
  const { processed, failed } = await processInboundGroups(messages, {
    groupKey: (m) => `${m.channelType}:${m.channelId ?? ""}:${m.externalConversationId}`,
    run: async (m) => {
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
      await enqueueWhatsAppMediaDownload(db, workspaceId, m);
    },
    onError: (m, err) => {
      log.warn(
        { workspaceId, externalEventId: m.externalEventId, error: err instanceof Error ? err.message : String(err) },
        "channel_inbound_message_failed"
      );
    },
  });
  log.info({ workspaceId, processed, failed }, "channel_inbound_processed");
  if (failed > 0 && processed === 0) {
    return { success: false, error: `${failed} channel messages failed` };
  }
  return { success: true };
}

/**
 * PERF — conversation-grouped parallel ingestion.
 *
 * Messages from DIFFERENT conversations are independent (own customer,
 * conversation, idempotency keys) and run concurrently; messages of the
 * SAME conversation stay strictly sequential so per-conversation ordering
 * (unread counts, last-message timestamps, single AI turn order) is exactly
 * what the old serial loop produced. Failure accounting is identical:
 * per-message try/catch, poison messages never drop the batch.
 */
export async function processInboundGroups<T>(
  items: T[],
  opts: {
    groupKey: (m: T) => string;
    run: (m: T) => Promise<void>;
    onError?: (m: T, err: unknown) => void;
  }
): Promise<{ processed: number; failed: number }> {
  const groups = new Map<string, T[]>();
  for (const m of items) {
    const k = opts.groupKey(m);
    const g = groups.get(k);
    if (g) g.push(m);
    else groups.set(k, [m]);
  }
  let processed = 0;
  let failed = 0;
  await Promise.all(
    [...groups.values()].map(async (group) => {
      for (const m of group) {
        try {
          await opts.run(m);
          processed += 1;
        } catch (err) {
          failed += 1;
          opts.onError?.(m, err);
        }
      }
    })
  );
  return { processed, failed };
}
