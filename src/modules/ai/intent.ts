import type { Intent } from "./prompts";

/**
 * Rule-based intent fallback — used when the AI provider fails or returns
 * low-quality output. Cheap, deterministic, and good enough to avoid losing
 * the message while a retry/handoff decision is made.
 */
const RULES: [Intent, RegExp][] = [
  ["HUMAN_REQUEST", /(موظف|بشري|إنسان|انساني|human|agent|بدي أحكي مع)/],
  ["COMPLAINT", /(شكوى|شكوي|سيء|سيئ|مكسور|متأخر|مشكلة|متضايق|complaint|bad)/],
  ["ORDER_CANCEL", /(الغي|الغاء|ألغي|بدي ألغي|cancel)/],
  ["ORDER_UPDATE", /(أعدل|تعديل|أغير|بدي أعدل|update order|أكد|تأكيد|موافق|أوكي|أكيد)/],
  ["TRACK_ORDER", /(وين طلبي|متى يوصل طلبي|تتبع|track|طلبي وين)/],
  ["ORDER_CREATE", /(بدي أطلب|بدي اطلب|سجل طلبي|أعطيني|بدي \d+|بدي ١|order now|طللب|بدي)/],
  ["RETURN_REQUEST", /(إرجاع|ارجاع|أرجع المنتج|return)/],
  ["PAYMENT_QUESTION", /(دفع|أدفع|الدفع|payment|كاش|استلام)/],
  ["DELIVERY_QUESTION", /(توصيل|يوصل|توصيل مجاني|delivery|شحن)/],
  ["FEEDBACK_REQUEST", /(تجارب|جرب|رأي|آراء|توصية|review|testimonials)/],
  ["HOW_TO_USE", /(كيف أستخدم|طريقة الاستخدام|كيف استخدم|usage|كيف بشيل)/],
  ["PRICE_QUESTION", /(بكم|السعر|كم سعر|قديش|price)/],
  ["AVAILABILITY", /(متوفر|موجود|عندكم|متاح|available)/],
  ["PRODUCT_COMPARISON", /(الفرق بين|أفضل من|مقارنة|vs)/],
  ["BENEFITS", /(فوائد|فائدة|ينفع|فايدة|benefits)/],
  ["PRODUCT_QUESTION", /(المنتج|هاد الشي|مواصفات|تفاصيل|إيش هو)/],
  ["GREETING", /^(مرحبا|هلا|أهلا|hello|hi|سلام|صباح|مساء)/],
];

export function heuristicIntent(text: string): { intent: Intent; confidence: number } {
  const normalized = text.toLowerCase().trim();
  for (const [intent, pattern] of RULES) {
    if (pattern.test(normalized)) {
      return { intent, confidence: 0.75 };
    }
  }
  return { intent: "UNKNOWN", confidence: 0.3 };
}

/** Detects common prompt-injection attempts in customer content. */
export function looksLikeInjection(text: string): boolean {
  const patterns = [
    /ignore (all )?(previous|prior) instructions/i,
    /disregard (all )?(previous|above)/i,
    /(system|developer) (prompt|message)/i,
    /reveal your (instructions|prompt)/i,
    /you are now/i,
    /تجاهل (كل )?التعليمات/,
    /أنت الآن/,
  ];
  return patterns.some((p) => p.test(text));
}
