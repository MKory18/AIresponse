import { z } from "zod";
import { randomId } from "@/core/crypto";
import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import { publishRealtime } from "@/modules/realtime/events";
import type { ActorContext, Db } from "@/modules/customers/service";
import type { Order, Prisma } from "@prisma/client";
import { calculateCartPricing } from "./pricing";
import { normalizePhone } from "./primitives";
import { evaluateOrderRules } from "./rules";
import { runOrderCreatedHooks } from "./order-service";

/**
 * «طلب يدوي» (3.2): موظف بيدخل طلب باليد (مكالمة · واتساب شخصي · محل) — اليوم ما في طريقة.
 * بيمرّ بنفس القواعد والتسعير من قاعدة البيانات (ولا سعر من الشاشة) ويثبّت فورًا:
 * `CONFIRMED` + `CONFIRMED_BY_AGENT` + `sealedAt` + `source: "MANUAL"`، بلا محادثة ولا مسودة.
 *
 * - الزبون: بيتلاقى برقمه (بعد التطبيع) أو بينشأ. مدرج بالقائمة السوداء = رفض.
 * - تكرار محتمل (نفس الزبون + المنتج خلال 24 ساعة): 409 `DUPLICATE_ORDER` — الموظف بيكمل عن قصد بـ `allowDuplicate`.
 * - عدم التكرار: `idempotencyKey` (يولّدها الواجهة لكل فتح نموذج) — إعادة الإرسال بترجّع نفس الطلب.
 */

export const manualOrderSchema = z
  .object({
    customer: z
      .object({
        phone: z.string().trim().min(7).max(24),
        name: z.string().trim().min(1).max(120),
        province: z.string().trim().min(2).max(80),
        city: z.string().trim().max(80).optional(),
        address: z.string().trim().min(3).max(500),
      })
      .strict(),
    items: z
      .array(
        z
          .object({
            productId: z.string().min(1).max(64),
            variantId: z.string().min(1).max(64).optional(),
            quantity: z.number().int().min(1).max(1000),
          })
          .strict()
      )
      .min(1)
      .max(30),
    notes: z.string().trim().max(500).optional(),
    allowDuplicate: z.boolean().optional(),
    idempotencyKey: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_\-:.]+$/).optional(),
  })
  .strict();
export type ManualOrderInput = z.infer<typeof manualOrderSchema>;

export interface ManualOrderResult {
  orderId: string;
  orderNumber: string;
  status: string;
  total: number;
  currency: string;
  created: boolean;
}

const REASON_AR: Record<string, string> = {
  PRODUCT_NOT_FOUND: "منتج مش موجود",
  PRODUCT_INACTIVE: "منتج موقوف",
  OUT_OF_STOCK: "منتج خالص من المخزون",
  EXCEEDS_MAX: "كمية فوق الحد المسموح",
  NON_POSITIVE: "كمية غير صالحة",
  PROVINCE_NOT_SERVED: "المحافظة مش مخدّمة بالتوصيل",
};

export async function createManualOrder(db: Db, ctx: ActorContext, input: ManualOrderInput): Promise<ManualOrderResult> {
  const idemRaw = input.idempotencyKey ?? `auto-${randomId(8)}`;
  const idempotencyKey = `manual:${ctx.workspaceId}:${idemRaw}`;
  const same = (o: { id: string; orderNumber: string; status: string; total: unknown; currency: string }): ManualOrderResult => ({
    orderId: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    total: Number(o.total),
    currency: o.currency,
    created: false,
  });
  if (input.idempotencyKey) {
    const existing = await db.order.findUnique({ where: { idempotencyKey } });
    if (existing) return same(existing);
  }

  const phone = normalizePhone(input.customer.phone);
  if (!phone.valid) throw new AppError("رقم الهاتف غير صالح", 422, "INVALID_PHONE");

  // الأصناف: دمج نفس المنتج/النسخة بسطر واحد (ما بنضيّع كمية).
  const merged = new Map<string, { productId: string; variantId: string | null; quantity: number }>();
  for (const it of input.items) {
    const k = `${it.productId}|${it.variantId ?? ""}`;
    const prev = merged.get(k);
    merged.set(k, { productId: it.productId, variantId: it.variantId ?? null, quantity: (prev?.quantity ?? 0) + it.quantity });
  }
  const lines = [...merged.values()];

  const productIds = [...new Set(lines.map((l) => l.productId))];
  const products = (await db.product.findMany({
    where: { id: { in: productIds }, workspaceId: ctx.workspaceId },
    select: { id: true, name: true, sku: true, price: true, currency: true, isActive: true, isArchived: true, stockStatus: true, workspaceId: true },
  })) as Array<{ id: string; name: string; sku: string | null; price: Prisma.Decimal; currency: string; isActive: boolean; isArchived: boolean; stockStatus: string; workspaceId: string }>;
  const productById = new Map(products.map((p) => [p.id, p]));
  for (const l of lines) if (!productById.has(l.productId)) throw new NotFoundError("Product");

  const variantIds = [...new Set(lines.map((l) => l.variantId).filter((v): v is string => Boolean(v)))];
  const variants = variantIds.length
    ? ((await db.productVariant.findMany({ where: { id: { in: variantIds } } })) as Array<{ id: string; productId: string; price: Prisma.Decimal }>)
    : [];
  const variantFor = (l: (typeof lines)[number]) => {
    if (!l.variantId) return null;
    const v = variants.find((x) => x.id === l.variantId && x.productId === l.productId);
    if (!v) throw new AppError("نسخة المنتج مش لهالمنتج", 422, "VARIANT_MISMATCH");
    return v;
  };

  // الزبون: برقمه أو جديد. القائمة السوداء (مصدرها الـ OMS) بتغلب.
  const found = (await db.customer.findFirst({
    where: { workspaceId: ctx.workspaceId, OR: [{ phone: phone.canonical }, { phone: input.customer.phone }] },
    orderBy: { createdAt: "asc" },
  })) as { id: string; isBlacklisted?: boolean } | null;
  if (found?.isBlacklisted === true) {
    await recordAudit(db, { workspaceId: ctx.workspaceId, userId: ctx.userId, action: "order.blacklisted_blocked", entityType: "Customer", entityId: found.id, metadata: { source: "MANUAL" } });
    throw new AppError("الزبون بالقائمة السوداء — ما بينعمل له طلب", 422, "ORDER_CUSTOMER_BLACKLISTED");
  }

  // القواعد نفسها (منتج نشط ومتوفر · كمية · توصيل). التكرار تحت لأنه قرار الموظف.
  const rules = await evaluateOrderRules(db, {
    workspaceId: ctx.workspaceId,
    draft: {
      productId: lines[0].productId,
      quantity: lines[0].quantity,
      phone: phone.canonical,
      rawAddress: input.customer.address,
      province: input.customer.province,
      missingFields: [],
      customerId: found?.id ?? "manual-new-customer",
      conversationId: "manual-no-conversation",
      items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
    },
  });
  const hard = rules.filter((r) => r.verdict === "DENY");
  if (hard.length > 0) {
    const why = hard.map((r) => REASON_AR[r.reason ?? ""] ?? r.reason).join("، ");
    throw new AppError(`الطلب مرفوض: ${why}`, 422, "ORDER_RULES_DENIED", hard.map((r) => ({ rule: r.rule, reason: r.reason })));
  }
  const dup = rules.find((r) => r.rule === "duplicate_order");
  if (dup && !input.allowDuplicate) {
    throw new AppError("في طلب مشابه لنفس الزبون والمنتج خلال 24 ساعة", 409, "DUPLICATE_ORDER", [{ level: dup.verdict === "REQUIRE_HUMAN" ? "LIKELY" : "POSSIBLE" }]);
  }

  const currencies = new Set(products.map((p) => p.currency));
  if (currencies.size > 1) throw new AppError("منتجات بعملات مختلفة بنفس الطلب", 422, "MIXED_CURRENCY");

  const breakdown = await calculateCartPricing(db, {
    workspaceId: ctx.workspaceId,
    items: lines.map((l) => ({ price: variantFor(l)?.price ?? productById.get(l.productId)!.price, quantity: l.quantity, currency: productById.get(l.productId)!.currency })),
    province: input.customer.province,
  });
  if (!breakdown.deliveryAvailable) throw new AppError("التوصيل مش متاح لهالمحافظة", 422, "DELIVERY_UNAVAILABLE");

  const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${randomId(3).toUpperCase()}`;
  const now = new Date();

  const write = async (tx: Db): Promise<Order> => {
    let customerId = found?.id;
    if (!customerId) {
      const c = (await tx.customer.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.customer.name,
          phone: phone.canonical,
          province: input.customer.province,
          city: input.customer.city ?? null,
          address: input.customer.address,
        } as never,
      })) as { id: string };
      customerId = c.id;
    }
    return (await tx.order.create({
      data: {
        workspaceId: ctx.workspaceId,
        orderNumber,
        customerId,
        conversationId: null,
        draftId: null,
        status: "CONFIRMED",
        confirmationStatus: "CONFIRMED_BY_AGENT",
        agreement: "STAFF",
        sealedAt: now,
        deliveryAddress: input.customer.address,
        recipientName: input.customer.name,
        recipientPhone: phone.canonical,
        province: input.customer.province,
        notes: input.notes ?? null,
        subtotal: breakdown.subtotal,
        discount: breakdown.discount,
        deliveryFee: breakdown.deliveryFee,
        total: breakdown.total,
        currency: breakdown.currency,
        source: "MANUAL",
        channel: "manual",
        idempotencyKey,
        items: {
          create: lines.map((l, idx) => ({
            productId: l.productId,
            variantId: variantFor(l)?.id ?? null,
            productNameSnapshot: productById.get(l.productId)!.name,
            skuSnapshot: productById.get(l.productId)!.sku,
            unitPrice: breakdown.lines[idx].unitPrice,
            quantity: l.quantity,
            subtotal: breakdown.lines[idx].subtotal,
          })),
        },
      } as Prisma.OrderUncheckedCreateInput,
    })) as Order;
  };

  let order: Order;
  try {
    const anyDb = db as unknown as { $transaction?: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };
    order = typeof anyDb.$transaction === "function" ? await anyDb.$transaction(write) : await write(db);
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      const existing = await db.order.findUnique({ where: { idempotencyKey } });
      if (existing) return same(existing);
    }
    throw err;
  }

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "order.created",
    entityType: "Order",
    entityId: order.id,
    metadata: { orderNumber, total: breakdown.total, currency: breakdown.currency, source: "MANUAL", duplicateAllowed: Boolean(dup && input.allowDuplicate) },
  });
  await recordAudit(db, { workspaceId: ctx.workspaceId, action: "price.calculated", entityType: "Order", entityId: order.id, metadata: { ...breakdown } });
  await eventBus.publish(makeEvent("OrderCreated", ctx.workspaceId, { orderId: order.id, total: breakdown.total, customerId: order.customerId }));
  await eventBus.publish(makeEvent("CustomerUpdated", ctx.workspaceId, { customerId: order.customerId, type: "order.created" }));
  await eventBus.publish(makeEvent("OrderConfirmed", ctx.workspaceId, { orderId: order.id, customerId: order.customerId }));
  void publishRealtime(db, { workspaceId: ctx.workspaceId, type: "order.created", entityId: order.id });
  await runOrderCreatedHooks(db, ctx, order.id);

  return { orderId: order.id, orderNumber, status: order.status, total: breakdown.total, currency: breakdown.currency, created: true };
}
