import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { decimalString } from "@/modules/integrations/format";

/**
 * P12 — الترحيل اليدوي للـ OMS (يشتغل اليوم بلا أي تعديل على الـ OMS).
 *
 * الـ OMS الحقيقي فيه شاشة «إدخال الطلب بالذكاء» (POST /api/orders/ai-intake)
 * تقرأ نصًا ملصوقًا بهالشكل حرفيًا (src/lib/order-parser.ts بريبو الـ OMS):
 *   الاسم: … · الرقم: … · اسم المحافظة: … · العنوان: … ·
 *   الطلب ( المنتج ): … · الكمية: … · السعر: … · الملاحظات: … · اسم الصفحة: …
 * «السعر» هناك = سعر سطر المنتج كاملًا بلا توصيل (الـ OMS يقسمه على الكمية،
 * والتوصيل يُحسب عنده). الموظف ينسخ، يلصق هناك، يراجع، ينشئ — ثم يلصق رقم
 * طلب الـ OMS هنا فيرتبط الطلب، وأحداث الـ OMS بعدها تُطابق بالرقم.
 */

const SOURCE_MAX = 40; // حد حقل المصدر بشاشة الإدخال بالـ OMS

const CHANNEL_AR: Record<string, string> = {
  whatsapp: "واتساب",
  messenger: "ماسنجر",
  instagram: "إنستغرام",
  telegram: "تيليجرام",
  tiktok: "تيك توك",
  web: "الموقع",
};

function clean(v: unknown, max = 200): string {
  return String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * نص حر (اسم · محافظة · عنوان · منتج · ملاحظات): محلّل الـ OMS بيقسم السطور
 * على «؛ ;» وبيلقط «تسمية: قيمة» أو «تسمية - قيمة» بأي مكان بالسطر — فعنوان
 * فيه «؛» بينقص، وملاحظة فيها «العدد: 3» بتغيّر الكمية، و«المصدر:» بيغيّر
 * المصدر. منحيّد الفواصل جوّا القيم: «؛ ;» ← «،» · «: ：» ← مسافة · «-» ← «–».
 */
function cleanText(v: unknown, max = 200): string {
  return clean(
    String(v ?? "")
      .replace(/[;؛]/g, "،")
      .replace(/[:：]/g, " ")
      .replace(/-/g, "–"),
    max
  );
}

type OrderItemRow = {
  productNameSnapshot: string;
  skuSnapshot: string;
  unitPrice: unknown;
  quantity: number;
  subtotal: unknown;
};

type OrderRow = {
  id: string;
  workspaceId: string;
  orderNumber: string;
  customerId: string;
  draftId: string | null;
  status: string;
  confirmationStatus: string;
  deliveryAddress: string | null;
  province: string | null;
  notes: string | null;
  subtotal: unknown;
  discount: unknown;
  deliveryFee: unknown;
  total: unknown;
  currency: string;
  omsOrderId: string | null;
  omsOrderNumber?: string | null;
  omsStatus: string | null;
  handoffMode?: string | null;
  channel?: string | null;
  attributionMethod?: string | null;
  refCode?: string | null;
  items?: OrderItemRow[];
};

export interface OmsIntakeResult {
  text: string;
  warnings: string[];
  linked: boolean;
  omsOrderNumber: string | null;
  orderNumber: string;
}

export function sourceLabel(channel: string | null | undefined, method: string | null | undefined, refCode: string | null | undefined): string {
  const ch = CHANNEL_AR[channel ?? ""] ?? "الردود";
  let label = `${ch} · الردود`;
  if (method === "CODE" && refCode) label = `${ch} · رمز ${refCode}`;
  else if (method === "AD") label = `${ch} · إعلان`;
  return label.slice(0, SOURCE_MAX);
}

/** نص جاهز للصق بشاشة «إدخال الطلب بالذكاء» بالـ OMS. */
export function formatOmsIntakeText(input: {
  customerName: string;
  phone: string;
  province: string;
  address: string;
  items: OrderItemRow[];
  discount: unknown;
  deliveryFee: unknown;
  total: unknown;
  currency: string;
  notes: string | null;
  orderNumber: string;
  source: string;
}): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const items = [...input.items].sort((a, b) => Number(b.subtotal) - Number(a.subtotal));
  const head = items[0];
  if (!head) throw new AppError("الطلب بلا منتجات", 422, "ORDER_HAS_NO_ITEMS");
  // الخصم على مستوى الطلب يُطرح من السطر الرئيسي (حتى لا يزيد الـ OMS عن المتفق عليه).
  const discount = Number(input.discount ?? 0) || 0;
  const headLine = Math.max(0, Number(head.subtotal ?? 0) - (items.length === 1 ? discount : 0));
  const extras = items.slice(1).map((i) => `${cleanText(i.productNameSnapshot, 80)} × ${i.quantity} = ${decimalString(i.subtotal)} ${input.currency}`);
  if (extras.length > 0) {
    warnings.push("الطلب فيه أكثر من منتج — شاشة الإدخال بالـ OMS بتسجّل منتج واحد، ضيف الباقي يدويًا من الملاحظات.");
  }
  if (items.length > 1 && discount > 0) {
    warnings.push(`خصم على الطلب كله ${decimalString(discount)} ${input.currency} — طبّقه يدويًا بالـ OMS.`);
  }
  if (!input.phone) warnings.push("ما في رقم هاتف للزبون — الـ OMS ما بيقبل الطلب بلا رقم.");
  if (!input.address) warnings.push("العنوان ناقص.");

  // أجزاء الملاحظات بفاصل «—» مش «:» — ولا جزء منها بيشبه «تسمية: قيمة» للمحلّل.
  const noteParts: string[] = [];
  if (input.notes) noteParts.push(cleanText(input.notes, 300));
  if (extras.length) noteParts.push(`منتجات إضافية — ${extras.join(" · ")}`);
  noteParts.push(
    `المتفق عليه مع الزبون — التوصيل ${decimalString(input.deliveryFee) ?? "0.00"} · المجموع ${decimalString(input.total) ?? "0.00"} ${input.currency}`
  );
  // رقم طلبنا بشرطاته كما هو (صيغتنا: حروف وأرقام وشرطات — ما فيها تسمية عربية).
  noteParts.push(`مرجع الردود ${clean(input.orderNumber, 40)}`);

  const lines = [
    `الاسم: ${cleanText(input.customerName, 80) || "-"}`,
    `الرقم: ${clean(input.phone, 20).replace(/[^0-9+]/g, "") || "-"}`,
    `اسم المحافظة: ${cleanText(input.province, 60) || "-"}`,
    `العنوان: ${cleanText(input.address, 200) || "-"}`,
    `الطلب ( المنتج ): ${cleanText(head.productNameSnapshot, 120)}`,
    `الكمية: ${head.quantity}`,
    `السعر: ${decimalString(headLine) ?? "0.00"}`,
    `الملاحظات: ${noteParts.join(" | ").slice(0, 480)}`,
    `اسم الصفحة: ${cleanText(input.source, SOURCE_MAX)}`,
  ];
  return { text: lines.join("\n"), warnings };
}

async function loadOwnedOrder(db: Db, workspaceId: string, orderId: string): Promise<OrderRow> {
  const order = (await db.order.findUnique({ where: { id: orderId }, include: { items: true } })) as unknown as OrderRow | null;
  if (!order || order.workspaceId !== workspaceId) throw new NotFoundError("Order");
  return order;
}

function isConfirmed(order: OrderRow): boolean {
  return order.confirmationStatus === "CONFIRMED_BY_CUSTOMER" || order.confirmationStatus === "CONFIRMED_BY_AGENT";
}

export async function buildOmsIntake(db: Db, workspaceId: string, orderId: string): Promise<OmsIntakeResult> {
  const order = await loadOwnedOrder(db, workspaceId, orderId);
  if (!isConfirmed(order)) throw new AppError("الطلب لسا مش مؤكد", 422, "ORDER_NOT_CONFIRMED");
  const customer = (await db.customer.findUnique({ where: { id: order.customerId } })) as
    | { name: string | null; phone: string | null; isBlacklisted?: boolean }
    | null;
  if (!customer) throw new NotFoundError("Customer");
  if (customer.isBlacklisted) throw new AppError("الزبون بالقائمة السوداء — ما بينرحّل", 422, "ORDER_CUSTOMER_BLACKLISTED");
  const draft = order.draftId
    ? ((await db.orderDraft.findUnique({ where: { id: order.draftId } })) as { customerName?: string | null; phone?: string | null } | null)
    : null;
  const { text, warnings } = formatOmsIntakeText({
    customerName: draft?.customerName || customer.name || "",
    phone: customer.phone || draft?.phone || "",
    province: order.province ?? "",
    address: order.deliveryAddress ?? "",
    items: order.items ?? [],
    discount: order.discount,
    deliveryFee: order.deliveryFee,
    total: order.total,
    currency: order.currency,
    notes: order.notes,
    orderNumber: order.orderNumber,
    source: sourceLabel(order.channel, order.attributionMethod, order.refCode),
  });
  return {
    text,
    warnings,
    linked: Boolean(order.omsOrderNumber || order.omsOrderId),
    omsOrderNumber: order.omsOrderNumber ?? null,
    orderNumber: order.orderNumber,
  };
}

/** شكل رقم طلب الـ OMS (ORDER_NUMBER_RE بـ src/lib/order-ref.ts بريبو الـ OMS): SY-2026-0148 · JO-2026-0007. */
export const OMS_ORDER_NUMBER_RE = /^[A-Z0-9]{2,10}-[0-9]{4}-[0-9]{4,8}$/;

/**
 * توحيد رقم ملصوق: مسافات · «#» · حروف صغيرة · أرقام عربية · شرطات
 * بديلة · علامات اتجاه من النسخ — المطابقة مع أحداث الـ OMS حرفية.
 */
export function normalizeOmsOrderNumber(raw: string): string {
  return String(raw ?? "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[‐-―−－]/g, "-")
    .replace(/\s+/g, "")
    .replace(/^#+/, "")
    .toUpperCase();
}

export async function linkManualOmsOrder(
  db: Db,
  ctx: ActorContext,
  orderId: string,
  rawNumber: string
): Promise<{ orderId: string; omsOrderNumber: string; changed: boolean }> {
  const omsOrderNumber = normalizeOmsOrderNumber(rawNumber);
  if (!OMS_ORDER_NUMBER_RE.test(omsOrderNumber)) {
    throw new AppError("رقم طلب الـ OMS لازم يكون بشكل SY-2026-0148 (انسخه من صفحة الطلب بالـ OMS)", 422, "INVALID_OMS_ORDER_NUMBER");
  }
  const order = await loadOwnedOrder(db, ctx.workspaceId, orderId);
  if (!isConfirmed(order)) throw new AppError("الطلب لسا مش مؤكد", 422, "ORDER_NOT_CONFIRMED");
  if (order.omsOrderNumber === omsOrderNumber) return { orderId, omsOrderNumber, changed: false };
  if (order.omsOrderId) {
    // مربوط بمعرّف الـ OMS: التغيير بيمر بفك الربط أولًا (يدوي بس — ترحيل API مقفول).
    throw new AppError("الطلب مربوط بالـ OMS — فك الربط أولًا إذا الرقم غلط", 409, "OMS_LINK_LOCKED");
  }
  const clash = await db.order.findFirst({
    where: { workspaceId: ctx.workspaceId, omsOrderNumber, NOT: { id: orderId } },
    select: { id: true, orderNumber: true },
  } as never);
  if (clash) throw new AppError("رقم الـ OMS هذا مربوط بطلب تاني", 409, "OMS_ORDER_NUMBER_TAKEN");

  await db.order.update({
    where: { id: orderId },
    data: {
      omsOrderNumber,
      handoffMode: "manual",
      handedOffAt: new Date(),
      omsStatus: order.omsStatus ?? "NEW",
    } as never,
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "oms.order_linked_manual",
    entityType: "Order",
    entityId: orderId,
    metadata: { omsOrderNumber, previous: order.omsOrderNumber ?? null },
  });
  // حدث خاص بالربط (مش OrderStateChanged): الربط اليدوي مش «تحديث حالة من
  // الـ OMS»، فما لازم يشغّل مسارات العمل المربوطة بهالمحفّز.
  await eventBus.publish(makeEvent("OrderOmsLinked", ctx.workspaceId, { orderId, mode: "manual", omsOrderNumber }));
  return { orderId, omsOrderNumber, changed: true };
}

/**
 * فك ربط يدوي (رقم غلط). الربط اليدوي بيضل قابل للفك حتى بعد ما أول حدث كمّل
 * معرّف الـ OMS — لأنه انبنى على رقم كتبه موظف. ترحيل API (معرّف من رد الـ
 * OMS نفسه) مقفول. الحالة المحلية الي غيّرتها أحداث الرقم الغلط ما بترجع
 * لحالها — منسجّلها بالسجل حتى الفريق يراجعها.
 */
export async function unlinkManualOmsOrder(db: Db, ctx: ActorContext, orderId: string): Promise<void> {
  const order = await loadOwnedOrder(db, ctx.workspaceId, orderId);
  if (order.omsOrderId && order.handoffMode !== "manual") {
    throw new AppError("الطلب انرحّل للـ OMS بالـ API — ما بينفك يدويًا", 409, "OMS_LINK_LOCKED");
  }
  if (!order.omsOrderNumber && !order.omsOrderId) return;
  await db.order.update({
    where: { id: orderId },
    data: { omsOrderId: null, omsOrderNumber: null, handoffMode: null, handedOffAt: null, omsStatus: null, omsStatusAt: null } as never,
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "oms.order_unlinked_manual",
    entityType: "Order",
    entityId: orderId,
    metadata: {
      omsOrderNumber: order.omsOrderNumber ?? null,
      hadOmsId: Boolean(order.omsOrderId),
      // حالة الطلب لحظة الفك — إذا أحداث رقم غلط غيّرتها، هون بتبين.
      localStatus: order.status,
      omsStatus: order.omsStatus,
    },
  });
}
