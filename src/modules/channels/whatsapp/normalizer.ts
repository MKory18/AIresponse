import crypto from "node:crypto";
import { timingSafeEqual } from "@/core/crypto";

/**
 * WhatsApp Cloud API normalizer (P5-D). Webhook object is
 * "whatsapp_business_account"; entries carry changes[] with field
 * "messages": value { messaging_product, metadata{phone_number_id},
 * messages[] {from,id,timestamp,type,text/image/...}, statuses[] }.
 * Statuses (sent/delivered/read) are transport signals, not inbound content.
 */

export interface WhatsAppInboundMessage {
  from: string;
  waMessageId: string;
  phoneNumberId: string;
  text: string | null;
  mediaType: "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT";
  mediaUrl?: string | null;
  /**
   * واتساب ما بيبعت رابط للوسائط الواردة — بيبعت معرّف لازم ينحمّل بتوكن
   * القناة (Cloud API: image/video/audio/document = {id, mime_type, sha256}).
   * منخزنه هون حتى مهمة التحميل تجيبه بعدين وتحوّله لرابط عندنا.
   */
  media?: {
    id: string;
    mimeType: string | null;
    filename: string | null;
    caption: string | null;
    voice: boolean;
  } | null;
  timestamp: Date;
  rawEventId: string;
  /**
   * P12 — إحالة إعلان «انقر للمراسلة» (Click-to-WhatsApp) من أول رسالة:
   * source_id = رقم الإعلان · ctwa_clid = رمز النقرة (للتحويلات فقط) ·
   * wabaId = حساب واتساب للأعمال (entry.id).
   */
  referral?: {
    source: "wa_referral";
    adId: string | null;
    adSourceType: string | null;
    ctwaClid: string | null;
    wabaId: string | null;
  } | null;
}

/** Same app-secret HMAC scheme as the Meta family. */
export function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return timingSafeEqual(signatureHeader.slice(7), expected);
}

/** شكل كائن الوسيط بالـ Cloud API: `link` للصادر، `id` للوارد. */
interface WhatsAppMediaObject {
  id?: string;
  link?: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
  voice?: boolean;
}

function mediaKind(type: string | undefined): WhatsAppInboundMessage["mediaType"] {
  switch (type) {
    case "image": return "IMAGE";
    case "video": return "VIDEO";
    case "audio":
    case "voice": return "AUDIO";
    case "document": return "DOCUMENT";
    default: return "TEXT";
  }
}

export function normalizeWhatsAppWebhook(payload: unknown, rawEventId: string): WhatsAppInboundMessage[] {
  const out: WhatsAppInboundMessage[] = [];
  const entries = (payload as { entry?: { id?: string; changes?: { field?: string; value?: Record<string, unknown> }[] }[] }).entry ?? [];
  for (const entry of entries) {
    const wabaId = typeof entry.id === "string" && entry.id ? entry.id : null;
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = (change.value ?? {}) as {
        metadata?: { phone_number_id?: string };
        messages?: {
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          image?: WhatsAppMediaObject;
          video?: WhatsAppMediaObject;
          audio?: WhatsAppMediaObject;
          document?: WhatsAppMediaObject;
          sticker?: WhatsAppMediaObject;
          referral?: { source_id?: string; source_type?: string; ctwa_clid?: string; source_url?: string };
        }[];
      };
      const phoneNumberId = value.metadata?.phone_number_id ?? "";
      for (const m of value.messages ?? []) {
        if (!m.from || !m.id) continue;
        const kind = mediaKind(m.type);
        const obj = m.image ?? m.video ?? m.audio ?? m.document ?? m.sticker ?? null;
        const mediaUrl = obj?.link ?? null;
        out.push({
          from: m.from,
          waMessageId: m.id,
          phoneNumberId,
          text: m.text?.body ?? null,
          mediaType: kind,
          mediaUrl,
          ...(obj?.id
            ? {
                media: {
                  id: String(obj.id).slice(0, 256),
                  mimeType: obj.mime_type ? String(obj.mime_type).slice(0, 128) : null,
                  filename: obj.filename ? String(obj.filename).slice(0, 256) : null,
                  caption: obj.caption ? String(obj.caption).slice(0, 1024) : null,
                  voice: obj.voice === true,
                },
              }
            : {}),
          timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
          rawEventId,
          ...(m.referral && (m.referral.source_id || m.referral.ctwa_clid)
            ? {
                referral: {
                  source: "wa_referral" as const,
                  adId: m.referral.source_id ? String(m.referral.source_id).slice(0, 64) : null,
                  adSourceType: m.referral.source_type ? String(m.referral.source_type).slice(0, 16) : null,
                  ctwaClid: m.referral.ctwa_clid ? String(m.referral.ctwa_clid).slice(0, 512) : null,
                  wabaId,
                },
              }
            : {}),
        });
      }
    }
  }
  return out;
}

/** Deterministic idempotency key (wamid per message). */
export function deriveWhatsAppEventId(payload: unknown): string {
  const ids: string[] = [];
  const entries = (payload as { entry?: { changes?: { value?: { messages?: { id?: string }[] } }[] }[] }).entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        if (m.id) ids.push(m.id);
      }
    }
  }
  if (ids.length > 0) return `wa:${ids.sort().join("|")}`;
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `wa:hash:${hash.slice(0, 32)}`;
}
