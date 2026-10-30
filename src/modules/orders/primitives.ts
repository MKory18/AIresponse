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

export const DEFAULT_MAX_ORDER_QUANTITY = 100;

/**
 * Normalization used ONLY for quantity counting: folds hamza/ta-marbuta and
 * strips diacritics so "أربعة" === "اربعة". Deliberately does NOT strip the
 * definite article "ال", so "الاثنين" (Monday) never collapses onto "اثنين".
 */
function normalizeCounting(input: string): string {
  return toWesternDigits(input)
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ئ]/g, "ي")
    .replace(/[ى]/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

const RAW_UNITS: Record<string, number> = {
  "واحد": 1, "وحدة": 1, "واحده": 1, "واحدة": 1,
  "اثنين": 2, "إثنين": 2, "اثنان": 2, "زوج": 2, "قطعتين": 2, "حبتين": 2,
  "ثلاثة": 3, "ثلاث": 3,
  "أربعة": 4, "اربعة": 4, "أربع": 4,
  "خمسة": 5, "خمس": 5,
  "ستة": 6, "ست": 6,
  "سبعة": 7, "سبع": 7,
  "ثمانية": 8, "ثمان": 8,
  "تسعة": 9, "تسع": 9,
  "عشرة": 10, "عشر": 10,
};

const RAW_TENS: Record<string, number> = {
  "عشرين": 20, "عشرون": 20,
  "ثلاثين": 30, "ثلاثون": 30,
  "أربعين": 40, "اربعين": 40, "أربعون": 40, "اربعون": 40,
  "خمسين": 50, "خمسون": 50,
  "ستين": 60, "ستون": 60,
  "سبعين": 70, "سبعون": 70,
  "ثمانين": 80, "ثمانون": 80, "تمانين": 80, "تمانون": 80,
  "تسعين": 90, "تسعون": 90,
};

const RAW_HUNDREDS: Record<string, number> = {
  "مية": 100, "مئة": 100, "ماءة": 100,
  "مئتين": 200, "مائتين": 200, "ميتين": 200,
};

/** Whole-token number-word lookup (keys folded like the input). */
const NUMBER_WORD: Record<string, number> = {};
for (const table of [RAW_UNITS, RAW_TENS, RAW_HUNDREDS]) {
  for (const [k, v] of Object.entries(table)) NUMBER_WORD[normalizeCounting(k)] = v;
}

export interface ParsedQuantity {
  value: number | null;
  confidence: number;
  reason?: string;
}

/**
 * Parses quantity from Arabic/English text ("3", "٣", "ثلاث قطع", "عشرين").
 * Whole-token matching only: digits must stand alone (so "LG50"/"TW-500" are
 * NOT quantities), number words must be complete words (so "الاثنين"/"استفسار"
 * are NOT quantities). Composite tens/hundreds joined by "و" are summed.
 * Rejects zero/negative/decimals/extreme values and refuses to guess when two
 * unrelated quantities appear.
 */
export function parseQuantity(
  text: string,
  opts?: { max?: number; allowDecimals?: boolean }
): ParsedQuantity {
  const max = opts?.max ?? Number(process.env.MAX_ORDER_QUANTITY ?? DEFAULT_MAX_ORDER_QUANTITY);
  const normalized = normalizeCounting(text);

  // Explicit integers/decimals, but only when bounded by whitespace or the
  // string edges — a digit glued to letters/punctuation is a code, not a qty.
  const digitMatches = [...normalized.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)(?=\s|$)/g)].map((m) => m[1]);
  if (digitMatches.length > 1) return { value: null, confidence: 0.9, reason: "AMBIGUOUS_QUANTITY" };
  if (digitMatches.length === 1) {
    const raw = digitMatches[0];
    if (raw.includes(".")) {
      if (!opts?.allowDecimals) return { value: null, confidence: 0.9, reason: "DECIMAL_NOT_ALLOWED" };
      const d = Number(raw);
      if (d <= 0) return { value: null, confidence: 0.9, reason: "NON_POSITIVE" };
      if (d > max) return { value: null, confidence: 0.95, reason: "EXCEEDS_MAX" };
      return { value: d, confidence: 0.97 };
    }
    const n = Number(raw);
    if (n <= 0) return { value: null, confidence: 0.9, reason: "NON_POSITIVE" };
    if (n > max) return { value: null, confidence: 0.95, reason: "EXCEEDS_MAX" };
    return { value: n, confidence: 0.97 };
  }

  // Arabic number words — whole tokens; "و"-prefixed words continue a composite.
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const found: number[] = [];
  for (const rawToken of tokens) {
    let token = rawToken;
    let joined = false;
    if (token.startsWith("و") && token.length > 1 && NUMBER_WORD[token.slice(1)] !== undefined) {
      token = token.slice(1);
      joined = true;
    }
    const value = NUMBER_WORD[token];
    if (value === undefined) continue;
    if (joined && found.length > 0) found[found.length - 1] += value;
    else found.push(value);
  }

  const distinct = [...new Set(found)];
  if (distinct.length > 1) return { value: null, confidence: 0.9, reason: "AMBIGUOUS_QUANTITY" };
  if (distinct.length === 1) {
    const value = distinct[0];
    if (value > max) return { value: null, confidence: 0.95, reason: "EXCEEDS_MAX" };
    return { value, confidence: 0.9 };
  }

  return { value: null, confidence: 0, reason: "NOT_FOUND" };
}

// ── Confirmation parsing (context-gated — never global) ────────────────────

/** Whole-word signal vocabulary (folded forms; matching via normalizeCounting). */
const YES_WORDS = new Set(
  ["نعم", "اجل", "اكيد", "اكيده", "مؤكد", "موافق", "اوكي", "اوك", "تمام", "صح", "ايه", "ايوه", "ok", "okay", "yes", "sure", "yep", "yup"].map(normalizeCounting)
);
const YES_PHRASES = ["اكد", "اكدلي", "تاكيد", "اكد الطلب", "اكدلي الطلب", "بدي اكد"].map(normalizeCounting);
const NO_WORDS = new Set(
  ["لا", "لاء", "كلا", "مو", "الغاء", "الغي", "الغيه", "no", "cancel"].map(normalizeCounting)
);
const NO_PHRASES = ["لا شكرا", "غيرت رايي", "ما بدي", "مش بدي"].map(normalizeCounting);
const TAMAM = normalizeCounting("تمام");
/** Bare negation words that only refuse when they stand alone at the message end. */
const BARE_NO = [normalizeCounting("لا"), normalizeCounting("مو")];

/** True when `phrase` (space-separated words) appears contiguously in `tokens`. */
function containsPhrase(tokens: string[], phrase: string): boolean {
  const words = phrase.split(" ").filter(Boolean);
  if (words.length === 0) return false;
  for (let i = 0; i + words.length <= tokens.length; i++) {
    if (words.every((w, j) => tokens[i + j] === w)) return true;
  }
  return false;
}

export interface ConfirmationSignal {
  signal: "YES" | "NO" | "UNKNOWN";
  confidence: number;
}

/**
 * Extracts an order-confirmation signal. Whole-token only:
 *  - "لا" is a refusal ONLY as the final/standalone token ("نعم لا" = conflict,
 *    "لا تؤجله" = a negation of another verb → not a refusal).
 *  - "أي/اي" is never a yes.
 *  - Greetings/questions with no signal vocabulary → UNKNOWN.
 *  - Conflicting YES and NO → UNKNOWN.
 * Callers must treat UNKNOWN as "do nothing"; it never creates or cancels.
 */
export function parseConfirmation(text: string): ConfirmationSignal {
  const tokens = normalizeCounting(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokens.length === 0) return { signal: "UNKNOWN", confidence: 0 };

  let yes = false;
  let no = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (YES_WORDS.has(token)) {
      // "تمام" is filler inside a longer sentence → only counts in a short reply.
      if (token !== TAMAM || tokens.length <= 3) yes = true;
    }
    if (NO_WORDS.has(token)) {
      // Bare "لا"/"مو" mid-sentence negate another verb, not the order.
      if (!BARE_NO.includes(token) || i === tokens.length - 1) no = true;
    }
  }
  for (const phrase of YES_PHRASES) if (containsPhrase(tokens, phrase)) yes = true;
  for (const phrase of NO_PHRASES) if (containsPhrase(tokens, phrase)) no = true;

  if (yes && no) return { signal: "UNKNOWN", confidence: 0 };
  if (yes) return { signal: "YES", confidence: 0.9 };
  if (no) return { signal: "NO", confidence: 0.9 };
  return { signal: "UNKNOWN", confidence: 0 };
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
