import type { Db } from "@/modules/jobs/service";
import { getOrderMode } from "./schedule";
import { parseOffers } from "@/modules/sales/plan-builder";

/**
 * سياق مسار الرد بوضع القارئ (الحزمة 1.5) — كله حتمي من قاعدة البيانات:
 *  (أ) «بطاقة الطلب»: حالة الطلب الحقيقية (أرقام التواصل معتّمة: «محفوظ ✅»)،
 *  (ب) «جدول الأسعار» للمنتج المحوري (+ رسوم التوصيل) — أرقامه كلها مسموحة بالرد،
 *  (ج) «طلبات العميل الأخيرة» — عشان «شو صار بطلبي؟» يلاقي جواب.
 * ولا شي هون بيروح للموديل إلا نص جاهز: الموديل ما بيحسب سعرًا ولا بيعرف رقمًا.
 */
export type ReplyOrderState = "NONE" | "COLLECTING" | "AWAITING_SEAL" | "UNDER_REVIEW" | "SEALED";

export interface ReaderReplyContext {
  orderCard: string | null;
  priceTable: string | null;
  recentOrders: string | null;
  /** أرقام موثوقة من القاعدة يجوز تذكرها بالرد. */
  allowedNumbers: Array<string | number>;
  /** `true` = مثبّت فعلًا · `false` = لسا بيتجمّع أو بيستنى (أي ادعاء تثبيت مرفوض) · `undefined` = ما في سياق طلب. */
  orderPlaced: boolean | undefined;
  state: ReplyOrderState;
  /** من القراءة: منتج محوري محتمل وناقص الطلب (للخطة). */
  readingProductId: string | null;
  missing: string[];
}

export async function isReaderReplyMode(db: Db, workspaceId: string): Promise<boolean> {
  return (await getOrderMode(db, workspaceId)) === "READER";
}

type Row = Record<string, unknown>;
type M = Record<string, Record<string, (a: unknown) => Promise<unknown>>>;

const MISSING_AR: Record<string, string> = { product: "المنتج", quantity: "الكمية", phone: "الهاتف", address: "العنوان", name: "الاسم" };
const STATUS_AR: Record<string, string> = {
  NEW: "بانتظار التثبيت",
  CONFIRMATION_PENDING: "قيد المراجعة",
  CONFIRMED: "مثبّت",
  PROCESSING: "قيد التجهيز",
  OUT_FOR_DELIVERY: "بالتوصيل",
  DELIVERED: "تم التسليم",
  CANCELLED: "ملغى",
  FAILED: "فشل",
  RETURNED: "مرتجع",
};

const money = (n: number) => (Math.round(n * 100) / 100).toString();
const longDigitRuns = (text: string) => [...text.matchAll(/[0-9٠-٩۰-۹][0-9٠-٩۰-۹\s]*/g)].map((m) => m[0].trim()).filter((s) => s.replace(/\D/g, "").length >= 7);

export async function buildReaderReplyContext(
  db: Db,
  input: { workspaceId: string; conversationId: string; customerId: string; productId?: string | null; now?: Date }
): Promise<ReaderReplyContext> {
  const d = db as unknown as M;
  const allowedNumbers: Array<string | number> = [];

  const reading = (await d.conversationReading.findUnique({ where: { conversationId: input.conversationId } })) as {
    stage?: string;
    data?: Row;
    missing?: string[];
  } | null;
  const order = (await d.order.findFirst({
    where: { workspaceId: input.workspaceId, conversationId: input.conversationId, status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
  })) as (Row & { id: string; status: string; sealedAt?: Date | null; orderNumber: string; recipientPhone?: string | null; deliveryAddress?: string | null; total?: unknown; currency?: string }) | null;

  const readingItems = (((reading?.data as { items?: Array<{ productId: string; name: string; quantity: number | null; unitPrice: number }> } | undefined)?.items) ?? []);
  const readingData = (reading?.data ?? {}) as { recipient?: { phone?: string | null; address?: string | null }; totals?: { total?: number; currency?: string | null } };
  const missing = (reading?.missing ?? []) as string[];

  // ── (أ) بطاقة الطلب ──
  let state: ReplyOrderState = "NONE";
  let orderPlaced: boolean | undefined;
  const lines: string[] = [];
  if (order) {
    const sealed = !!order.sealedAt && !["NEW", "CONFIRMATION_PENDING"].includes(order.status);
    state = sealed ? "SEALED" : order.status === "NEW" ? "AWAITING_SEAL" : "UNDER_REVIEW";
    orderPlaced = sealed;
    const items = (await d.orderItem.findMany({ where: { orderId: order.id } })) as Array<{ productNameSnapshot: string; quantity: number; unitPrice: unknown }>;
    const currency = String(order.currency ?? "");
    lines.push(
      sealed
        ? `الحالة: مثبّت · رقم الطلب ${order.orderNumber} · عند فريق التأكيد · التعديل: غير ممكن من هون`
        : state === "AWAITING_SEAL"
          ? "الحالة: بانتظار التثبيت — يتثبّت تلقائيًا خلال دقائق"
          : "الحالة: قيد المراجعة من الفريق"
    );
    if (items.length) {
      lines.push(`المنتجات: ${items.map((i) => `${i.productNameSnapshot} × ${i.quantity} — ${money(Number(i.unitPrice))} ${currency}`).join(" · ")}`);
      for (const i of items) allowedNumbers.push(Number(i.unitPrice), Number(i.unitPrice) * i.quantity);
    }
    lines.push(`الإجمالي: ${money(Number(order.total ?? 0))} ${currency}`.trim());
    allowedNumbers.push(Number(order.total ?? 0));
    lines.push(`الهاتف: ${order.recipientPhone ? "محفوظ ✅" : "ناقص"} · العنوان: ${order.deliveryAddress ? "محفوظ ✅" : "ناقص"}`);
    if (sealed) allowedNumbers.push(...longDigitRuns(order.orderNumber));
  } else if (reading && ["COLLECTING", "COMPLETE"].includes(String(reading.stage))) {
    state = "COLLECTING";
    orderPlaced = false;
    const currency = String(readingData.totals?.currency ?? "");
    lines.push("الحالة: قيد التجميع");
    if (readingItems.length) {
      lines.push(
        `المنتجات: ${readingItems.map((i) => `${i.name}${i.quantity ? ` × ${i.quantity}` : ""} — ${money(Number(i.unitPrice))} ${currency}`.trim()).join(" · ")}`
      );
      for (const i of readingItems) allowedNumbers.push(Number(i.unitPrice));
    }
    lines.push(`الهاتف: ${readingData.recipient?.phone ? "محفوظ ✅" : "ناقص"} · العنوان: ${readingData.recipient?.address ? "محفوظ ✅" : "ناقص"}`);
    if (missing.length) lines.push(`ينقص: ${missing.map((m) => MISSING_AR[m] ?? m).join(" · ")}`);
  }
  const orderCard = lines.length ? `بطاقة الطلب (بيانات رسمية — هذا ما سجّله النظام من المحادثة):\n${lines.join("\n")}` : null;

  // ── (ب) جدول الأسعار للمنتج المحوري ──
  let priceTable: string | null = null;
  const pivotId = input.productId ?? readingItems[0]?.productId ?? null;
  if (pivotId) {
    const p = (await d.product.findUnique({ where: { id: pivotId } })) as (Row & { workspaceId: string; name: string; price: unknown; currency: string; offers?: unknown }) | null;
    if (p && p.workspaceId === input.workspaceId) {
      const unit = Number(p.price);
      const offers = parseOffers(p.offers, input.now ?? new Date());
      const ladder: string[] = [];
      for (const q of [1, 2, 3]) {
        const offer = offers.find((o) => o.quantity === q && unit * q - o.price > 0);
        const total = offer ? offer.price : Math.round(unit * q * 100) / 100;
        allowedNumbers.push(total, q);
        ladder.push(`${q} = ${money(total)} ${p.currency}${offer ? ` (عرض: ${offer.title})` : ""}`);
      }
      allowedNumbers.push(unit);
      const rules = (await d.deliveryRule.findMany({ where: { workspaceId: input.workspaceId }, take: 12 })) as Array<{ province: string; fee: unknown; isAvailable: boolean; currency?: string | null }>;
      const delivery = rules.length
        ? `التوصيل: ${rules.filter((r) => r.isAvailable).map((r) => `${r.province} ${money(Number(r.fee))} ${r.currency ?? p.currency}`).join(" · ")}`
        : "رسوم التوصيل يحددها فريق التأكيد";
      for (const r of rules) allowedNumbers.push(Number(r.fee));
      priceTable = `جدول الأسعار الرسمي (استخدم هذه الأرقام حرفيًا ولا تحسب بنفسك):\n${p.name}: ${ladder.join(" · ")}\n${delivery}`;
    }
  }

  // ── (ج) طلبات العميل الأخيرة ──
  const recent = (await d.order.findMany({
    where: { workspaceId: input.workspaceId, customerId: input.customerId },
    orderBy: { createdAt: "desc" },
    take: 3,
  })) as Array<Row & { orderNumber: string; status: string; sealedAt?: Date | null; omsStatus?: string | null; createdAt: Date }>;
  const recentOrders = recent.length
    ? `طلبات العميل الأخيرة:\n${recent
        .map((o) => {
          const sealed = !!o.sealedAt || !["NEW", "CONFIRMATION_PENDING"].includes(o.status);
          const label = sealed ? STATUS_AR[o.status] ?? o.status : STATUS_AR[o.status] ?? "قيد الإنشاء";
          return `${sealed ? o.orderNumber : "طلب غير مثبّت بعد"} · ${label}${o.omsStatus ? ` · عند الـ OMS: ${o.omsStatus}` : ""} · ${new Date(o.createdAt).toISOString().slice(0, 10)}`;
        })
        .join("\n")}`
    : null;
  for (const o of recent) if (o.sealedAt) allowedNumbers.push(...longDigitRuns(o.orderNumber));

  return { orderCard, priceTable, recentOrders, allowedNumbers, orderPlaced, state, readingProductId: readingItems[0]?.productId ?? null, missing };
}
