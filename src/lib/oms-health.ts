/**
 * حالة ربط الـOMS للعرض: الخطأ بيظهر **بس إذا هو الأحدث**.
 *
 * ⚠️ كان السطر بيطلع «آخر خطأ: probe: OMS_AUTH_FAILED» حتى لو الاتصال نجح بعده بأيام (الخطأ بتاريخ 14 نوفمبر ونجاح
 * اتصال ومزامنة منتجات بنفس يوم الفحص). المالك ظن إنه التوكن مرفوض وقاعد يدوّر على توكن جديد، وهو سليم.
 * 🔧 `lastError` بيتخبّى لما `lastOkAt` أحدث من `lastErrorAt`.
 */
export interface OmsHealthFields {
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

function ms(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** الخطأ الحالي (الأحدث من آخر نجاح)، أو null لما الاتصال سليم. */
export function currentOmsError(h: OmsHealthFields): string | null {
  if (!h.lastError) return null;
  const errAt = ms(h.lastErrorAt);
  const okAt = ms(h.lastOkAt);
  // نجاح أحدث من الخطأ (أو بنفس اللحظة) = تعافى.
  if (errAt !== null && okAt !== null && okAt >= errAt) return null;
  return h.lastError;
}
