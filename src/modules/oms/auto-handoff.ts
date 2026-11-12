import { AppError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";
import { enqueueJob } from "@/modules/jobs/service";
import { recordAudit } from "@/modules/audit/service";
import { handoffOrderToOms } from "./handoff";

/**
 * ⚠️ مؤتمت: كل طلب مؤكد بالردود بينبعت للـ OMS لحاله (قرار المالك).
 * 🔧 بينطفى من «القنوات ← ربط الـ OMS»، وأي طلب بينبعت يدويًا من صفحته.
 *
 * ما بيجري جوّا إنشاء الطلب أبدًا: مهمة بمفتاح ثابت لكل طلب (لا إرسال
 * مزدوج)، بتعيد عند انقطاع الـ OMS بنفس مفتاح عدم التكرار عنده — وأي رفض
 * نهائي (زبون محظور · رقم ناقص · منتج مش بالـ OMS) ما بيتعاد.
 */

const log = childLogger("oms.auto-handoff");

export const AUTO_HANDOFF_ACTOR = "system:oms-auto-handoff";

/** 8 محاولات (30ث → 10د) ≈ نص ساعة، وبعدها الكنس الساعي لحد 3 أيام. */
export const OMS_HANDOFF_MAX_ATTEMPTS = 8;
export const OMS_HANDOFF_SWEEP_HOURS = 72;

/** مفتاح المهمة — فيه المساحة (قاعدة AGENTS.md). */
export function autoHandoffKey(workspaceId: string, orderId: string): string {
  return `oms-handoff:${workspaceId}:${orderId}`;
}

type ConnFlags = { isActive?: boolean; autoHandoff?: boolean } | null | undefined;

async function autoHandoffOn(db: Db, workspaceId: string): Promise<boolean> {
  const conn = (await (db as unknown as { omsConnection?: { findUnique: (a: unknown) => Promise<unknown> } }).omsConnection?.findUnique({
    where: { workspaceId },
  })) as ConnFlags;
  return Boolean(conn?.isActive && conn.autoHandoff);
}

export async function maybeEnqueueAutoHandoff(db: Db, workspaceId: string, orderId: string): Promise<boolean> {
  if (!(await autoHandoffOn(db, workspaceId))) return false;
  await enqueueJob(db, {
    workspaceId,
    type: "handoff_order_to_oms",
    payload: { orderId },
    idempotencyKey: autoHandoffKey(workspaceId, orderId),
    maxAttempts: OMS_HANDOFF_MAX_ATTEMPTS,
  });
  return true;
}

/** رموز رفض نهائي: الإعادة ما بتغيّر النتيجة. */
const FINAL_CODES = new Set([
  "ORDER_CUSTOMER_BLACKLISTED",
  "ORDER_NOT_CONFIRMED",
  "ORDER_CANCELLED",
  "ORDER_EMPTY",
  "ORDER_MISSING_NAME",
  "ORDER_MISSING_PHONE",
  "OMS_NOT_CONFIGURED",
  "OMS_URL_REJECTED",
  "OMS_REJECTED",
  "NOT_FOUND",
]);

export async function handleAutoHandoffJob(
  db: Db,
  payload: Record<string, unknown>,
  workspaceId: string
): Promise<{ success: boolean; error?: string }> {
  const orderId = String(payload.orderId ?? "");
  if (!orderId || !workspaceId) return { success: true };
  try {
    const res = await handoffOrderToOms(db, { userId: AUTO_HANDOFF_ACTOR, workspaceId }, orderId);
    log.info({ orderId, handedOff: res.handedOff }, "oms_auto_handoff_done");
    return { success: true };
  } catch (err) {
    const code = err instanceof AppError ? err.code : "ERROR";
    if (FINAL_CODES.has(code)) {
      log.warn({ orderId, code }, "oms_auto_handoff_final_refusal");
      // السبب (رسالة عربية بلا بيانات زبون) — صفحة الطلب بتبيّن ليش ما انبعت.
      await recordAudit(db, {
        workspaceId,
        userId: AUTO_HANDOFF_ACTOR,
        action: "oms.auto_handoff_refused",
        entityType: "Order",
        entityId: orderId,
        metadata: { code, reason: err instanceof Error ? err.message.slice(0, 160) : code },
      });
      return { success: true };
    }
    // انقطاع/خطأ عابر: المهمة بتعيد بنفس مفتاح عدم التكرار عند الـ OMS.
    return { success: false, error: code };
  }
}

/**
 * كنس ساعي: مهام إرسال استنفدت محاولاتها (الـ OMS كان واقف) ← مهمة جديدة
 * بنفس المفتاح، طالما الطلب ما انبعت وما انلغى. حد 3 أيام و50 طلب بالدورة.
 */
export async function sweepStuckOmsHandoffs(db: Db, now = new Date()): Promise<number> {
  const conns = ((await (db as unknown as { omsConnection?: { findMany: (a: unknown) => Promise<unknown> } }).omsConnection?.findMany({
    where: { isActive: true, autoHandoff: true },
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
    })) as Array<{ payload: unknown }>;
    const seen = new Set<string>();
    for (const job of failed) {
      const orderId = String((job.payload as { orderId?: unknown } | null)?.orderId ?? "");
      if (!orderId || seen.has(orderId)) continue;
      seen.add(orderId);
      const order = (await db.order.findUnique({ where: { id: orderId } })) as
        | { workspaceId: string; omsOrderId: string | null; status: string }
        | null;
      if (!order || order.workspaceId !== workspaceId || order.omsOrderId) continue;
      if (order.status === "CANCELLED" || order.status === "FAILED") continue;
      const res = await enqueueJob(db, {
        workspaceId,
        type: "handoff_order_to_oms",
        payload: { orderId },
        idempotencyKey: autoHandoffKey(workspaceId, orderId),
        maxAttempts: OMS_HANDOFF_MAX_ATTEMPTS,
      }).catch(() => null);
      if (res && !res.deduplicated) n += 1;
      if (n >= 50) return n;
    }
  }
  if (n > 0) log.info({ requeued: n }, "oms_handoff_sweep_requeued");
  return n;
}

/** مهمة مزامنة المنتجات الساعية — مفتاح بالمساحة والساعة. */
export function productSyncKey(workspaceId: string, now: Date): string {
  return `oms-sync:${workspaceId}:${now.toISOString().slice(0, 13)}`;
}

export async function enqueueHourlyProductSyncs(db: Db, now = new Date()): Promise<number> {
  const conns = ((await (db as unknown as { omsConnection?: { findMany: (a: unknown) => Promise<unknown> } }).omsConnection?.findMany({
    where: { isActive: true },
    select: { workspaceId: true },
  })) ?? []) as Array<{ workspaceId: string }>;
  let n = 0;
  for (const { workspaceId } of conns) {
    await enqueueJob(db, {
      workspaceId,
      type: "sync_oms_products",
      payload: {},
      idempotencyKey: productSyncKey(workspaceId, now),
      maxAttempts: 2,
    })
      .then(() => {
        n += 1;
      })
      .catch((err) => log.warn({ err, workspaceId }, "oms_sync_enqueue_failed"));
  }
  return n;
}

export async function handleProductSyncJob(db: Db, workspaceId: string): Promise<{ success: boolean; error?: string }> {
  if (!workspaceId) return { success: true };
  const { syncProductsFromOms } = await import("./sync");
  try {
    const r = await syncProductsFromOms(db, { userId: "system:oms-sync", workspaceId });
    log.info({ workspaceId, ...r, errors: undefined }, "oms_products_synced");
    return { success: true };
  } catch (err) {
    const code = err instanceof AppError ? err.code : "ERROR";
    // اتصال مطفي/ناقص = ولا إعادة؛ انقطاع = إعادة وحدة والساعة الجاية بتكمّل.
    if (code === "OMS_NOT_CONFIGURED" || code === "OMS_URL_REJECTED") return { success: true };
    return { success: false, error: code };
  }
}

export interface AutoHandoffState {
  state: "queued" | "retrying" | "failed" | "refused" | "done";
  attempts: number;
  lastError: string | null;
}

/** آخر مهمة إرسال للطلب (لصفحة الطلب) — null = ما في مهمة. */
export async function autoHandoffState(db: Db, workspaceId: string, orderId: string, handedOff: boolean): Promise<AutoHandoffState | null> {
  const job = (await db.backgroundJob.findFirst({
    where: { workspaceId, type: "handoff_order_to_oms", idempotencyKey: autoHandoffKey(workspaceId, orderId) } as never,
    orderBy: { createdAt: "desc" },
  })) as { status: string; attempts: number; lastError: string | null } | null;
  if (!job) return null;
  let state: AutoHandoffState["state"] =
    job.status === "DONE" ? "done" : job.status === "FAILED" ? "failed" : job.attempts > 0 && job.lastError ? "retrying" : "queued";
  let lastError = job.lastError ? String(job.lastError).slice(0, 120) : null;
  if (state === "done" && !handedOff) {
    state = "refused";
    const audit = (await (db as unknown as { auditLog?: { findFirst: (a: unknown) => Promise<unknown> } }).auditLog
      ?.findFirst({ where: { workspaceId, entityId: orderId, action: "oms.auto_handoff_refused" }, orderBy: { createdAt: "desc" } })
      .catch(() => null)) as { metadata?: { reason?: string; code?: string } } | null | undefined;
    lastError = audit?.metadata?.reason ?? audit?.metadata?.code ?? lastError;
  }
  return { state, attempts: job.attempts, lastError };
}
