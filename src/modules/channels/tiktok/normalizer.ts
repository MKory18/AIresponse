import crypto from "node:crypto";
import { timingSafeEqual } from "@/core/crypto";

/**
 * TikTok Business Messaging normalizer (P5-E — LOCAL ONLY, assumptions
 * marked inline; live verification BLOCKED on account approval + regional
 * eligibility).
 *
 * ASSUMED event shape: { event, conversation_id, sender_id, sender_name?,
 * message_id, text?, timestamp? }. Anything else is ignored (never invented).
 */

export interface AssumedTikTokEvent {
  event?: string;
  conversation_id?: string;
  sender_id?: string;
  sender_name?: string;
  message_id?: string;
  text?: string;
  timestamp?: number;
}

export interface NormalizedTikTokMessage {
  externalCustomerId: string;
  externalConversationId: string;
  externalMessageId: string;
  externalEventId: string;
  senderName?: string | null;
  text: string | null;
  timestamp: Date;
}

/**
 * INTERIM verification (BLOCKED on official scheme docs): exact timing-safe
 * match of an operator-configured shared secret header. Documented as a
 * placeholder until TikTok's signing scheme is confirmed for our account.
 */
export function verifyTikTokWebhook(secretHeader: string | null, configuredSecret: string | null | undefined): boolean {
  if (!configuredSecret || !secretHeader) return false;
  return timingSafeEqual(secretHeader, configuredSecret);
}

export function normalizeTikTokEvent(payload: AssumedTikTokEvent): NormalizedTikTokMessage | null {
  if (!payload.conversation_id || !payload.sender_id || !payload.message_id) return null;
  if (typeof payload.text !== "string" || payload.text.length === 0) return null;
  return {
    externalCustomerId: payload.sender_id,
    externalConversationId: payload.conversation_id,
    externalMessageId: payload.message_id,
    externalEventId: `tt:${payload.conversation_id}:${payload.message_id}`,
    senderName: payload.sender_name ?? null,
    text: payload.text,
    timestamp: payload.timestamp ? new Date(payload.timestamp * 1000) : new Date(),
  };
}

/** Deterministic idempotency key for the assumed shape. */
export function deriveTikTokEventId(payload: AssumedTikTokEvent): string {
  if (payload.conversation_id && payload.message_id) {
    return `tt:${payload.conversation_id}:${payload.message_id}`;
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `tt:hash:${hash.slice(0, 32)}`;
}
