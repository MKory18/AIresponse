import { omsStatusLabel } from "./oms-labels";

/**
 * حالة الطلب للعرض (الحزمة 1.8) — ملف نقي (بلا خادم)، مصدر واحد لبطاقة الطلب وقائمة الطلبات:
 * عمود حالة واحد بدل «حالة» + «حالة التأكيد» + «تلجرام»، وتبويبات «تحتاج مراجعة».
 */
export interface OrderStatusInput {
  status: string;
  sealedAt?: string | Date | null;
  heldBy?: string | null;
  omsStatus?: string | null;
  omsShippingStatus?: string | null;
}

export type StatusTone = "info" | "warn" | "ok" | "bad" | "muted";

const SEALED_STATUSES = new Set(["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED"]);

/** مثبّت = `sealedAt` (طلبات القارئ) أو حالة بعد التأكيد (طلبات المسودة القديمة). */
export function isSealed(o: OrderStatusInput): boolean {
  return Boolean(o.sealedAt) || SEALED_STATUSES.has(o.status);
}

export function orderStatusLabel(o: OrderStatusInput): { text: string; tone: StatusTone } {
  switch (o.status) {
    case "NEW":
      return { text: o.heldBy ? "موقوف — بانتظار موظف" : "بانتظار التثبيت", tone: "info" };
    case "CONFIRMATION_PENDING":
      return { text: "تحتاج مراجعة", tone: "warn" };
    case "CANCELLED":
      return { text: "ملغى", tone: "muted" };
    case "FAILED":
      return { text: "فشل", tone: "bad" };
    case "RETURNED":
      return { text: "مرتجع", tone: "bad" };
    default: {
      const atOms = omsStatusLabel(o.omsStatus, o.omsShippingStatus);
      const base =
        o.status === "DELIVERED" ? "تم التسليم" : o.status === "OUT_FOR_DELIVERY" ? "بالتوصيل" : o.status === "PROCESSING" ? "قيد التجهيز" : "مثبّت";
      return { text: atOms && o.status !== "DELIVERED" ? `${base} · عند الـ OMS: ${atOms}` : base, tone: o.status === "DELIVERED" ? "ok" : "ok" };
    }
  }
}

export type OrderTab = "all" | "review" | "awaiting" | "sealed" | "cancelled";

export const ORDER_TABS: Array<{ key: OrderTab; label: string }> = [
  { key: "all", label: "الكل" },
  { key: "review", label: "تحتاج مراجعة" },
  { key: "awaiting", label: "بانتظار التثبيت" },
  { key: "sealed", label: "مثبّتة" },
  { key: "cancelled", label: "ملغاة" },
];

export function orderMatchesTab(o: OrderStatusInput, tab: OrderTab): boolean {
  switch (tab) {
    case "review":
      return o.status === "CONFIRMATION_PENDING";
    case "awaiting":
      return o.status === "NEW";
    case "sealed":
      return isSealed(o);
    case "cancelled":
      return o.status === "CANCELLED" || o.status === "FAILED";
    default:
      return true;
  }
}

/** أسباب المراجعة: السبب بالأحمر + التصحيح بالبرتقالي (قاعدة المالك). */
export const REVIEW_REASONS: Record<string, { risk: string; fix: string }> = {
  PRODUCT_AMBIGUOUS: { risk: "اسم المنتج بيطابق أكتر من منتج", fix: "اسأل العميل أي منتج بيقصد، أو عدّل البند." },
  PRODUCT_UNKNOWN: { risk: "المنتج المذكور مش بكتالوج الصفحة", fix: "راجع المحادثة وحدّد المنتج الصح قبل التثبيت." },
  PRODUCT_UNRESOLVED: { risk: "في بند منتجه مش محسوم", fix: "حدّد المنتج مع العميل، وبعدها «أطلق» أو «ثبّت الآن»." },
  PHONE_INVALID: { risk: "الرقم مش بصيغة صحيحة", fix: "اطلب رقم صحيح من العميل وعدّله بزر «عدّل»." },
  PHONE_AMBIGUOUS: { risk: "في أكتر من رقم والمقصود مش واضح", fix: "تأكد مع العميل أي رقم نتواصل عليه." },
  QUANTITY_UNGROUNDED: { risk: "الكمية مش مذكورة بوضوح بكلام العميل", fix: "تأكد من الكمية مع العميل." },
  AREA_UNKNOWN: { risk: "المحافظة غير معروفة", fix: "اسأل العميل عن المحافظة وعدّلها." },
  AREA_NOT_SERVED: { risk: "التوصيل غير متاح للمنطقة", fix: "أبلغ العميل، أو ألغِ الطلب." },
  OUT_OF_STOCK: { risk: "المنتج غير متوفر", fix: "اعرض بديل أو ألغِ الطلب." },
  PRODUCT_INACTIVE: { risk: "المنتج موقوف", fix: "اعرض بديل أو ألغِ الطلب." },
  EXCEEDS_MAX: { risk: "الكمية فوق الحد الأقصى", fix: "تأكد من الكمية وعدّلها." },
  DUPLICATE_LIKELY: { risk: "غالبًا طلب مكرر (نفس العميل والمنتج خلال 24 ساعة)", fix: "افتح الطلب السابق وقرر: ألغِ المكرر أو ثبّت." },
  CUSTOMER_BLACKLISTED: { risk: "العميل بالقائمة السوداء", fix: "ما بينبعت للـ OMS. راجع مع المسؤول قبل أي خطوة." },
  NO_AGREEMENT: { risk: "العميل ما أكّد الطلب بوضوح", fix: "اسأله «أثبّت الطلب؟» أو اضغط «ثبّت الآن» إذا متأكد." },
  LOW_CONFIDENCE: { risk: "ثقة القراءة منخفضة", fix: "راجع المحادثة وتأكد من القيم." },
  AI_CLAIMED_NO_ORDER: { risk: "الوكيل وعد بتثبيت والبيانات ناقصة", fix: "كمّل البيانات مع العميل أو صحّح للعميل." },
  MISSING_FIELDS: { risk: "بيانات ناقصة", fix: "الوكيل بيطلبها من العميل؛ كمّلها بزر «عدّل» إذا عندك." },
  STAFF_HOLD: { risk: "الطلب موقوف من موظف", fix: "اضغط «أطلق» لما تخلص مراجعته." },
  CHANGED_AFTER_STAFF_EDIT: { risk: "العميل ذكر قيمة مختلفة بعد تعديلك", fix: "راجع المحادثة وقرر أي قيمة صح." },
};

export function reviewReason(code: string): { risk: string; fix: string } {
  return REVIEW_REASONS[code] ?? { risk: `سبب مراجعة: ${code}`, fix: "راجع المحادثة." };
}

/** عدّاد التثبيت: «08:12» (فاضي إذا خلص أو ما في موعد). */
export function settleCountdown(settleAt: string | Date | null | undefined, now: number = Date.now()): string | null {
  if (!settleAt) return null;
  const ms = new Date(settleAt).getTime() - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "00:00";
  const total = Math.ceil(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
