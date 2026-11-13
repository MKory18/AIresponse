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
    // رسائل زبون بلا نص: لازم توصل كمان، وإلا الزبون بيبعت صوتية وما بيجيه رد.
    voice?: { file_id?: string };
    audio?: { file_id?: string };
    video?: { file_id?: string };
    video_note?: { file_id?: string };
    animation?: { file_id?: string };
    sticker?: { file_id?: string; emoji?: string };
    location?: { latitude?: number; longitude?: number };
    contact?: { phone_number?: string };
    poll?: { question?: string };
    dice?: { emoji?: string };
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
  // صوتية · فيديو · ملصق · موقع · جهة اتصال: رسالة زبون زي غيرها — بتنسجّل
  // وبيطلعلها رد. اللي بينرمى بس: تحديث ما فيه ولا محتوى زبون (انضمام لمجموعة…).
  const otherFileId =
    msg.voice?.file_id ??
    msg.audio?.file_id ??
    msg.video?.file_id ??
    msg.video_note?.file_id ??
    msg.animation?.file_id ??
    msg.sticker?.file_id ??
    null;
  const hasOther =
    otherFileId !== null ||
    msg.location !== undefined ||
    msg.contact !== undefined ||
    msg.poll !== undefined ||
    msg.dice !== undefined ||
    (typeof msg.caption === "string" && msg.caption.length > 0);
  if (!hasText && !photo && !doc && !hasOther) return null;
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
    text: hasText ? (msg.text as string) : (msg.caption ?? msg.sticker?.emoji ?? null),
    mediaType: photo ? "IMAGE" : doc || otherFileId ? "FILE" : "TEXT",
    mediaFileId: photo ?? doc ?? otherFileId,
    timestamp: new Date((msg.date || 0) * 1000),
  };
}

/** Deterministic idempotency key (update_id is provider-sequenced). */
export function deriveTelegramEventId(payload: { update_id?: number }): string {
  if (typeof payload.update_id === "number") return `tg:update:${payload.update_id}`;
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `tg:hash:${hash.slice(0, 32)}`;
}
