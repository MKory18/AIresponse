import { looksLikeInjection } from "./intent";
import { findPhoneCandidates } from "./privacy-gate";
import type { AIContext } from "./context-builder";
import { findBannedClaims } from "@/modules/integrations/compliance";

export interface GuardrailResult {
  valid: boolean;
  violations: string[];
  /** Suggest a safe fallback message instead of the generated response. */
  fallback?: string;
}

const MAX_RESPONSE_CHARS = 700; // Facebook Messenger style: 1–4 short lines
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{10,}/, // API keys
  /Bearer\s+[A-Za-z0-9._-]{15,}/,
  /eyJ[A-Za-z0-9_-]{20,}/, // JWTs
  /(JWT_SECRET|ENCRYPTION_KEY|META_APP_SECRET|DATABASE_URL)/,
];

/**
 * Response Validator — runs BEFORE anything is sent. It enforces:
 * price/product fidelity against trusted context, no unapproved feedback
 * claims, persona prohibited phrases, no leaked secrets, no injection echo,
 * and Messenger-appropriate length. On failure the caller regenerates once,
 * then falls back to the safe message / human handoff.
 */
export function validateResponse(params: {
  response: string;
  context?: AIContext | null;
  prohibitedPhrases?: string[];
  allowFeedbackQuote?: boolean;
  /**
   * P1: trusted contact strings (customer phone etc., any digit shape).
   * When provided (non-empty), phone-like runs that match NONE of them are
   * rejected as UNVERIFIED_CONTACT — the model must never invent contact
   * details. Omitted/empty = rule skipped (legacy behavior preserved).
   */
  trustedContacts?: string[];
  /**
   * P1.1: trusted non-contact numbers (prices, totals) exempt from the rule.
   */
  allowedNumbers?: Array<string | number>;
}): GuardrailResult {
  const violations: string[] = [];
  const { response, context, prohibitedPhrases = [], allowFeedbackQuote = false, trustedContacts = [], allowedNumbers = [] } = params;

  // 0. Empty responses must never be sent.
  if (!response || !response.trim()) {
    return {
      valid: false,
      violations: ["EMPTY_RESPONSE"],
    };
  }

  // 1. Secrets / credentials must never appear.
  if (SECRET_PATTERNS.some((p) => p.test(response))) {
    violations.push("SENSITIVE_DATA");
  }

  // 2. Prompt-injection echo (model repeating injected instructions).
  if (looksLikeInjection(response) || /\[UNTRUSTED_CUSTOMER_CONTENT\]/.test(response)) {
    violations.push("INJECTION_ECHO");
  }

  // 3. Price/currency fidelity: what the DB says is what the reply may say.
  //    (أ) أي عملة غير عملة المنتج = رفض حتى لو الرقم صحيح.
  //    (ب) أي رقم ملاصق لعملة لازم يكون سعر المنتج/البديل/سعر مسمّى/من خطة البيع.
  //    القديم كان يتجاهل أي رقم ≤ 1000 ولم يعرف «درهم/ريال/دينار» — فسعر غلط
  //    مثل 25 درهم بدل 10 دولار كان يمرّ بصمت.
  const allowedPriceValues = new Set<string>();
  const addAllowed = (v: string | number | null | undefined) => {
    const n = parsePriceValue(String(v ?? ""));
    if (n !== null) allowedPriceValues.add(priceKey(n));
  };
  for (const n of allowedNumbers) addAllowed(n);
  if (context?.product) {
    addAllowed(context.product.price);
    addAllowed(context.product.compareAtPrice ?? "");
    for (const tier of context.product.priceTiers ?? []) addAllowed(tier.price);
  }

  // نص الأسئلة الجاهزة والمعرفة اللي انعطى للموديل بهالرد: مصدر موثوق كمان —
  // «التوصيل 5 دولار» من جواب سؤال جاهز مش اختراع.
  const groundedText = groundedSourceText(context);
  const groundedPrices = new Set(groundedAmountsIn(groundedText).map(priceKey));
  const groundedCurrencies = detectCurrencies(groundedText);

  const mentionedCurrencies = detectCurrencies(response);
  const inGroundedCurrencies = [...mentionedCurrencies].every((c) => groundedCurrencies.has(c));
  const productCurrency = context?.product ? canonicalCurrency(context.product.currency) : null;
  if (mentionedCurrencies.size > 0 && productCurrency) {
    if (!mentionedCurrencies.has(productCurrency) && !inGroundedCurrencies) violations.push("CURRENCY_MISMATCH");
  }

  const priced = priceAmountsIn(response);
  if (priced.length > 0) {
    const ungrounded = priced.filter((amount) => !groundedPrices.has(priceKey(amount)));
    if (!context?.product) {
      // بلا منتج موثوق: أي سعر مش موجود بنص موثوق = اختراع، ونفس الرقم
      // بعملة تانية (5 ليرة بدل 5 دولار) مش نفس السعر.
      const otherCurrency = groundedCurrencies.size > 0 && !inGroundedCurrencies;
      if (ungrounded.length > 0 || otherCurrency) violations.push("UNSUPPORTED_PRICE");
    } else if (ungrounded.some((amount) => !allowedPriceValues.has(priceKey(amount)))) {
      violations.push("PRICE_MISMATCH");
    }
  }

  // 4. Unapproved feedback claims.
  if (!allowFeedbackQuote && context?.feedback) {
    for (const f of context.feedback) {
      if (f.content && f.content.length > 10 && response.includes(f.content.slice(0, 15))) {
        violations.push("UNAPPROVED_FEEDBACK");
      }
    }
  }

  // 5. Prohibited persona phrases.
  for (const phrase of prohibitedPhrases) {
    if (phrase && response.includes(phrase)) violations.push("PROHIBITED_PHRASE");
  }

  // 6. Medical/therapeutic claims are never allowed.
  if (/(يعالج|يشفي|علاج|مرض|cure|treats)/.test(response)) {
    violations.push("MEDICAL_CLAIM");
  }

  // 6b. P12 — ادعاءات ممنوعة من سيستم 1 للمنتج (مطابقة بعد تطبيع العربي).
  const banned = context?.product?.compliance?.bannedClaims ?? [];
  if (banned.length > 0 && findBannedClaims(response, banned).length > 0) {
    violations.push("BANNED_CLAIM");
  }

  // 7. Messenger style: keep it short.
  if (response.length > MAX_RESPONSE_CHARS) {
    violations.push("TOO_LONG");
  }

  // 8. P1.1: no invented contact details. Any phone-like run must match a
  // trusted contact or an allowlisted number (normalized across
  // Arabic-Indic/Persian digits). Same candidate policy as the gate's
  // reply-side scrub (strict bare runs, order-context exemption).
  if (trustedContacts.length > 0 || allowedNumbers.length > 0) {
    const allowed = new Set<string>();
    for (const c of trustedContacts) {
      const d = normalizeNumber(c).replace(/[^0-9]/g, "");
      if (d.length >= 7) allowed.add(d);
      if (c.trim()) allowed.add(c.trim());
    }
    for (const n of allowedNumbers) {
      const d = normalizeNumber(String(n)).replace(/[^0-9]/g, "");
      if (d.length >= 7) allowed.add(d);
      if (String(n).trim()) allowed.add(String(n).trim());
    }
    for (const cand of findPhoneCandidates(response, { strictBare: true })) {
      const d = normalizeNumber(cand).replace(/[^0-9]/g, "");
      if (!allowed.has(d) && !allowed.has(cand.trim())) {
        violations.push("UNVERIFIED_CONTACT");
        break;
      }
    }
  }

  const valid = violations.length === 0;
  return {
    valid,
    violations,
    fallback: undefined,
  };
}

/**
 * رمز كامل مش قطعة من كلمة: «لسا» و«جلسة» مش «ل.س»، وmade وbuyer مش MAD وYER.
 * الرقم الملاصق مسموح (100ل.س · 20MAD). الأسماء العربية الكاملة بتضل بلا
 * حدود عن قصد لأنها بتجي بسوابق («بالدولار» · «الليرة»).
 */
const currencyToken = (alternatives: string) => `(?<!\\p{L})(?:${alternatives})(?!\\p{L})`;
const SYP_ABBREVIATION = currencyToken("ل\\.?\\s?س");

/** لهجات العملات → مجموعة موحّدة للمقارنة (عربي + ISO). */
const CURRENCY_PATTERNS: { canonical: string; re: RegExp }[] = [
  { canonical: "USD", re: new RegExp(`\\$|${currencyToken("USD")}|دولار|دولارات`, "iu") },
  { canonical: "SYP", re: new RegExp(`${currencyToken("SYP")}|${SYP_ABBREVIATION}|لير[ةه]|ليرات`, "iu") },
  { canonical: "DIRHAM", re: new RegExp(`${currencyToken("MAD|AED")}|درهم|دراهم`, "iu") },
  { canonical: "RIYAL", re: new RegExp(`${currencyToken("SAR|QAR|OMR|YER")}|ريال|ريالات`, "iu") },
  { canonical: "DINAR", re: new RegExp(`${currencyToken("JOD|IQD|KWD|BHD|LYD|TND|DZD")}|دينار|دنانير`, "iu") },
  { canonical: "EGP", re: new RegExp(`${currencyToken("EGP")}|جنيه|جنيهات`, "iu") },
];

const CURRENCY_WORDS = `(?:${currencyToken("USD|SYP|MAD|AED|SAR|QAR|OMR|YER|JOD|IQD|KWD|BHD|LYD|TND|DZD|EGP")}|\\$|${SYP_ABBREVIATION}|دولار|دولارات|درهم|دراهم|ريال|ريالات|دينار|دنانير|لير[ةه]|ليرات|جنيه|جنيهات)`;

const CURRENCY_ALIASES: Record<string, string> = {
  USD: "USD",
  SYP: "SYP",
  MAD: "DIRHAM",
  AED: "DIRHAM",
  SAR: "RIYAL",
  QAR: "RIYAL",
  OMR: "RIYAL",
  YER: "RIYAL",
  JOD: "DINAR",
  IQD: "DINAR",
  KWD: "DINAR",
  BHD: "DINAR",
  LYD: "DINAR",
  TND: "DINAR",
  DZD: "DINAR",
  EGP: "EGP",
};

/** رمز عملة المنتج → مجموعته الموحّدة. */
export function canonicalCurrency(code: string | null | undefined): string | null {
  const raw = (code ?? "").trim();
  if (!raw) return null;
  // العملة قد تُخزَّن عربية («ل.س») أو كرمز ISO — نوحّدها عبر كشف اللهجات.
  const detected = detectCurrencies(raw);
  if (detected.size === 1) return [...detected][0];
  const key = raw.toUpperCase();
  return CURRENCY_ALIASES[key] ?? key;
}

/** كل العائلات النقدية المذكورة بالنص. */
export function detectCurrencies(text: string): Set<string> {
  const found = new Set<string>();
  for (const { canonical, re } of CURRENCY_PATTERNS) {
    if (re.test(text)) found.add(canonical);
  }
  return found;
}

const NUMBER_TOKEN = "[0-9٠-٩۰-۹][0-9٠-٩۰-۹.,٬٫]*";
const SCALE_WORD = "(?:[أا]لف(?:اً|ًا|ا)?|[آا]لاف|مليون|ملايين|k)(?![\\p{L}])";
const PRICE_WORDS =
  "(?:(?:ال)?سعر(?:ه|ها|هم|و|نا)?|بسعر(?:ه|ها)?|(?:ال)?ثمن(?:ه|ها)?|بثمن(?:ه|ها)?|(?:ال)?تكلف[ةه]|بتكلف[ةه]|ب?تكلفت(?:ه|ها))";
/** كلمات ممكن تفصل بين كلمة السعر والرقم: «سعر الحبة 40» · «السعر هو 40». */
const PRICE_FILLERS =
  "(?:(?:[:=\\-–—]|(?:هو|هي|كان|الحب[ةه]|القطع[ةه]|العبو[ةه]|العلب[ةه]|الواحد[ةه]|الوحد[ةه]|فقط|بس)(?![\\p{L}]))\\s*){0,3}(?:بـ?\\s*)?";
const BOUNDARY = "(?<![\\p{L}\\p{N}])";

/** وحدات تدل إن الرقم بعد «بـ/سعر» مش سعر: مقاس · عدد · مدة · نسبة · شهر. */
const NON_PRICE_UNIT = new RegExp(
  "^(?:مل|ملل|ملي|ml|لتر|ليتر|l|غ|غم|غرام|جرام|جم|g|gr|mg|ملغ|ملغم|كغ|كغم|كيلو|كيلوغرام|kg|سم|cm|ملم|mm|متر|m|انش|إنش" +
    "|حب[ةه]|حبات|حبتين|قطع[ةه]|قطع|عبو[ةه]|عبوات|علب[ةه]|علب|كبسول[ةه]|كبسولات|ظرف|ظروف|قنين[ةه]|زجاج[ةه]|وحد[ةه]|وحدات|شخص|[أا]شخاص" +
    "|يوم|[أا]يام|ساع[ةه]|ساعات|دقيق[ةه]|دقائق|[أا]سبوع|[أا]سابيع|شهر|[أا]شهر|سن[ةه]|سنين|سنوات|مر[ةه]|مرات" +
    "|%|٪|بالمي[ةه]|بالمئ[ةه]" +
    "|كانون|شباط|[آا]ذار|نيسان|[أا]يار|حزيران|تموز|[آا]ب|[أا]يلول|تشرين|يناير|فبراير|مارس|[أا]بريل|مايو|يونيو|يوليو|[أا]غسطس|سبتمبر|[أا]كتوبر|نوفمبر|ديسمبر)(?![\\p{L}])",
  "iu"
);

function isNotAPrice(token: string, tail: string): boolean {
  const value = toWesternDigits(token);
  if (/^0\d/.test(value) || value.replace(/\D/g, "").length >= 11) return true; // هاتف
  if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(value)) return true; // تاريخ
  if (/^[/:-][0-9٠-٩۰-۹]/.test(tail)) return true; // 15/10 · 10:30 · 15-10
  return NON_PRICE_UNIT.test(tail.trimStart());
}

/**
 * كل المبالغ المذكورة كأسعار بالنص (بقيمتها الرقمية):
 * ملاصقة لعملة قبلها أو بعدها، أو بعد كلمة سعر («سعره 40» · «بـ 40»)،
 * مع «ألف/مليون» («25 ألف ليرة» = 25000).
 * «بدي 3 حبات» و«50 مل» والهواتف والتواريخ ما بتتأثر.
 */
export function priceAmountsIn(text: string): number[] {
  const re = new RegExp(
    [
      `(?<beforeCur>${NUMBER_TOKEN})\\s*(?<beforeCurScale>${SCALE_WORD})?\\s*${CURRENCY_WORDS}`,
      `${CURRENCY_WORDS}\\s*(?<afterCur>${NUMBER_TOKEN})\\s*(?<afterCurScale>${SCALE_WORD})?`,
      `${BOUNDARY}(?:${PRICE_WORDS}(?![\\p{L}])\\s*${PRICE_FILLERS}|بـ\\s*|ب(?=[0-9٠-٩۰-۹]))(?<afterWord>${NUMBER_TOKEN})\\s*(?<afterWordScale>${SCALE_WORD})?`,
    ].join("|"),
    "giu"
  );
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const g = m.groups ?? {};
    const token = g.beforeCur ?? g.afterCur ?? g.afterWord;
    if (!token) continue;
    const scale = g.beforeCurScale ?? g.afterCurScale ?? g.afterWordScale;
    if (g.afterWord && !scale && isNotAPrice(token, text.slice(re.lastIndex))) continue;
    const value = parsePriceValue(token);
    if (value === null) continue;
    out.push(applyScale(value, scale));
  }
  return out;
}

/** الأجوبة والمقتطفات اللي انبعتت للموديل بهالرد — الأسئلة نفسها مش مصدر. */
function groundedSourceText(context: AIContext | null | undefined): string {
  if (!context) return "";
  return [
    ...(context.product?.faqs ?? []).map((f) => f.answer),
    ...(context.knowledge?.faqs ?? []).map((f) => f.answer),
    ...(context.knowledge?.documents ?? []).map((d) => d.content),
  ].join("\n");
}

/**
 * كل مبلغ ممكن بنص موثوق، حتى لو بلا كلمة سعر («رسوم التوصيل: 5»).
 * المدد والمقاسات والهواتف والتواريخ مش مبالغ: «خلال 3 أيام» ما بتسمح بـ«3 دولار».
 */
function groundedAmountsIn(text: string): number[] {
  const re = new RegExp(
    `(?<![0-9٠-٩۰-۹.,٬٫])(?<token>${NUMBER_TOKEN})\\s*(?<scale>${SCALE_WORD})?`,
    "giu"
  );
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const { token, scale } = m.groups ?? {};
    if (!scale && isNotAPrice(token, text.slice(re.lastIndex))) continue;
    const value = parsePriceValue(token);
    if (value !== null) out.push(applyScale(value, scale));
  }
  return out;
}

function applyScale(value: number, scale: string | undefined): number {
  if (!scale) return value;
  return value * (/ملي/.test(scale) ? 1_000_000 : 1_000);
}

function priceKey(value: number): string {
  return value.toFixed(2);
}

function toWesternDigits(s: string): string {
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
  const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
  return s
    .replace(/[٠-٩]/g, (d) => String(arabicDigits.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(persianDigits.indexOf(d)));
}

/**
 * قراءة رقمية للمبلغ: 25.00 = 25، و2.5 ≠ 25. الفاصلة/النقطة قبل 3 أرقام
 * = فاصل آلاف (150,000 · 150.000) لأن الأسعار ما فيها أكتر من خانتين عشريتين.
 */
function parsePriceValue(raw: string): number | null {
  let s = toWesternDigits(raw).replace(/\s/g, "").replace(/٬/g, "").replace(/٫/g, ".").replace(/[.,،]+$/, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? "," : ".";
    s = s.split(decimal === "," ? "." : ",").join("").replace(",", ".");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const parts = s.split(sep);
    s = parts.length === 2 && parts[1].length !== 3 ? parts.join(".") : parts.join("");
  }
  const value = Number(s);
  return Number.isFinite(value) ? value : null;
}

function normalizeNumber(s: string): string {
  // Digits only, for comparing contact numbers (prices use parsePriceValue).
  return toWesternDigits(s).replace(/[.,،٬\s]/g, "");
}
