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
    const n = normalizeNumber(String(v ?? ""));
    if (n) allowedPriceValues.add(n);
  };
  for (const n of allowedNumbers) addAllowed(n);
  if (context?.product) {
    addAllowed(context.product.price);
    addAllowed(context.product.compareAtPrice ?? "");
    for (const tier of context.product.priceTiers ?? []) addAllowed(tier.price);
  }

  const mentionedCurrencies = detectCurrencies(response);
  const productCurrency = context?.product ? canonicalCurrency(context.product.currency) : null;
  if (mentionedCurrencies.size > 0 && productCurrency) {
    if (!mentionedCurrencies.has(productCurrency)) violations.push("CURRENCY_MISMATCH");
  }

  const priced = numbersAdjacentToCurrency(response);
  if (priced.length > 0) {
    if (!context?.product) {
      // بلا منتج موثوق: أي سعر مذكور = اختراع.
      violations.push("UNSUPPORTED_PRICE");
    } else {
      for (const raw of priced) {
        if (!allowedPriceValues.has(normalizeNumber(raw))) {
          violations.push("PRICE_MISMATCH");
          break;
        }
      }
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

/** لهجات العملات → مجموعة موحّدة للمقارنة (عربي + ISO). */
const CURRENCY_PATTERNS: { canonical: string; re: RegExp }[] = [
  { canonical: "USD", re: /(?:\$|USD|دولار|دولارات)/i },
  { canonical: "SYP", re: /(?:SYP|ل\.?\s?س|لير[ةه]|ليرات)/i },
  { canonical: "DIRHAM", re: /(?:MAD|AED|درهم|دراهم)/i },
  { canonical: "RIYAL", re: /(?:SAR|QAR|OMR|YER|ريال|ريالات)/i },
  { canonical: "DINAR", re: /(?:JOD|IQD|KWD|BHD|LYD|TND|DZD|دينار|دنانير)/i },
  { canonical: "EGP", re: /(?:EGP|جنيه|جنيهات)/i },
];

const CURRENCY_WORDS =
  "(?:USD|SYP|MAD|AED|SAR|QAR|OMR|YER|JOD|IQD|KWD|BHD|LYD|TND|DZD|EGP|\\$|ل\\.?\\s?س|دولار|دولارات|درهم|دراهم|ريال|ريالات|دينار|دنانير|لير[ةه]|ليرات|جنيه|جنيهات)";

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

/**
 * الأرقام الملاصقة لعملة (قبل أو بعد) — هذي أسعار، مش كميات.
 * «بدي 3 حبات» ما بتتأثر؛ «25 درهم» بتنكشف.
 */
export function numbersAdjacentToCurrency(text: string): string[] {
  const re = new RegExp(
    `([0-9٠-٩۰-۹][0-9٠-٩۰-۹.,٬]*)\\s*${CURRENCY_WORDS}|${CURRENCY_WORDS}\\s*([0-9٠-٩۰-۹][0-9٠-٩۰-۹.,٬]*)`,
    "gi"
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = m[1] ?? m[2];
    if (value) out.push(value);
  }
  return out;
}

function normalizeNumber(s: string): string {
  // Convert Arabic-Indic + Persian digits and strip separators for comparison.
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
  const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
  const converted = s
    .replace(/[٠-٩]/g, (d) => String(arabicDigits.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(persianDigits.indexOf(d)));
  return converted.replace(/[.,،٬\s]/g, "");
}
