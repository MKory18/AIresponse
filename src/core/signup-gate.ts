/**
 * بوابة التسجيل (S-06).
 *
 * التسجيل المفتوح للعموم وإنشاء مساحات جديدة مسكّرين افتراضيًا بالإنتاج.
 * بالتطوير والاختبار مفتوحين. المتغيّر الصريح بيغلب: `true|1|yes` ← مفتوح،
 * `false|0|no` ← مسكّر، وأي قيمة غيرهم ← مسكّر (فشل مغلق).
 * بتنقرا من `process.env` مباشرة (مش من كاش `getEnv`) لأنها بتتغيّر بين
 * نشر ونشر بلا إعادة بناء.
 */

function flag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return process.env.NODE_ENV !== "production";
  return ["1", "true", "yes"].includes(raw);
}

/** هل `POST /api/auth/register` وصفحة `/register` شغّالين؟ */
export function isSignupAllowed(): boolean {
  return flag("ALLOW_SIGNUP");
}

/**
 * هل «دعوة حساب مسجل» شغّالة؟ (4.2) — مطفية افتراضيًا بكل البيئات: الدعوة بلا شاشة قبول
 * ومبدّل مساحات، فالطريق الوحيد هو «إنشاء حساب جديد». صريح فقط: `1|true|yes`.
 */
export function isMemberInviteAllowed(): boolean {
  const raw = process.env.ALLOW_MEMBER_INVITES?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** هل `POST /api/workspaces` (مساحة إضافية لمستخدم موجود) شغّال؟ */
export function isWorkspaceCreateAllowed(): boolean {
  return flag("ALLOW_WORKSPACE_CREATE");
}
