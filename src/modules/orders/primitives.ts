/**
 * Deterministic order primitives — pure functions, fully unit-testable.
 * The AI may propose values; these decide what actually enters a draft.
 */

// ── Phone normalization ─────────────────────────────────────────────────────

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function toWesternDigits(input: string): string {
  return input.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
}

export interface NormalizedPhone {
  valid: boolean;
  canonical: string; // digits only, normalized local form when clearly Syrian
  reason?: string;
}

/**
 * PhoneNormalizer: tolerant but sane. Keeps digits only, normalizes common
 * Syrian mobile prefixes (+963 / 00963 → 0), validates plausible lengths.
 * Never "corrects" digits — an ambiguous number stays invalid for ordering
 * rather than being guessed.
 */
export function normalizePhone(raw: string): NormalizedPhone {
  let digits = toWesternDigits(raw).replace(/\D/g, "");
  if (!digits) return { valid: false, canonical: "", reason: "EMPTY" };

  if (digits.startsWith("00963")) digits = `0${digits.slice(5)}`;
  else if (digits.startsWith("963") && digits.length >= 12) digits = `0${digits.slice(3)}`;

  if (digits.length < 7) return { valid: false, canonical: digits, reason: "TOO_SHORT" };
  if (digits.length > 15) return { valid: false, canonical: digits, reason: "TOO_LONG" };

  // Syrian mobile: 09XXXXXXXX (9 or 10 digits incl. leading 0)
  if (/^09\d{7,8}$/.test(digits)) return { valid: true, canonical: digits };
  // Landline-ish or international without prefix — accept as plausible.
  if (digits.length >= 7 && digits.length <= 15) return { valid: true, canonical: digits };
  return { valid: false, canonical: digits, reason: "UNRECOGNIZED_FORMAT" };
}

// ── Quantity parsing ────────────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  "واحد": 1, "وحدة": 1, "واحدة": 1,
  "اثنين": 2, "إثنين": 2, "اثنان": 2, "زوج": 2, "قطعتين": 2, "حبتين": 2,
  "ثلاثة": 3, "ثلاث": 3, "ثلاث قطع": 3,
  "أربعة": 4, "اربعة": 4, "أربع": 4,
  "خمسة": 5, "خمس": 5,
  "ستة": 6, "ست": 6,
  "سبعة": 7, "سبع": 7,
  "ثمانية": 8, "ثمان": 8,
  "تسعة": 9, "تسع": 9,
  "عشرة": 10, "عشر": 10,
};

export const DEFAULT_MAX_ORDER_QUANTITY = 100;

export interface ParsedQuantity {
  value: number | null;
  confidence: number;
  reason?: string;
}

/**
 * Parses quantity from Arabic/English text ("3", "٣", "ثلاث قطع", "2 حبات").
 * Rejects zero/negative/decimals/extreme values.
 */
export function parseQuantity(
  text: string,
  opts?: { max?: number; allowDecimals?: boolean }
): ParsedQuantity {
  const max = opts?.max ?? Number(process.env.MAX_ORDER_QUANTITY ?? DEFAULT_MAX_ORDER_QUANTITY);
  const normalized = toWesternDigits(text.toLowerCase());

  // Explicit number with optional unit words (reject negatives explicitly).
  const negative = /(^|\s)-\d/.test(normalized);
  const numeric = normalized.match(/(\d+(?:\.\d+)?)\s*(قطع|حبة|حبات|قطعة|عبوة|عبوات|piece|pieces)?/);
  if (numeric && !negative) {
    const n = Number(numeric[1]);
    if (Number.isInteger(n)) {
      if (n <= 0) return { value: null, confidence: 0.9, reason: "NON_POSITIVE" };
      if (n > max) return { value: null, confidence: 0.95, reason: "EXCEEDS_MAX" };
      return { value: n, confidence: 0.97 };
    }
    if (!opts?.allowDecimals) return { value: null, confidence: 0.9, reason: "DECIMAL_NOT_ALLOWED" };
  }

  // Arabic number words.
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (normalized.includes(word)) {
      if (value > max) return { value: null, confidence: 0.95, reason: "EXCEEDS_MAX" };
      return { value, confidence: 0.9 };
    }
  }

  return { value: null, confidence: 0, reason: "NOT_FOUND" };
}

// ── Confirmation parsing (context-gated — never global) ────────────────────

const YES_PATTERNS = [/^(نعم|أي|اي|أكيد|اكيد|تمام|أكد|اكد|موافق|أجل|اجل|اوكي|ok|yes|sure)(\s|$|[^\p{L}])/u];
const NO_PATTERNS = [/(لا|إلغاء|الغاء|مو هلأ|مو هلق|غيرت رأيي|غيرت رايي|cancel|^no)(\s|$|[^\p{L}])/u];

export interface ConfirmationSignal {
  signal: "YES" | "NO" | "NONE";
  confidence: number;
}

/** ONLY meaningful when called within an order-confirmation context. */
export function parseConfirmation(text: string): ConfirmationSignal {
  const t = text.trim().toLowerCase();
  if (NO_PATTERNS.some((p) => p.test(t))) return { signal: "NO", confidence: 0.9 };
  if (YES_PATTERNS.some((p) => p.test(t))) return { signal: "YES", confidence: 0.9 };
  // "تمام" in a longer sentence is ambiguous — weak yes only if short.
  if (/تمام/.test(t) && t.split(/\s+/).length <= 3) return { signal: "YES", confidence: 0.6 };
  return { signal: "NONE", confidence: 0 };
}

// ── Province inference (deterministic known-list mapping) ──────────────────

export const KNOWN_PROVINCES = [
  "دمشق", "ريف دمشق", "حلب", "حمص", "حماة", "اللاذقية", "طرطوس", "إدلب",
  "دير الزور", "الحسكة", "الرقة", "درعا", "السويداء", "قنيطرة",
];

/** Infers the province from a raw address via known-list containment. */
export function inferProvince(rawAddress: string): string | null {
  const normalized = normalizeName(rawAddress);
  for (const province of KNOWN_PROVINCES) {
    if (normalized.includes(normalizeName(province))) return province;
  }
  return null;
}

// ── Product resolution ──────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return toWesternDigits(name)
    .toLowerCase()
    .replace(/[إأآا]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ResolvableProduct {
  id: string;
  name: string;
  sku: string;
  aliases?: string[];
  isActive: boolean;
  stockStatus: string;
  price: unknown;
  currency: string;
}

export interface ProductResolution {
  status: "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND";
  product?: ResolvableProduct;
  candidates?: ResolvableProduct[];
}

/**
 * ProductResolver: exact SKU → exact name → aliases → normalized name.
 * Controlled fuzzy only via normalized equality/containment; ambiguity is
 * surfaced for clarification instead of guessing.
 */
export function resolveProduct(query: string, products: ResolvableProduct[]): ProductResolution {
  const q = query.trim();
  if (!q) return { status: "NOT_FOUND" };
  const nq = normalizeName(q);

  const bySku = products.find((p) => p.sku.toLowerCase() === q.toLowerCase());
  if (bySku) return { status: "RESOLVED", product: bySku };

  const byName = products.find((p) => p.name.trim() === q);
  const byAlias = products.filter((p) => (p.aliases ?? []).some((a) => a.trim() === q));
  const exact = byName ?? (byAlias.length === 1 ? byAlias[0] : undefined);

  // Guard against prefix-ambiguity: exact match "ماء الكمأة" while
  // "ماء الكمأة الأصلي" also exists → ask, never guess.
  if (exact) {
    const conflicting = products.filter(
      (p) => p.id !== exact.id && normalizeName(p.name).includes(normalizeName(q)) && normalizeName(p.name) !== normalizeName(q)
    );
    if (conflicting.length > 0) return { status: "AMBIGUOUS", candidates: [exact, ...conflicting] };
    return { status: "RESOLVED", product: exact };
  }
  if (byAlias.length > 1) return { status: "AMBIGUOUS", candidates: byAlias };

  const normalizedMatches = products.filter(
    (p) => normalizeName(p.name) === nq || (p.aliases ?? []).some((a) => normalizeName(a) === nq)
  );
  if (normalizedMatches.length === 1) return { status: "RESOLVED", product: normalizedMatches[0] };
  if (normalizedMatches.length > 1) return { status: "AMBIGUOUS", candidates: normalizedMatches };

  // Containment: query contained in exactly one product name (or vice versa).
  const contains = products.filter((p) => {
    const pn = normalizeName(p.name);
    return pn.includes(nq) || nq.includes(pn);
  });
  if (contains.length === 1) return { status: "RESOLVED", product: contains[0] };
  if (contains.length > 1) return { status: "AMBIGUOUS", candidates: contains };

  return { status: "NOT_FOUND" };
}
