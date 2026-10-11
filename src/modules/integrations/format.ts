import crypto from "node:crypto";
import { timezoneOffsetMinutes } from "@/core/analytics/time";

/**
 * P12 — أشكال القيم الموحّدة بعقود المنظومة:
 * المبالغ نص عشري بخانتين · التواريخ ISO 8601 بإزاحة المنطقة · مراجع معتمة
 * بدل المعرّفات الداخلية والأسماء (الفريق والمحادثات بمراجع).
 */

/** "20.00" — من رقم أو Decimal أو نص؛ null إذا غير صالح (لا صفر مخترع). */
export function decimalString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(n)) return null;
  // تقريب بالسنتات لتفادي 0.1+0.2.
  const cents = Math.round(n * 100);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** ISO 8601 بإزاحة منطقة مساحة العمل: 2026-10-10T14:30:00+03:00 */
export function isoInZone(date: Date, timezone: string | null | undefined): string {
  const tz = timezone || "UTC";
  const offset = timezoneOffsetMinutes(tz, date);
  const shifted = new Date(date.getTime() + offset * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = shifted.getUTCFullYear();
  const mo = pad(shifted.getUTCMonth() + 1);
  const d = pad(shifted.getUTCDate());
  const h = pad(shifted.getUTCHours());
  const mi = pad(shifted.getUTCMinutes());
  const s = pad(shifted.getUTCSeconds());
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** تاريخ اليوم (YYYY-MM-DD) بمنطقة مساحة العمل. */
export function dateInZone(date: Date, timezone: string | null | undefined): string {
  return isoInZone(date, timezone).slice(0, 10);
}

/**
 * هاش قصير بحروف فقط (a–p بدل 0–f): مرجع فيه سلسلة أرقام طويلة ممكن
 * يمسكه حارس البيانات الشخصية (عندنا أو عند الجسر/الكليبر) كأنه رقم هاتف
 * ويمنع الحدث كله — الحروف تشيل الاحتمال من أساسه.
 */
function shortHash(input: string, len = 12): string {
  const hex = crypto.createHash("sha256").update(input).digest("hex").slice(0, len);
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

/**
 * مرجع محادثة معتم وثابت (cv_…): الأنظمة الأخرى تشير للمحادثة بلا معرّفها
 * الداخلي — ثابت لنفس المحادثة فلا يكسر إزالة التكرار عند المستقبِل.
 */
export function conversationRef(conversationId: string): string {
  return `cv_${shortHash(`conversation:${conversationId}`)}`;
}

/** مرجع موظف معتم (agt_…) — «الفريق بمراجع» بلا اسم. */
export function agentRef(userId: string): string {
  return `agt_${shortHash(`agent:${userId}`, 10)}`;
}

/** القنوات بأسماء العقود — قائمة ثابتة (مخططات الأدوات حرفية بمفاتيحها). */
export const CHANNEL_KEYS = ["whatsapp", "messenger", "instagram", "telegram", "tiktok", "web"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

/** خريطة عدّ لكل قناة بكل المفاتيح (الصفر صفر حقيقي: ما في رسائل منتظرة عليها). */
export function fullChannelCounts(map: Record<string, number>): Record<ChannelKey, number> {
  const out = {} as Record<ChannelKey, number>;
  for (const k of CHANNEL_KEYS) out[k] = Math.max(0, Math.trunc(map[k] ?? 0));
  return out;
}

/** القنوات بأسماء العقود (حروف صغيرة). */
export function channelKey(channelType: string | null | undefined): string {
  switch ((channelType ?? "").toUpperCase()) {
    case "WHATSAPP":
      return "whatsapp";
    case "FACEBOOK":
      return "messenger";
    case "INSTAGRAM":
      return "instagram";
    case "TELEGRAM":
      return "telegram";
    case "TIKTOK":
      return "tiktok";
    default:
      return "web";
  }
}
