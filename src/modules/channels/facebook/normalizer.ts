import crypto from "node:crypto";
import { getEnv } from "@/core/env";
import { timingSafeEqual } from "@/core/crypto";
import type { NormalizedAttachment, NormalizedInboundMessage } from "./types";

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

interface MetaWebhookPayload {
  object?: string;
  entry?: {
    id?: string;
    time?: number;
    messaging?: {
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      message?: {
        mid?: string;
        text?: string;
        is_echo?: boolean;
        is_deleted?: boolean;
        attachments?: { type?: string; payload?: { url?: string } }[];
      };
    }[];
  }[];
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
        externalEventId: rawEventId,
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
