import crypto from "node:crypto";
import { timingSafeEqual } from "@/core/crypto";
import { normalizeMetaReferral, type MetaReferral } from "../facebook/normalizer";
import type { FacebookReferral } from "../facebook/types";

/**
 * Instagram Messaging normalizer (P5-B). Webhook object is "instagram";
 * entries carry the IGID, messaging items mirror Messenger shapes with
 * IGSID customer ids and echo flags. Comments arrive on a separate
 * feed-like object and are handled by the comments module, not here.
 */

interface InstagramPayload {
  object?: string;
  entry?: {
    id?: string;
    time?: number;
    messaging?: {
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      // P12 — إحالة إعلان إنستغرام أو رابط ig.me برمز.
      referral?: MetaReferral;
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

export interface NormalizedInstagramMessage {
  externalCustomerId: string;
  externalConversationId: string;
  externalMessageId: string;
  externalEventId: string;
  text: string | null;
  mediaType: "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "FILE";
  mediaUrl?: string | null;
  timestamp: Date;
  rawEventId: string;
  /** P12 — الإحالة (رقم إعلان إنستغرام · ref رابط ig.me) إن وُجدت. */
  referral?: FacebookReferral | null;
}

/** Same app-secret HMAC scheme as the Messenger family (Meta). */
export function verifyInstagramSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return timingSafeEqual(signatureHeader.slice(7), expected);
}

function mediaKind(t: string | undefined): NormalizedInstagramMessage["mediaType"] {
  switch (t) {
    case "image": return "IMAGE";
    case "video": return "VIDEO";
    case "audio": return "AUDIO";
    case "file": return "FILE";
    default: return "TEXT";
  }
}

export function normalizeInstagramWebhook(
  payload: InstagramPayload,
  rawEventId: string
): NormalizedInstagramMessage[] {
  const out: NormalizedInstagramMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const msg = event.message;
      if (!msg || msg.is_echo || msg.is_deleted || !msg.mid || !event.sender?.id) continue;
      const first = (msg.attachments ?? [])[0];
      const referral = normalizeMetaReferral(event.referral ?? msg.referral, entry.id ?? null, "ig");
      out.push({
        ...(referral ? { referral } : {}),
        externalCustomerId: event.sender.id,
        externalConversationId: event.sender.id,
        externalMessageId: msg.mid,
        externalEventId: `${rawEventId}:${msg.mid}`,
        text: msg.text ?? null,
        mediaType: mediaKind(first?.type),
        mediaUrl: first?.payload?.url ?? null,
        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
        rawEventId,
      });
    }
  }
  return out;
}

/** Deterministic idempotency key for a webhook payload. */
export function deriveInstagramEventId(payload: unknown): string {
  const p = payload as InstagramPayload;
  const mids: string[] = [];
  for (const entry of p.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      if (m.message?.mid) mids.push(m.message.mid);
    }
  }
  if (mids.length > 0) return `ig:${mids.sort().join("|")}`;
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `ig:hash:${hash.slice(0, 32)}`;
}
