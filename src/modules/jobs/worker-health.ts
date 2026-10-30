/**
 * المرحلة ٣ (تشغيلي) — تقييم صحة العامل من نبضته المحفوظة.
 * دالة نقية قابلة للاختبار: لا تعرف قاعدة البيانات ولا الوقت إلا عبر المعاملات.
 */

export const DEFAULT_WORKER_STALE_MS = 120_000;

export interface WorkerHealth {
  status: "APP_HEALTHY" | "WORKER_STALE" | "WORKER_UNKNOWN";
  /** عمر آخر نبضة بالمللي — `null` إذا ما في نبضة أبدًا. */
  ageMs: number | null;
  lastCycleAt: string | null;
}

/**
 * - لا نبضة إطلاقًا → `WORKER_UNKNOWN` (ما منقدر نأكّد ولا ننفي).
 * - آخر نبضة أقدم من العتبة → `WORKER_STALE` (العامل متوقف).
 * - غير هيك → `APP_HEALTHY`.
 */
export function evaluateWorkerHealth(
  lastCycleAt: Date | null,
  now: number = Date.now(),
  staleMs: number = DEFAULT_WORKER_STALE_MS
): WorkerHealth {
  if (!lastCycleAt) return { status: "WORKER_UNKNOWN", ageMs: null, lastCycleAt: null };
  const ageMs = Math.max(0, now - new Date(lastCycleAt).getTime());
  return {
    status: ageMs > staleMs ? "WORKER_STALE" : "APP_HEALTHY",
    ageMs,
    lastCycleAt: new Date(lastCycleAt).toISOString(),
  };
}
