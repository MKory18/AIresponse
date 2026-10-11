import { AppError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";
import { enqueueJob } from "@/modules/jobs/service";
import { handoffOrderToOms } from "./handoff";

/**
 * P12 — الترحيل التلقائي للـ OMS بعد التأكيد (اختياري، بوضع api فقط).
 * لا يجري داخل إنشاء الطلب أبدًا: يُكتب كمهمة durable بمفتاح ثابت لكل طلب
 * (لا ترحيل مزدوج)، والمهمة تعيد المحاولة عند انقطاع الـ OMS بنفس مفتاح
 * عدم التكرار — وأي رفض نهائي (قائمة سوداء · وضع يدوي) لا يُعاد.
 */

const log = childLogger("oms.auto-handoff");

export const AUTO_HANDOFF_ACTOR = "system:oms-auto-handoff";

export async function maybeEnqueueAutoHandoff(db: Db, workspaceId: string, orderId: string): Promise<boolean> {
  const conn = (await (db as unknown as { omsConnection?: { findUnique: (a: unknown) => Promise<unknown> } }).omsConnection?.findUnique({
    where: { workspaceId },
  })) as { isActive?: boolean; mode?: string; autoHandoff?: boolean } | null | undefined;
  if (!conn || !conn.isActive || conn.mode === "manual" || !conn.autoHandoff) return false;
  await enqueueJob(db, {
    workspaceId,
    type: "handoff_order_to_oms",
    payload: { orderId },
    idempotencyKey: `oms-handoff:${orderId}`,
  });
  return true;
}

/** رموز رفض نهائي: إعادة المحاولة لن تغيّر النتيجة. */
const FINAL_CODES = new Set([
  "ORDER_CUSTOMER_BLACKLISTED",
  "ORDER_NOT_CONFIRMED",
  "OMS_MANUAL_MODE",
  "OMS_NOT_CONFIGURED",
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
      return { success: true };
    }
    // انقطاع/خطأ عابر: المهمة تُعاد (نفس مفتاح عدم التكرار عند الـ OMS).
    return { success: false, error: code };
  }
}
