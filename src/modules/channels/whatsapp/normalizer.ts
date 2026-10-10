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
  timestamp: Date;
  rawEventId: string;
}

/** Same app-secret HMAC scheme as the Meta family. */
export function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return timingSafeEqual(signatureHeader.slice(7), expected);
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
  const entries = (payload as { entry?: { changes?: { field?: string; value?: Record<string, unknown> }[] }[] }).entry ?? [];
  for (const entry of entries) {
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
          image?: { link?: string };
          video?: { link?: string };
          audio?: { link?: string; voice?: boolean };
          document?: { link?: string };
        }[];
      };
      const phoneNumberId = value.metadata?.phone_number_id ?? "";
      for (const m of value.messages ?? []) {
        if (!m.from || !m.id) continue;
        const kind = mediaKind(m.type);
        const mediaUrl =
          m.image?.link ?? m.video?.link ?? m.audio?.link ?? m.document?.link ?? null;
        out.push({
          from: m.from,
          waMessageId: m.id,
          phoneNumberId,
          text: m.text?.body ?? null,
          mediaType: kind,
          mediaUrl,
          timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
          rawEventId,
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
