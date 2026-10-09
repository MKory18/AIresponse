import { NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { Db } from "@/modules/customers/service";
import { canTransitionOrder } from "@/modules/orders/state-machine";
import type { OrderStatus } from "@prisma/client";

/**
 * OMS → engine webhook: order-status-changed.
 * The local order is read-only reference after handoff; we mirror the OMS
 * status (never contradict it) and drive post-shipping follow-ups from here.
 */

const OMS_STATUS_TO_LOCAL: Record<string, OrderStatus> = {
  PROCESSING: "PROCESSING",
  SHIPPED: "OUT_FOR_DELIVERY",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
  RETURNED: "RETURNED",
};

export interface OmsStatusWebhook {
  event: "order-status-changed";
  workspaceId: string;
  omsOrderId: string;
  status: string;
  shipmentStatus?: string | null;
  note?: string | null;
}

export async function handleOmsStatusChanged(db: Db, payload: OmsStatusWebhook) {
  const order = await db.order.findUnique({ where: { omsOrderId: payload.omsOrderId } });
  if (!order || order.workspaceId !== payload.workspaceId) throw new NotFoundError("Order");

  const localStatus = OMS_STATUS_TO_LOCAL[payload.status];
  const applied = Boolean(localStatus && canTransitionOrder(order.status, localStatus));
  const data: Record<string, unknown> = { omsStatus: payload.status };
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
  return { orderId: order.id, appliedLocalStatus: applied ? localStatus : null };
}
