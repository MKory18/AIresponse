import { AppError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";
import { enqueueJob } from "@/modules/jobs/service";
import { recordAudit } from "@/modules/audit/service";
import { handoffOrderToOms } from "./handoff";

/**
 * P12 — الترحيل التلقائي للـ OMS بعد التأكيد (اختياري، بوضع api فقط).
 * لا يجري داخل إنشاء الطلب أبدًا: يُكتب كمهمة durable بمفتاح ثابت لكل طلب
 * (لا ترحيل مزدوج)، والمهمة تعيد المحاولة عند انقطاع الـ OMS بنفس مفتاح
 * عدم التكرار — وأي رفض نهائي (قائمة سوداء · وضع يدوي) لا يُعاد.
 */

const log = childLogger("oms.auto-handoff");

export const AUTO_HANDOFF_ACTOR = "system:oms-auto-handoff";

/**
 * ميزانية الإعادة: 8 محاولات (30ث · 1د · 2د · 4د · 8د · 10د · 10د) ≈ 35 دقيقة —
 * إعادة تشغيل الـ OMS لدقايق ما بتضيّع طلب. بعدها الكنس الساعي بيعيدها
 * (sweepStuckOmsHandoffs) لحد 3 أيام، والطلب بيبيّن بالأحمر بصفحته وبطابور المالك.
 */
export const OMS_HANDOFF_MAX_ATTEMPTS = 8;
export const OMS_HANDOFF_SWEEP_HOURS = 72;

export function autoHandoffKey(orderId: string): string {
  return `oms-handoff:${orderId}`;
}

export async function maybeEnqueueAutoHandoff(db: Db, workspaceId: string, orderId: string): Promise<boolean> {
  const conn = (await (db as unknown as { omsConnection?: { findUnique: (a: unknown) => Promise<unknown> } }).omsConnection?.findUnique({
    where: { workspaceId },
  })) as { isActive?: boolean; mode?: string; autoHandoff?: boolean } | null | undefined;
  if (!conn || !conn.isActive || conn.mode === "manual" || !conn.autoHandoff) return false;
  await enqueueJob(db, {
    workspaceId,
    type: "handoff_order_to_oms",
    payload: { orderId },
    idempotencyKey: autoHandoffKey(orderId),
    maxAttempts: OMS_HANDOFF_MAX_ATTEMPTS,
  });
  return true;
}

type JobRow = { id: string; workspaceId: string; payload: unknown; status: string; finishedAt?: Date | string | null; lastError?: string | null };

/**
 * كنس ساعي: مهام ترحيل تلقائي استنفدت محاولاتها (الـ OMS كان واقف) ← مهمة
 * جديدة بنفس مفتاح عدم التكرار عند الـ OMS، طالما الطلب لسا ما انرحّل وما
 * انلغى والاتصال لسا api + تلقائي. حد 3 أيام و50 طلب بالدورة.
 */
export async function sweepStuckOmsHandoffs(db: Db, now = new Date()): Promise<number> {
  const conns = ((await (db as unknown as { omsConnection?: { findMany: (a: unknown) => Promise<unknown> } }).omsConnection?.findMany({
    where: { isActive: true, mode: "api", autoHandoff: true },
    select: { workspaceId: true },
  })) ?? []) as Array<{ workspaceId: string }>;
  let n = 0;
  for (const { workspaceId } of conns) {
    const failed = (await db.backgroundJob.findMany({
      where: {
        workspaceId,
        type: "handoff_order_to_oms",
        status: "FAILED",
        finishedAt: { gte: new Date(now.getTime() - OMS_HANDOFF_SWEEP_HOURS * 3600_000) },
      } as never,
      orderBy: { finishedAt: "desc" },
      take: 200,
    })) as JobRow[];
    const seen = new Set<string>();
    for (const job of failed) {
      const orderId = String((job.payload as { orderId?: unknown } | null)?.orderId ?? "");
      if (!orderId || seen.has(orderId)) continue;
      seen.add(orderId);
      const order = (await db.order.findUnique({ where: { id: orderId } })) as
        | { workspaceId: string; omsOrderId: string | null; status: string; confirmationStatus: string }
        | null;
      if (!order || order.workspaceId !== workspaceId || order.omsOrderId) continue;
      if (order.status === "CANCELLED" || order.status === "FAILED") continue;
      const res = await enqueueJob(db, {
        workspaceId,
        type: "handoff_order_to_oms",
        payload: { orderId },
        idempotencyKey: autoHandoffKey(orderId),
        maxAttempts: OMS_HANDOFF_MAX_ATTEMPTS,
      }).catch((err) => {
        log.warn({ err, orderId }, "oms_handoff_sweep_enqueue_failed");
        return null;
      });
      if (res && !res.deduplicated) n += 1;
      if (n >= 50) return n;
    }
  }
  if (n > 0) log.info({ requeued: n }, "oms_handoff_sweep_requeued");
  return n;
}

export interface AutoHandoffState {
  /** refused = رفض نهائي (قائمة سوداء · وضع يدوي …) — الإعادة ما بتفيد. */
  state: "queued" | "retrying" | "failed" | "refused" | "done";
  attempts: number;
  lastError: string | null;
  nextAt: string | null;
}

/** آخر مهمة ترحيل تلقائي للطلب (لصفحة الطلب) — null = ما في مهمة. */
export async function autoHandoffState(db: Db, workspaceId: string, orderId: string, handedOff: boolean): Promise<AutoHandoffState | null> {
  const job = (await db.backgroundJob.findFirst({
    where: { workspaceId, type: "handoff_order_to_oms", idempotencyKey: autoHandoffKey(orderId) } as never,
    orderBy: { createdAt: "desc" },
  })) as { status: string; attempts: number; lastError: string | null; runAfter: Date | string | null } | null;
  if (!job) return null;
  let state: AutoHandoffState["state"] =
    job.status === "DONE" ? "done" : job.status === "FAILED" ? "failed" : job.attempts > 0 && job.lastError ? "retrying" : "queued";
  let lastError = job.lastError ? String(job.lastError).slice(0, 80) : null;
  if (state === "done" && !handedOff) {
    // المهمة خلصت بلا ترحيل = رفض نهائي — سببه من السجل.
    state = "refused";
    const audit = (await (db as unknown as { auditLog?: { findFirst: (a: unknown) => Promise<unknown> } }).auditLog
      ?.findFirst({ where: { workspaceId, entityId: orderId, action: "oms.auto_handoff_refused" }, orderBy: { createdAt: "desc" } })
      .catch(() => null)) as { metadata?: { code?: string } } | null | undefined;
    lastError = audit?.metadata?.code ?? lastError;
  }
  return {
    state,
    attempts: job.attempts,
    lastError,
    nextAt: state === "retrying" && job.runAfter ? new Date(job.runAfter).toISOString() : null,
  };
}

/** رموز رفض نهائي: إعادة المحاولة لن تغيّر النتيجة. */
const FINAL_CODES = new Set([
  "ORDER_CUSTOMER_BLACKLISTED",
  "ORDER_NOT_CONFIRMED",
  "OMS_MANUAL_MODE",
  "OMS_NOT_CONFIGURED",
  // OCR-2026-10-16: رابط مرفوض (أمان/صيغة) ما بينصلح بإعادة — قرار مالك
  // بتعديل الإعداد، والدوران على المهمة كان ترسًا زائدًا بلا فايدة.
  "OMS_URL_REJECTED",
  "NOT_FOUND",
]);

export async function handleAutoHandoffJob(db: Db, payload: Record<string, unknown>, workspaceId: string): Promise<{ success: boolean; error?: string }> {
  const orderId = String(payload.orderId ?? "");
  if (!orderId) return { success: true };
  try {
    const res = await handoffOrderToOms(db, { userId: AUTO_HANDOFF_ACTOR, workspaceId }, orderId);
    log.info({ orderId, handedOff: res.handedOff }, "oms_auto_handoff_done");
    return { success: true };
  } catch (err) {
    const code = err instanceof AppError ? err.code : "ERROR";
    if (FINAL_CODES.has(code)) {
      log.warn({ orderId, code }, "oms_auto_handoff_final_refusal");
      // رمز فقط (بلا بيانات زبون) — صفحة الطلب بتبيّن ليش ما انرحّل.
      await recordAudit(db, {
        workspaceId,
        userId: AUTO_HANDOFF_ACTOR,
        action: "oms.auto_handoff_refused",
        entityType: "Order",
        entityId: orderId,
        metadata: { code },
      });
      return { success: true };
    }
    // انقطاع/خطأ عابر: المهمة تُعاد (نفس مفتاح عدم التكرار عند الـ OMS).
    return { success: false, error: code };
  }
}
