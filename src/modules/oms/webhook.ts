import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { Db } from "@/modules/customers/service";
import { canReachOrderStatus, canTransitionOrder } from "@/modules/orders/state-machine";
import type { OrderStatus } from "@prisma/client";

/**
 * OMS → engine webhook: order-status-changed.
 * The local order is read-only reference after handoff; we mirror the OMS
 * status (never contradict it) and drive post-shipping follow-ups from here.
 *
 * P2 hardening:
 * - The workspace is DERIVED from the order row (lookup by omsOrderId) —
 *   never trusted from the payload. Signature verification (route level)
 *   uses that workspace's connection.
 * - Replay protection: `eventId` (when the OMS provides one) dedupes via
 *   WebhookEvent(source=oms); otherwise a derived
 *   `omsOrderId:status:occurredAt` key gives convergent at-most-once
 *   processing (reprocessing the same status is a harmless no-op).
 * - Ordering: optional `occurredAt` is compared against `omsStatusAt`; stale
 *   (out-of-order) events are recorded and skipped, never regressing state.
 * - Unknown OMS statuses are stored as mirror only (no local transition).
 */
export interface OmsStatusWebhook {
  event: "order-status-changed";
  /** Untrusted hint only — routing always uses the order row. */
  workspaceId?: string;
  omsOrderId: string;
  status: string;
  shipmentStatus?: string | null;
  note?: string | null;
  /** OMS-side event identity (contract SHOULD always send it). */
  eventId?: string | null;
  /** OMS-side event time (ISO) for ordering. */
  occurredAt?: string | null;
}

export interface OmsStatusResult {
  orderId: string;
  appliedLocalStatus: OrderStatus | null;
  duplicate: boolean;
  stale: boolean;
}

const OMS_STATUS_TO_LOCAL: Record<string, OrderStatus> = {
  PROCESSING: "PROCESSING",
  // P12 — أسماء آلة حالات الـ OMS الحقيقية (13 مرحلة) حيث يطابقها معنى محلي.
  READY_FOR_SHIPPING: "PROCESSING",
  REJECTED: "CANCELLED",
  SHIPPED: "OUT_FOR_DELIVERY",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
  RETURNED: "RETURNED",
};

export async function handleOmsStatusChanged(db: Db, payload: OmsStatusWebhook): Promise<OmsStatusResult> {
  const order = await db.order.findUnique({ where: { omsOrderId: payload.omsOrderId } });
  if (!order || !order.workspaceId) throw new NotFoundError("Order");

  // Replay guard FIRST (before any state change or side effect).
  const dedupeKey = payload.eventId?.trim()
    ? `evt:${payload.eventId.trim()}`
    : `stat:${payload.omsOrderId}:${payload.status}:${payload.occurredAt ?? ""}`;
  try {
    await (db as any).webhookEvent.create({
      data: {
        workspaceId: order.workspaceId,
        channelType: "OMS",
        externalEventId: dedupeKey,
        source: "oms",
        payload: { omsOrderId: payload.omsOrderId, status: payload.status },
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      return { orderId: order.id, appliedLocalStatus: null, duplicate: true, stale: false };
    }
    throw err;
  }

  // Ordering guard: stale events are recorded, never applied.
  let eventTime: Date | null = null;
  if (payload.occurredAt) {
    const parsed = new Date(payload.occurredAt);
    if (!Number.isNaN(parsed.getTime())) eventTime = parsed;
  }
  const row = order as { omsStatusAt?: Date | string | null };
  // Tolerant parse: real drivers return Date; JSON-cloned doubles (tests)
  // may surface ISO strings. Either way we compare epoch millis.
  const lastAppliedAt = row.omsStatusAt ? new Date(row.omsStatusAt).getTime() : NaN;
  // حدث بنفس اللحظة تمامًا: بمعرّف تسليم مميّز (أحداث التطبيقات) هو حدث تاني
  // مش إعادة — الإعادة بتنمسك بمفتاح التكرار فوق. بلا معرّف: نفس السلوك القديم.
  const sameInstantIsStale = !payload.eventId?.trim();
  if (
    eventTime &&
    Number.isFinite(lastAppliedAt) &&
    (eventTime.getTime() < lastAppliedAt || (sameInstantIsStale && eventTime.getTime() === lastAppliedAt))
  ) {
    await recordAudit(db, {
      workspaceId: order.workspaceId,
      action: "oms.status_stale_skipped",
      entityType: "Order",
      entityId: order.id,
      metadata: { omsStatus: payload.status, eventId: payload.eventId ?? null },
    });
    return { orderId: order.id, appliedLocalStatus: null, duplicate: false, stale: true };
  }

  let localStatus = OMS_STATUS_TO_LOCAL[payload.status];
  // P12: الـ OMS بيلغي طلب بعد الشحن (رفض استلام مثلًا) — محليًا ما في
  // «ملغى» بعد «بالتوصيل»؛ أقرب معنى صحيح: التوصيل ما تم (FAILED)، والمرآة
  // omsStatus بتضل CANCELLED كما قال الـ OMS.
  if (localStatus === "CANCELLED" && order.status === "OUT_FOR_DELIVERY") localStatus = "FAILED";
  // P12: الـ OMS الحقيقي يقفز (مؤكد ← مشحون ← مُسلَّم) — المرآة تتقدم للأمام عبر
  // مسار صالح، ولا ترجع للخلف أبدًا.
  const applied = Boolean(
    localStatus && (canTransitionOrder(order.status, localStatus) || canReachOrderStatus(order.status, localStatus))
  );
  const data: Record<string, unknown> = { omsStatus: payload.status, omsStatusAt: eventTime ?? new Date() };
  if (applied) {
    data.status = localStatus;
  }

  await db.order.update({ where: { id: order.id }, data });
  await recordAudit(db, {
    workspaceId: order.workspaceId,
    action: "oms.status_changed",
    entityType: "Order",
    entityId: order.id,
    metadata: { omsStatus: payload.status, localStatus: localStatus ?? null, note: payload.note ?? null },
  });
  await eventBus.publish(
    makeEvent("ConversationUpdated", order.workspaceId, {
      type: "OmsStatusChanged",
      orderId: order.id,
      omsOrderId: payload.omsOrderId,
      omsStatus: payload.status,
      localStatus: localStatus ?? null,
    })
  );

  // Post-shipping follow-up hook: the automation engine listens on the bus.
  return { orderId: order.id, appliedLocalStatus: applied ? localStatus : null, duplicate: false, stale: false };
}

/** Thrown when the payload's workspace hint contradicts the order row. */
export class OmsWorkspaceMismatchError extends AppError {
  constructor() {
    super("OMS event workspace mismatch", 404, "OMS_WORKSPACE_MISMATCH");
  }
}
