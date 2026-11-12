import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { revealRef } from "@/modules/integrations/attribution";
import { conversationRef } from "@/modules/integrations/format";
import type { OmsCreatedOrder, OmsOrderPayload } from "./client";
import { buildOmsClient, noteOmsError, noteOmsOk } from "./connection";

/**
 * بيبعت طلب مؤكد من الردود للـ OMS عبر `POST /api/v1/orders`.
 *
 * ما بيتكرر بطبقتين: الطلب عندنا بيحفظ `omsOrderId` (إعادة = نجاح بلا نداء)،
 * والـ OMS بيمنع التكرار على `Idempotency-Key` ثابت لكل طلب — فإعادة بعد
 * مهلة غامضة (يمكن الـ OMS استلم) بترجع نفس الطلب، مش نسخة تانية.
 *
 * السعر: الـ OMS بيعيد التسعير من كتالوجه (هو مصدر الحقيقة). إذا طلع غير
 * سعرنا (`price_adjusted`) بينحفظ بالسجل وبيبيّن بصفحة الطلب.
 */

/** مفتاح عدم التكرار عند الـ OMS — فيه المساحة (قاعدة AGENTS.md). */
export function omsIdempotencyKey(workspaceId: string, orderId: string): string {
  return `replies:${workspaceId}:${orderId}`;
}

type OrderRow = {
  id: string;
  workspaceId: string;
  orderNumber: string;
  customerId: string;
  conversationId: string | null;
  status: string;
  confirmationStatus: string;
  omsOrderId: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress: string | null;
  province: string | null;
  notes: string | null;
  subtotal: unknown;
  discount: unknown;
  deliveryFee: unknown;
  total: unknown;
  currency: string;
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
  items: Array<{ skuSnapshot: string; productNameSnapshot: string; unitPrice: unknown; quantity: number; subtotal: unknown }>;
};

const isoOrNull = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

export interface OmsHandoffResult {
  omsOrderId: string;
  omsOrderNumber: string | null;
  handedOff: boolean;
  priceAdjusted: boolean;
}

export async function handoffOrderToOms(db: Db, ctx: ActorContext, orderId: string): Promise<OmsHandoffResult> {
  const order = (await db.order.findUnique({ where: { id: orderId }, include: { items: true } })) as OrderRow | null;
  if (!order || order.workspaceId !== ctx.workspaceId) throw new NotFoundError("Order");

  // انبعت قبل = نجاح بلا نداء.
  if (order.omsOrderId) {
    const row = order as OrderRow & { omsOrderNumber?: string | null };
    return { omsOrderId: order.omsOrderId, omsOrderNumber: row.omsOrderNumber ?? null, handedOff: false, priceAdjusted: false };
  }
  if (order.status === "CANCELLED" || order.status === "FAILED" || order.confirmationStatus === "DECLINED") {
    throw new AppError("الطلب ملغي — ما بينبعت للـ OMS", 422, "ORDER_CANCELLED");
  }
  if (order.confirmationStatus !== "CONFIRMED_BY_CUSTOMER" && order.confirmationStatus !== "CONFIRMED_BY_AGENT") {
    throw new AppError("بس الطلب المؤكد بينبعت للـ OMS", 422, "ORDER_NOT_CONFIRMED");
  }
  if (!order.items.length) throw new AppError("الطلب بلا منتجات", 422, "ORDER_EMPTY");

  const customer = (await db.customer.findUnique({ where: { id: order.customerId } })) as
    | { name?: string | null; phone?: string | null; isBlacklisted?: boolean }
    | null;
  if (!customer) throw new NotFoundError("Customer");
  if (customer.isBlacklisted === true) {
    throw new AppError("الزبون محظور — ما انبعت الطلب", 422, "ORDER_CUSTOMER_BLACKLISTED");
  }
  const name = (order.recipientName ?? customer.name ?? "").trim();
  const phone = (order.recipientPhone ?? customer.phone ?? "").trim();
  // نفس حدود الباب (`v1OrderSchema`): بلاها الـ OMS بيرفض بـ 422 بلا فايدة من الإعادة.
  if (name.length < 2) throw new AppError("اسم الزبون ناقص — كمّله بصفحة الطلب", 422, "ORDER_MISSING_NAME");
  if (phone.length < 7) throw new AppError("رقم الزبون ناقص — كمّله بصفحة الطلب", 422, "ORDER_MISSING_PHONE");

  const client = await buildOmsClient(db, ctx.workspaceId);
  const payload: OmsOrderPayload = {
    idempotencyKey: omsIdempotencyKey(ctx.workspaceId, order.id),
    orderNumber: order.orderNumber,
    channel: order.channel ?? null,
    customer: {
      name: name.slice(0, 80),
      phone: phone.slice(0, 20),
      city: order.province?.trim().slice(0, 60) || null,
      address: order.deliveryAddress?.trim().slice(0, 200) || null,
    },
    items: order.items.map((i) => ({
      code: i.skuSnapshot,
      name: i.productNameSnapshot,
      quantity: i.quantity,
      unitPrice: Number(i.unitPrice),
      lineTotal: Number(i.subtotal),
    })),
    totals: {
      subtotal: Number(order.subtotal),
      discount: Number(order.discount),
      deliveryFee: Number(order.deliveryFee),
      total: Number(order.total),
      currency: order.currency,
    },
    notes: order.notes?.slice(0, 500) ?? null,
    // الحساس (رمز النقرة · معرّف الزبون بالصفحة) بينفك تشفيره هون لحظة الإرسال بس.
    attribution: {
      method: (order.attributionMethod as "AD" | "CODE" | "NONE" | null) ?? "NONE",
      adId: order.adId ?? null,
      adSourceType: order.adSourceType ?? null,
      ctwaClid: revealRef(order.ctwaClidEnc),
      refCode: order.refCode ?? null,
      refCodeAt: isoOrNull(order.refCodeAt),
      touchAt: isoOrNull(order.touchAt),
      pageId: order.pageRef ?? null,
      psid: revealRef(order.psidEnc),
      wabaId: order.wabaId ?? null,
      conversationRef: order.conversationId ? conversationRef(order.conversationId) : null,
    },
  };

  let created: OmsCreatedOrder;
  try {
    try {
      created = await client.createOrder(payload);
    } catch (err) {
      // نتيجة غامضة (مهلة · انقطاع — يمكن الـ OMS استلم): إعادة وحدة بنفس المفتاح.
      const code = err instanceof AppError ? err.code : "";
      if (code !== "OMS_TIMEOUT" && code !== "OMS_UNREACHABLE") throw err;
      created = await client.createOrder(payload);
    }
  } catch (err) {
    await noteOmsError(db, ctx.workspaceId, `order: ${err instanceof AppError ? err.message : "ERROR"}`);
    throw err;
  }

  await db.order.update({
    where: { id: order.id },
    data: {
      omsOrderId: created.id,
      omsStatus: created.status,
      omsStatusAt: new Date(),
      handedOffAt: new Date(),
      handoffMode: "api",
      ...(created.orderNumber ? { omsOrderNumber: created.orderNumber } : {}),
    } as never,
  });
  await noteOmsOk(db, ctx.workspaceId);
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "oms.order_handed_off",
    entityType: "Order",
    entityId: order.id,
    metadata: {
      omsOrderId: created.id,
      omsOrderNumber: created.orderNumber,
      priceAdjusted: created.priceAdjusted,
      omsTotal: created.total,
      omsCurrency: created.currency,
    },
  });
  await eventBus.publish(
    makeEvent("OrderStateChanged", ctx.workspaceId, { orderId: order.id, type: "OrderHandedOffToOms", omsOrderId: created.id })
  );
  return { omsOrderId: created.id, omsOrderNumber: created.orderNumber, handedOff: true, priceAdjusted: created.priceAdjusted };
}
