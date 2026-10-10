import { AppError, NotFoundError } from "@/core/errors";
import { decryptSecret } from "@/core/crypto";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { createOmsClient } from "./client";
import type { OmsOrderPayload } from "./client";

/**
 * Hands a CONFIRMED local order to the OMS. Idempotent at two layers:
 * the local idempotencyKey is sent as the OMS dedupe key, and the local
 * order stores omsOrderId — a sequential retry never creates a second OMS
 * order. Concurrent same-order handoffs rely on the OMS honoring
 * idempotencyKey (contract requirement — proven payload-identical in tests).
 *
 * P2: blacklisted customers are refused before any OMS call; ambiguous
 * outcomes (timeout/unreachable — the OMS may have accepted) retry ONCE
 * with the SAME idempotencyKey. Definitive answers are never retried.
 * After handoff the local order is read-only reference (OMS owns it).
 */
export async function handoffOrderToOms(
  db: Db,
  ctx: ActorContext,
  orderId: string
): Promise<{ omsOrderId: string; handedOff: boolean }> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order || order.workspaceId !== ctx.workspaceId) throw new NotFoundError("Order");

  // Already handed off → idempotent success.
  if (order.omsOrderId) return { omsOrderId: order.omsOrderId, handedOff: false };

  if (order.confirmationStatus !== "CONFIRMED_BY_CUSTOMER" && order.confirmationStatus !== "CONFIRMED_BY_AGENT") {
    throw new AppError("Only confirmed orders are handed off to the OMS", 422, "ORDER_NOT_CONFIRMED");
  }

  const customer = await db.customer.findUnique({ where: { id: order.customerId } });
  if (!customer) throw new NotFoundError("Customer");

  // OMS blacklist wins: never hand off service for a blocked customer.
  if ((customer as { isBlacklisted?: boolean }).isBlacklisted === true) {
    await recordAudit(db, {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: "oms.handoff_blacklisted_blocked",
      entityType: "Order",
      entityId: order.id,
      metadata: { customerId: customer.id },
    });
    throw new AppError("Customer is blacklisted — OMS handoff refused", 422, "ORDER_CUSTOMER_BLACKLISTED");
  }

  const conn = await (db as any).omsConnection?.findUnique?.({ where: { workspaceId: ctx.workspaceId } });
  if (!conn || !conn.isActive) {
    throw new AppError("OMS connection not configured", 422, "OMS_NOT_CONFIGURED");
  }

  const payload: OmsOrderPayload = {
    idempotencyKey: order.idempotencyKey ?? `order:${order.id}`,
    orderNumber: order.orderNumber,
    customer: {
      name: customer.name ?? "",
      phone: customer.phone ?? "",
      address: order.deliveryAddress ?? "",
      province: order.province ?? "",
    },
    items: order.items.map((item) => ({
      sku: item.skuSnapshot,
      name: item.productNameSnapshot,
      unitPrice: Number(item.unitPrice),
      quantity: item.quantity,
      subtotal: Number(item.subtotal),
    })),
    totals: {
      subtotal: Number(order.subtotal),
      discount: Number(order.discount),
      deliveryFee: Number(order.deliveryFee),
      total: Number(order.total),
      currency: order.currency,
    },
    adSource: order.adSource ?? null,
    notes: order.notes ?? null,
    conversationId: order.conversationId ?? null,
  };

  const omsClient = createOmsClient({ baseUrl: conn.baseUrl, token: decryptSecret(conn.tokenEncrypted) });
  // Ambiguous outcome (timeout/unreachable) → exactly one retry with the
  // SAME idempotencyKey. Definitive OMS answers are never retried.
  let result: { id: string; status: string };
  try {
    result = await omsClient.createOrder(payload);
  } catch (err) {
    const code = err instanceof AppError ? err.code : "";
    if (code !== "OMS_TIMEOUT" && code !== "OMS_UNREACHABLE") throw err;
    result = await omsClient.createOrder(payload);
  }

  await db.order.update({
    where: { id: order.id },
    data: { omsOrderId: result.id, omsStatus: result.status, handedOffAt: new Date() },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "oms.order_handed_off",
    entityType: "Order",
    entityId: order.id,
    metadata: { omsOrderId: result.id, orderNumber: order.orderNumber },
  });
  await eventBus.publish(
    makeEvent("OrderStateChanged", ctx.workspaceId, { orderId: order.id, type: "OrderHandedOffToOms", omsOrderId: result.id })
  );
  return { omsOrderId: result.id, handedOff: true };
}
