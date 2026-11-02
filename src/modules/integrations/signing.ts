import crypto from "node:crypto";

/**
 * P12 — توقيع أحداث المنظومة والتحقق منها.
 *
 * القاعدة الموحّدة (عقود الكليبر وسيستم 1 وجسر Hermes):
 *   X-Zaki-Timestamp  = وقت الإرسال (ثواني يونكس)
 *   X-Zaki-Signature  = hex( HMAC-SHA256( secret, "<timestamp>.<raw body>" ) )
 *   أقدم من 5 دقايق = رفض · event_id مكرر = نجاح بلا معالجة تانية.
 *
 * والـ OMS الحقيقي (src/lib/apps/events.ts بريبو الـ OMS) يوقّع بنفس الصيغة
 * لكن الوقت بالميلي ثانية والتوقيع مسبوق بـ "sha256=". المتحقق هنا يقبل
 * الشكلين بلا أي تخفيف للأمان: الـ HMAC يُحسب دائمًا على نص الرأس كما
 * وصل حرفيًا (لا يُعاد تنسيقه)، والمقارنة ثابتة الزمن.
 */

export const SIGNATURE_TOLERANCE_SEC = 5 * 60;

/** التوقيع الصادر من سيستم 7 (hex بلا بادئة — حرفيًا كما بالعقود). */
export function signZakiPayload(secret: string, timestamp: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/** ثواني يونكس كنص — الشكل الذي نرسله في X-Zaki-Timestamp. */
export function unixSeconds(now: Date = new Date()): string {
  return String(Math.floor(now.getTime() / 1000));
}

export type SignatureFailure = "MISSING_HEADERS" | "BAD_TIMESTAMP" | "STALE_TIMESTAMP" | "BAD_SIGNATURE";

export interface VerifyInput {
  secret: string;
  timestampHeader: string | null | undefined;
  signatureHeader: string | null | undefined;
  rawBody: string;
  now?: Date;
  toleranceSec?: number;
}

/** يقرأ الوقت بالثواني أو بالميلي ثانية (أي رقم فوق 10^12 = ميلي ثانية). */
export function parseZakiTimestamp(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{9,14}$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n >= 1e12 ? Math.floor(n / 1000) : n;
}

function constantTimeHexEqual(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase(), "utf8");
  const y = Buffer.from(b.toLowerCase(), "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export function verifyZakiSignature(input: VerifyInput): { ok: true; timestampSec: number } | { ok: false; reason: SignatureFailure } {
  const ts = input.timestampHeader?.trim();
  const sig = input.signatureHeader?.trim();
  if (!ts || !sig || !input.secret) return { ok: false, reason: "MISSING_HEADERS" };
  const tsSec = parseZakiTimestamp(ts);
  if (tsSec === null) return { ok: false, reason: "BAD_TIMESTAMP" };
  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const tolerance = input.toleranceSec ?? SIGNATURE_TOLERANCE_SEC;
  if (Math.abs(nowSec - tsSec) > tolerance) return { ok: false, reason: "STALE_TIMESTAMP" };
  const provided = sig.startsWith("sha256=") ? sig.slice(7) : sig;
  if (!/^[0-9a-fA-F]{64}$/.test(provided)) return { ok: false, reason: "BAD_SIGNATURE" };
  const expected = signZakiPayload(input.secret, ts, input.rawBody);
  if (!constantTimeHexEqual(expected, provided)) return { ok: false, reason: "BAD_SIGNATURE" };
  return { ok: true, timestampSec: tsSec };
}

/** معرّف حدث صادر: evt_rep_ + 20 حرف عشوائي (فريد ومعتم). */
export function newEventId(): string {
  return `evt_rep_${crypto.randomBytes(10).toString("hex")}`;
}

/** معرّف طلب: rep_ + 16 حرف — يرجع بالرد وبكل سجل. */
export function newRequestId(): string {
  return `rep_${crypto.randomBytes(8).toString("hex")}`;
}

/** سر توقيع جديد قوي — يُولّد على الخادم ويُعرض مرة واحدة. */
export function newSigningSecret(): string {
  return `zrs_${crypto.randomBytes(32).toString("hex")}`;
}
