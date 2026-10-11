import { AppError, NotFoundError } from "@/core/errors";
import { decryptSecret } from "@/core/crypto";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { createOmsClient } from "./client";
import type { OmsApiVersion, OmsOrderPayload } from "./client";
import { revealRef } from "@/modules/integrations/attribution";
import { conversationRef } from "@/modules/integrations/format";

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
  // P12: وضع الترحيل اليدوي = لا نداء API (الـ OMS بلا باب استقبال بعد) —
  // الواجهة تعرض نص الإدخال الجاهز وربط رقم الـ OMS.
  if (conn.mode === "manual") {
    throw new AppError("OMS handoff is in manual mode — use the OMS intake text", 409, "OMS_MANUAL_MODE");
  }
  const apiVersion: OmsApiVersion = conn.apiVersion === "v1" ? "v1" : "legacy";
  const o = order as typeof order & {
    channel?: string | null;
    attributionMethod?: string | null;
    adId?: string | null;
    adSourceType?: string | null;
    ctwaClidEnc?: string | null;
    refCode?: string | null;
    refCodeAt?: Date | string | null;
    touchAt?: Date | string | null;
    pageRef?: string | null;
    psidEnc?: string | null;
    wabaId?: string | null;
  };
  const isoOrNull = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

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
    channel: o.channel ?? null,
    // P12: لقطة الإسناد (رقم الإعلان · رمز النقرة · رمز الكليبر) — الحساس
    // يُفك تشفيره هنا لحظة الإرسال فقط ولا يُسجَّل بأي مكان.
    attribution:
      apiVersion === "v1"
        ? {
            method: (o.attributionMethod as "AD" | "CODE" | "NONE" | null) ?? "NONE",
            adId: o.adId ?? null,
            adSourceType: o.adSourceType ?? null,
            ctwaClid: revealRef(o.ctwaClidEnc),
            refCode: o.refCode ?? null,
            refCodeAt: isoOrNull(o.refCodeAt),
            touchAt: isoOrNull(o.touchAt),
            pageId: o.pageRef ?? null,
            psid: revealRef(o.psidEnc),
            wabaId: o.wabaId ?? null,
            conversationRef: order.conversationId ? conversationRef(order.conversationId) : null,
          }
        : null,
  };

  const omsClient = createOmsClient({ baseUrl: conn.baseUrl, token: decryptSecret(conn.tokenEncrypted), apiVersion });
  // Ambiguous outcome (timeout/unreachable) → exactly one retry with the
  // SAME idempotencyKey. Definitive OMS answers are never retried.
  let result: { id: string; status: string; orderNumber?: string | null };
  try {
    try {
      result = await omsClient.createOrder(payload);
    } catch (err) {
      const code = err instanceof AppError ? err.code : "";
      if (code !== "OMS_TIMEOUT" && code !== "OMS_UNREACHABLE") throw err;
      result = await omsClient.createOrder(payload);
    }
  } catch (err) {
    // P12: آخر خطأ يظهر بصفحة الربط (رمز فقط — لا بيانات زبون ولا توكن).
    await (db as any).omsConnection
      ?.update?.({
        where: { workspaceId: ctx.workspaceId },
        data: { lastErrorAt: new Date(), lastError: `handoff: ${err instanceof AppError ? err.code : "ERROR"}` },
      })
      ?.catch?.(() => undefined);
    throw err;
  }

  await db.order.update({
    where: { id: order.id },
    data: {
      omsOrderId: result.id,
      omsStatus: result.status,
      handedOffAt: new Date(),
      handoffMode: "api",
      ...(result.orderNumber ? { omsOrderNumber: result.orderNumber } : {}),
    } as never,
  });
  await (db as any).omsConnection
    ?.update?.({ where: { workspaceId: ctx.workspaceId }, data: { lastOkAt: new Date() } })
    ?.catch?.(() => undefined);
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
