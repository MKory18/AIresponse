import { decryptSecret, encryptSecret } from "@/core/crypto";

/**
 * OCR-2026-10-16 (متوسط): أسرار القنوات ما كانت تُخزّن مشفّرة وسكونًا
 * (tgWebhookSecret / ttWebhookSecret كمفتاح صريح داخل metadata-JSON).
 * الكتابة الآن مشفّرة دائمًا (AES-256-GCM نفسه الذي يحرس توكنات
 * القنوات)، والقراءة متسامحة مع الصفوف النصية القديمة — الصف الجديد
 * مشفّر، والقديم يعمل حتى داخل نفس التوكن (فشل صامت: التشفير الفاسد
 * ما بيرجع للقيمة القديمة).
 */

/** خزّن السر مشفّرًا — تعادة مو ثانية نصيًا في الـ metadata. */
export function storeChannelSecret(secret: string): string {
  return encryptSecret(secret);
}

/**
 * اقرأ سرّ قناة: المفتاح المشفّر أولاً؛ الصف القديم (plain) يبقى يعمل لحد
 * أنيق أن قديم لا يصير. التشفير الفاسد = بلا تراجع - فشل واضح.
 */
export function readChannelSecret(
  metadata: Record<string, unknown> | null | undefined,
  encKey: string,
  legacyKey: string
): string | null {
  if (!metadata) return null;
  const enc = metadata[encKey];
  if (typeof enc === "string" && enc.length > 0) {
    try {
      return decryptSecret(enc);
    } catch {
      return null;
    }
  }
  const legacy = metadata[legacyKey];
  return typeof legacy === "string" && legacy.length > 0 ? legacy : null;
}
