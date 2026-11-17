import type { OrderStatus } from "@prisma/client";
import { AppError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import { recordAudit } from "@/modules/audit/service";
import { publishRealtime } from "@/modules/realtime/events";
import { enqueueJob, type Db } from "@/modules/jobs/service";
import { canReachOrderStatus } from "@/modules/orders/state-machine";

const log = childLogger("oms.status-sync");

/**
 * مزامنة حالة الطلب من الـ OMS (الحزمة 1.7، §10.4) — استطلاع.
 *
 * أحداث الـ OMS الراجعة ما بتوصل اليوم، فبنسأل `getOrder` لكل طلب انبعت وحالته مش نهائية:
 * كل 10 دقايق أول ساعتين بعد الإرسال، بعدها كل ساعة، لحد 14 يوم. بتتحفظ `omsStatus` ·
 * `omsShippingStatus` · `omsCheckedAt`، والحالة المحلية بتتقدّم **للأمام بس** (`canReachOrderStatus`).
 * فشل الـ OMS (واقع · توكن غلط) ما بيغيّر ولا شي: بتنعاد بالدورة الجاية.
 */
export const OMS_FINAL_LOCAL: ReadonlySet<string> = new Set(["DELIVERED", "RETURNED", "CANCELLED", "FAILED"]);
export const OMS_POLL_MAX_DAYS = 14;
export const OMS_POLL_FAST_MS = 10 * 60_000;
export const OMS_POLL_SLOW_MS = 60 * 60_000;
export const OMS_POLL_FAST_WINDOW_MS = 2 * 3600_000;
export const OMS_STATUS_BATCH = 40;

const up = (v: unknown) => String(v ?? "").trim().toUpperCase();

/** حالة الـ OMS ← حالة الردود المحلية (null = ما في تغيير). */
export function mapOmsToLocal(oms: { status?: string | null; shippingStatus?: string | null }): OrderStatus | null {
  const shipping = up(oms.shippingStatus);
  const status = up(oms.status);
  if (shipping === "DELIVERED" || status === "DELIVERED") return "DELIVERED";
  if (shipping === "RETURNED" || status === "RETURNED") return "RETURNED";
  if (["SHIPPED", "OUT_FOR_DELIVERY", "IN_TRANSIT"].includes(shipping) || ["SHIPPED", "OUT_FOR_DELIVERY"].includes(status)) return "OUT_FOR_DELIVERY";
  if (["REJECTED", "CANCELLED", "CANCELED"].includes(status)) return "CANCELLED";
  if (status === "CONFIRMED") return "PROCESSING";
  return null;
}

const STATUS_AR: Record<string, string> = {
  NEW: "جديد",
  IN_PROGRESS: "قيد المتابعة",
  CONFIRMED: "مؤكد",
  REJECTED: "مرفوض",
  CANCELLED: "ملغى",
  CANCELED: "ملغى",
  NO_ANSWER: "ما رد",
  FOLLOW_UP_REQUIRED: "بحاجة متابعة",
  POSTPONED: "مؤجّل",
  DELIVERED: "تم التسليم",
  RETURNED: "مرتجع",
};
const SHIPPING_AR: Record<string, string> = {
  NOT_READY: "قيد التجهيز",
  READY: "جاهز للشحن",
  SHIPPED: "مشحون",
  IN_TRANSIT: "بالطريق",
  OUT_FOR_DELIVERY: "بالتوصيل",
  DELIVERED: "تم التسليم",
  RETURNED: "مرتجع",
};

/** «مؤكد · مشحون» — لبرومبت الرد («طلبات العميل الأخيرة») وللموظف. فاضي = ما في معلومة. */
export function omsStatusLabel(status?: string | null, shipping?: string | null): string {
  const parts: string[] = [];
  if (status) parts.push(STATUS_AR[up(status)] ?? String(status));
  if (shipping && up(shipping) !== "NOT_READY") parts.push(SHIPPING_AR[up(shipping)] ?? String(shipping));
  return parts.join(" · ");
}

export interface PollableOrder {
  status: string;
  omsOrderId?: string | null;
  handedOffAt?: Date | string | null;
  createdAt: Date | string;
  omsCheckedAt?: Date | string | null;
}

/** هل الطلب مستحق للاستطلاع هلأ؟ (نهائي ← لأ · أكبر من 14 يوم ← لأ · الدورية حسب عمر الإرسال). */
export function isDueForPoll(order: PollableOrder, now: Date): boolean {
  if (!order.omsOrderId || OMS_FINAL_LOCAL.has(order.status)) return false;
  const since = new Date(order.handedOffAt ?? order.createdAt).getTime();
  const age = now.getTime() - since;
  if (age > OMS_POLL_MAX_DAYS * 24 * 3600_000) return false;
  if (!order.omsCheckedAt) return true;
  const every = age <= OMS_POLL_FAST_WINDOW_MS ? OMS_POLL_FAST_MS : OMS_POLL_SLOW_MS;
  return now.getTime() - new Date(order.omsCheckedAt).getTime() >= every;
}

export function statusSyncKey(workspaceId: string, now: Date): string {
  return `oms-status:${workspaceId}:${Math.floor(now.getTime() / OMS_POLL_FAST_MS)}`;
}

/** من المجدول كل 10 دقايق: مهمة لكل مساحة ربطها فعّال (مفتاح بالمساحة والدورة). */
export async function enqueueOmsStatusSyncs(db: Db, now = new Date()): Promise<number> {
  const conns = ((await (db as unknown as { omsConnection?: { findMany: (a: unknown) => Promise<unknown> } }).omsConnection?.findMany({
    where: { isActive: true },
    select: { workspaceId: true },
  })) ?? []) as Array<{ workspaceId: string }>;
  let n = 0;
  for (const { workspaceId } of conns) {
    await enqueueJob(db, { workspaceId, type: "sync_oms_order_status", payload: {}, idempotencyKey: statusSyncKey(workspaceId, now), maxAttempts: 1 })
      .then((r) => {
        if (!r.deduplicated) n += 1;
      })
      .catch((err) => log.warn({ err, workspaceId }, "oms_status_enqueue_failed"));
  }
  return n;
}

export interface StatusSyncResult {
  checked: number;
  updated: number;
  advanced: number;
  failed: number;
  aborted: boolean;
}

type M = Record<string, Record<string, (a: unknown) => Promise<unknown>>>;

export async function syncOmsOrderStatuses(db: Db, workspaceId: string, now = new Date(), limit = OMS_STATUS_BATCH): Promise<StatusSyncResult> {
  const result: StatusSyncResult = { checked: 0, updated: 0, advanced: 0, failed: 0, aborted: false };
  const d = db as unknown as M;
  const cutoff = new Date(now.getTime() - OMS_POLL_MAX_DAYS * 24 * 3600_000);
  const candidates = (await d.order.findMany({
    where: { workspaceId, omsOrderId: { not: null }, status: { notIn: [...OMS_FINAL_LOCAL] }, createdAt: { gte: cutoff } },
    orderBy: { createdAt: "desc" },
    take: 500,
  })) as Array<PollableOrder & { id: string; omsOrderId: string }>;
  const due = candidates
    .filter((o) => isDueForPoll(o, now))
    .sort((a, b) => (a.omsCheckedAt ? new Date(a.omsCheckedAt).getTime() : 0) - (b.omsCheckedAt ? new Date(b.omsCheckedAt).getTime() : 0))
    .slice(0, limit);
  if (due.length === 0) return result;

  const { buildOmsClient, noteOmsError, noteOmsOk } = await import("./connection");
  let client;
  try {
    client = await buildOmsClient(db as never, workspaceId);
  } catch {
    result.aborted = true; // ربط ناقص/مطفي: ولا شي نعمله
    return result;
  }

  for (const order of due) {
    let remote: Awaited<ReturnType<typeof client.getOrder>>;
    try {
      remote = await client.getOrder(order.omsOrderId);
    } catch (err) {
      result.failed += 1;
      const code = err instanceof AppError ? err.code : "ERROR";
      // انقطاع/توكن غلط: وقّف الدفعة (ما منضرب سيرفر واقع)؛ رفض لطلب واحد (404): كمّل.
      if (code !== "OMS_REJECTED") {
        await noteOmsError(db as never, workspaceId, code);
        result.aborted = true;
        break;
      }
      continue;
    }
    result.checked += 1;
    const data: Record<string, unknown> = { omsStatus: remote.status || null, omsShippingStatus: remote.shippingStatus, omsCheckedAt: now };
    const mapped = mapOmsToLocal(remote);
    let advanced = false;
    if (mapped && mapped !== order.status && canReachOrderStatus(order.status as OrderStatus, mapped)) {
      data.status = mapped;
      data.omsStatusAt = now;
      advanced = true;
    }
    await d.order.update({ where: { id: order.id }, data });
    result.updated += 1;
    if (advanced) {
      result.advanced += 1;
      await recordAudit(db as never, {
        workspaceId,
        action: "order.oms_status_synced",
        entityType: "Order",
        entityId: order.id,
        metadata: { from: order.status, to: mapped, omsStatus: remote.status, shipping: remote.shippingStatus },
      }).catch(() => undefined);
      void publishRealtime(db as never, { workspaceId, type: "order.updated", entityId: order.id });
    }
  }
  if (result.checked > 0) await noteOmsOk(db as never, workspaceId).catch(() => undefined);
  if (result.advanced > 0 || result.failed > 0) log.info({ workspaceId, ...result }, "oms_status_synced");
  return result;
}

export async function handleOmsStatusSyncJob(db: Db, workspaceId: string): Promise<{ success: boolean; error?: string }> {
  if (!workspaceId) return { success: true };
  try {
    await syncOmsOrderStatuses(db, workspaceId);
  } catch (err) {
    log.warn({ workspaceId, error: err instanceof Error ? err.message : String(err) }, "oms_status_job_failed");
  }
  // دايمًا نجاح: الدورة الجاية (10 دقايق) هي الإعادة.
  return { success: true };
}
