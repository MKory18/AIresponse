import { matchProductByName } from "@/modules/products/name-match";
import { toWesternDigits } from "@/modules/orders/primitives";

/**
 * فلتر القراءة ببلاش (بلا ذكاء): هل المحادثة تستاهل نداء للقارئ؟
 *
 * بيقرأ إذا تحقق **أي** من:
 *  - في طلب مفتوح أو مثبّت قابل للتعديل،
 *  - في مرشّح رقم هاتف برسائل العميل ضمن النافذة،
 *  - في اسم منتج من كتالوج الصفحة بأي رسالة ضمن النافذة،
 *  - في كلمة إلغاء أو تعديل.
 * غير هيك ← مرحلة `NONE` بلا نداء (دردشة عادية ما بتكلّف).
 * الخطأ هون بالاتجاه الآمن: إيجابي كاذب = نداء زيادة، سلبي كاذب = ما بيصير (النافذة بتتسع).
 */
export const FILTER_WINDOW_MESSAGES = 30;

const CANCEL_OR_AMEND = /(إلغاء|الغاء|الغي|ألغي|لغي|كنسل|cancel|تعديل|عدّل|عدل|بدّل|بدل|غيّر|غير ال|تغيير|زيد|زيادة|انقص)/i;

export interface FilterMessage {
  senderType: "CUSTOMER" | "AI" | "HUMAN" | "SYSTEM";
  text?: string | null;
  isNote?: boolean | null;
  deletedAt?: Date | string | null;
}

export interface FilterInput {
  messages: FilterMessage[];
  productNames: string[];
  hasOpenOrder: boolean;
}

export type FilterDecision = { read: true; reason: "OPEN_ORDER" | "PHONE" | "PRODUCT" | "CANCEL_OR_AMEND" } | { read: false; reason: "NOTHING_ORDER_LIKE" };

/** رقم محتمل: 7–15 خانة (بعد شيل الفراغات والشرطات والأرقام الهندية). */
export function hasPhoneCandidate(text: string): boolean {
  const western = toWesternDigits(text);
  const squeezed = western.replace(/(?<=\d)[\s\-.]+(?=\d)/g, "");
  return /\d{7,15}/.test(squeezed);
}

export function shouldReadConversation(input: FilterInput): FilterDecision {
  if (input.hasOpenOrder) return { read: true, reason: "OPEN_ORDER" };
  const customerTexts = input.messages
    .filter((m) => m.senderType === "CUSTOMER" && !m.isNote && !m.deletedAt && m.text)
    .slice(-FILTER_WINDOW_MESSAGES)
    .map((m) => String(m.text));
  if (customerTexts.some(hasPhoneCandidate)) return { read: true, reason: "PHONE" };
  const candidates = input.productNames.map((name) => ({ id: name, name }));
  if (candidates.length > 0 && customerTexts.some((t) => matchProductByName(t, candidates))) {
    return { read: true, reason: "PRODUCT" };
  }
  if (customerTexts.some((t) => CANCEL_OR_AMEND.test(t))) return { read: true, reason: "CANCEL_OR_AMEND" };
  return { read: false, reason: "NOTHING_ORDER_LIKE" };
}
