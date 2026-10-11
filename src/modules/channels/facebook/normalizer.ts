import crypto from "node:crypto";
import { getEnv } from "@/core/env";
import { timingSafeEqual } from "@/core/crypto";
import type { FacebookReferral, FacebookReferralSignal, NormalizedAttachment, NormalizedInboundMessage } from "./types";

/** X-Hub-Signature-256 verification: HMAC-SHA256 + constant-time compare. */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return timingSafeEqual(signatureHeader.slice(7), expected);
}

/** Webhook subscription verification (GET challenge). */
export function verifyWebhookChallenge(params: URLSearchParams): { ok: true; challenge: string } | { ok: false } {
  const env = getEnv();
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  const expected = env.META_WEBHOOK_VERIFY_TOKEN;
  if (mode === "subscribe" && token && expected && challenge && timingSafeEqual(token, expected)) {
    return { ok: true, challenge };
  }
  return { ok: false };
}

export interface MetaWebhookPayload {
  object?: string;
  entry?: {
    id?: string;
    time?: number;
    messaging?: {
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      // P8 — بيانات إحالة موثوقة (messaging_referrals / postback ref).
      referral?: MetaReferral;
      postback?: { ref?: string; payload?: string; referral?: MetaReferral };
      message?: {
        mid?: string;
        text?: string;
        is_echo?: boolean;
        is_deleted?: boolean;
        attachments?: { type?: string; payload?: { url?: string } }[];
        referral?: MetaReferral;
      };
    }[];
  }[];
}

/** P12 — شكل إحالة Meta (ad_id لإعلان «انقر للمراسلة» · ref لروابط m.me/ig.me). */
export interface MetaReferral {
  ref?: string;
  source?: string;
  type?: string;
  ad_id?: string;
}

/**
 * P12 — تطبيع إحالة Meta: رقم الإعلان مصدر موثوق (ADS)، وref بلا إعلان =
 * رابط برمز (SHORTLINK…). لا تخمين: بلا ad_id ولا ref = لا إحالة.
 */
export function normalizeMetaReferral(r: MetaReferral | undefined | null, pageId: string | null, family: "fb" | "ig"): FacebookReferral | null {
  if (!r) return null;
  const adId = typeof r.ad_id === "string" && r.ad_id.trim() ? r.ad_id.trim().slice(0, 64) : null;
  const ref = typeof r.ref === "string" && r.ref.trim() ? r.ref.trim().slice(0, 128) : null;
  if (adId) return { source: family === "fb" ? "fb_referral" : "ig_referral", adId, adSourceType: "ad", ref, pageId };
  if (ref) return { source: family === "fb" ? "fb_ref_link" : "ig_ref_link", adId: null, adSourceType: null, ref, pageId };
  return null;
}

function attachmentType(t: string | undefined): NormalizedAttachment["type"] | null {
  switch (t) {
    case "image": return "IMAGE";
    case "video": return "VIDEO";
    case "audio": return "AUDIO";
    case "file": return "FILE";
    case "location": return "LOCATION";
    case "fallback": return "FALLBACK";
    default: return null;
  }
}

/**
 * Normalizes a verified Meta webhook payload for one connected Page into
 * internal inbound messages. Echoes, reads, deliveries and non-message events
 * are ignored here. Meta payload details never escape this module.
 */
export function normalizeFacebookWebhook(
  payload: MetaWebhookPayload,
  channelAccountId: string,
  pageId: string,
  rawEventId: string
): NormalizedInboundMessage[] {
  const out: NormalizedInboundMessage[] = [];
  for (const entry of payload.entry ?? []) {
    if (entry.id !== pageId) continue; // safety: entry must belong to this Page
    for (const event of entry.messaging ?? []) {
      const msg = event.message;
      if (!msg || msg.is_echo || msg.is_deleted || !msg.mid || !event.sender?.id) continue;
      const attachments: NormalizedAttachment[] = (msg.attachments ?? [])
        .map((a): NormalizedAttachment | null => {
          const type = attachmentType(a.type);
          return type ? { type, url: a.payload?.url } : null;
        })
        .filter((a): a is NormalizedAttachment => a !== null);
      out.push({
        channelType: "FACEBOOK",
        channelAccountId,
        externalCustomerId: event.sender.id,
        externalConversationId: event.sender.id, // Messenger: conversation == PSID per Page
        externalMessageId: msg.mid,
        // P8 — بيانات إحالة موثوقة فقط: ref صريح من Meta يُمرر كما هو،
        // وغيابه يعني "غير معروف" (لا تخمين من نص الرسالة أبدًا).
        adRef: event.referral?.ref ?? event.postback?.ref ?? null,
        // P12 — الإحالة كاملة (رقم الإعلان + ref) من الحدث أو الرسالة أو الـ postback.
        referral: normalizeMetaReferral(event.referral ?? msg.referral ?? event.postback?.referral, pageId, "fb"),
        // Per-MESSAGE delivery identity: Meta batches multiple messages from
        // the same customer in one POST, so the POST-scoped rawEventId MUST
        // NOT be reused here — processIncomingMessage dedupes on
        // (conversationId, externalEventId), and a shared key silently drops
        // every message after the first. Scoping by mid keeps redeliveries
        // (same mid → same key) deduplicated while distinct messages stay
        // distinct. rawEventId is preserved below for POST-level tracing.
        externalEventId: `${rawEventId}:${msg.mid}`,
        text: msg.text ?? null,
        attachments,
        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
        provider: "facebook",
        rawEventId,
      });
    }
  }
  return out;
}

/**
 * P12 — إحالات بلا رسالة (messaging_referrals لمحادثة قائمة: الزبون كبس
 * إعلانًا أو رابط رمز وما كتب بعد). تُسجّل لمسة إسناد فقط — لا رسالة ولا رد.
 */
export function extractFacebookReferralSignals(payload: MetaWebhookPayload, pageId: string, rawEventId: string): FacebookReferralSignal[] {
  const out: FacebookReferralSignal[] = [];
  for (const entry of payload.entry ?? []) {
    if (entry.id !== pageId) continue;
    for (const event of entry.messaging ?? []) {
      if (event.message || !event.sender?.id) continue;
      const referral = normalizeMetaReferral(event.referral ?? event.postback?.referral, pageId, "fb");
      if (!referral) continue;
      const ts = event.timestamp ?? 0;
      out.push({
        psid: event.sender.id,
        referral,
        timestamp: ts ? new Date(ts) : new Date(),
        eventKey: `${rawEventId}:ref:${event.sender.id}:${ts}`,
      });
    }
  }
  return out;
}

/** Deterministic idempotency key for a webhook payload. */
export function deriveEventId(payload: unknown): string {
  const p = payload as MetaWebhookPayload;
  const mids: string[] = [];
  for (const entry of p.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      if (m.message?.mid) mids.push(m.message.mid);
    }
  }
  if (mids.length > 0) return `fb:${mids.sort().join("|")}`;
  // Fallback: stable content hash (identical redeliveries dedupe).
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `fb:hash:${hash.slice(0, 32)}`;
}
