import crypto from "node:crypto";
import { timingSafeEqual } from "@/core/crypto";

/**
 * Telegram Bot API normalizer (P5-C). Updates arrive either via webhook
 * (verified by the X-Telegram-Bot-Api-Secret-Token header — exact match,
 * NOT HMAC: Telegram sends the secret we registered) or long polling
 * (dev tool only, never the production path).
 */

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string; is_bot?: boolean };
    chat: { id: number; type: string; title?: string };
    date: number;
    text?: string;
    photo?: { file_id: string }[];
    document?: { file_id: string };
    caption?: string;
  };
}

export interface NormalizedTelegramMessage {
  updateId: number;
  externalCustomerId: string;
  externalConversationId: string;
  externalMessageId: string;
  externalEventId: string;
  senderName?: string | null;
  text: string | null;
  mediaType: "TEXT" | "IMAGE" | "FILE";
  mediaFileId?: string | null;
  timestamp: Date;
}

/**
 * Webhook verification: exact (timing-safe) match of the registered secret.
 * Empty/missing secrets refuse everything — unverified webhooks are never
 * processed in production.
 */
export function verifyTelegramWebhook(secretHeader: string | null, registeredSecret: string | null | undefined): boolean {
  if (!registeredSecret || !secretHeader) return false;
  return timingSafeEqual(secretHeader, registeredSecret);
}

export function normalizeTelegramUpdate(payload: TelegramUpdate): NormalizedTelegramMessage | null {
  const msg = payload.message;
  if (!msg || !msg.from || !msg.chat) return null;
  // Ignore our own echoes and other bots (loop prevention at the edge).
  if (msg.from.is_bot) return null;
  const hasText = typeof msg.text === "string" && msg.text.length > 0;
  const photo = msg.photo?.[msg.photo.length - 1]?.file_id ?? null;
  const doc = msg.document?.file_id ?? null;
  if (!hasText && !photo && !doc) return null;
  // Identity: private chats use the user id; groups use chat id (documented
  // Bot API addressing — a group thread is one conversation here).
  const peerId = msg.chat.type === "private" ? String(msg.from.id) : `group:${msg.chat.id}`;
  return {
    updateId: payload.update_id,
    externalCustomerId: peerId,
    externalConversationId: peerId,
    externalMessageId: `tg:${msg.chat.id}:${msg.message_id}`,
    externalEventId: `tg:update:${payload.update_id}`,
    senderName: msg.from.first_name ?? msg.from.username ?? null,
    text: hasText ? (msg.text as string) : (msg.caption ?? null),
    mediaType: photo ? "IMAGE" : doc ? "FILE" : "TEXT",
    mediaFileId: photo ?? doc,
    timestamp: new Date((msg.date || 0) * 1000),
  };
}

/** Deterministic idempotency key (update_id is provider-sequenced). */
export function deriveTelegramEventId(payload: { update_id?: number }): string {
  if (typeof payload.update_id === "number") return `tg:update:${payload.update_id}`;
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `tg:hash:${hash.slice(0, 32)}`;
}
