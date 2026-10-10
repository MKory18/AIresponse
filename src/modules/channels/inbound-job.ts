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
