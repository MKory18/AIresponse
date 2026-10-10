/**
 * Privacy gate — the single choke point between customer PII and external AI
 * models (سيستم 7 — P1).
 *
 * Contract:
 * - Every outbound call to an EXTERNAL model passes through `sendProtected*`.
 * - Known PII (name/phone/email/address) is replaced with opaque per-call
 *   tokens (`[PII-1]`…). The vault lives in the closure of ONE call only:
 *   never logged, never stored, never shared across conversations.
 * - The model reply is restored LOCALLY from the vault (trusted originals),
 *   so the model can never invent contact details: any phone-like run that
 *   did not come from the vault is redacted before use.
 * - Unknown provider delivery, masking failure, or policy uncertainty →
 *   PrivacyError (non-retryable) and NO external call is made (fail-closed).
 * - `local` (mock/test) and `internal` (self-hosted, B3 policy) providers
 *   bypass masking BY DESIGN: nothing leaves the process/host. Delivery is a
 *   declared connection property — never inferred from the provider name.
 *
 * Arabic + Arabic-Indic digits (٠-٩, ۰-۹) are first-class: detection
 * normalizes them, originals are always restored byte-identical.
 */

import {
  AIProviderError,
  type AIProvider,
  type AIResponse,
  type StructuredRequest,
  type TextRequest,
  type VisionRequest,
} from "./provider";

export type ProviderDelivery = "external" | "internal" | "local";

export interface CustomerPII {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
}

export interface ProtectionOpts {
  /** Known customer PII → replaced with per-call tokens. */
  pii?: CustomerPII;
  /** Extra trusted contact strings allowed verbatim in replies (normalized). */
  trustedContacts?: string[];
  /**
   * P1.1: trusted non-contact numbers (product prices, order totals) that may
   * legitimately appear in replies — exempt from contact scrubbing so price
   * fidelity never depends on redaction round-trips.
   */
  allowedNumbers?: Array<string | number>;
  /** Stable purpose label for safe (PII-free) diagnostics. */
  purpose?: string;
}

/** Fail-closed: safe message only — never carries customer data. */
export class PrivacyError extends AIProviderError {
  constructor(reason: string, purpose?: string) {
    super(`PRIVACY_GATE_REFUSED${purpose ? `:${purpose}` : ""}: ${reason}`, {
      retryable: false,
    });
    this.name = "PrivacyError";
  }
}

interface VaultEntry {
  token: string;
  original: string;
  normalized: string;
}

export interface PrivacyVault {
  entries: VaultEntry[];
}

const MAX_VAULT_ENTRIES = 50;
const REDACTED_CONTACT = "[محجوب]";
const TOKEN_RE = /\[PII-(\d+)\]/g;

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Normalize all supported digit shapes to ASCII 0-9 (detection only). */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)));
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Phone SHAPE (not every digit run): a separator, a leading +/0, or ≥9
// digits. Plain 7–8 digit runs (prices, quantities) are left intact so price
// fidelity never depends on token round-tripping — UNLESS they match a known
// phone (variant spellings) or sit in phone context (P1.1), or strict mode
// applies (reply-side scrubbing with an explicit allowlist).
const PHONE_CANDIDATE_RE = /[+]?[0-9٠-٩۰-۹][0-9٠-٩۰-۹\s\-()./]{5,}[0-9٠-٩۰-۹]/g;
// Bare digit runs (all digit shapes) — evaluated by the context/known rules.
const BARE_RUN_RE = /[0-9٠-٩۰-۹]{7,}/g;

// Words signalling a phone number nearby (AR/EN). Safety bias: when phone
// context is present the run is masked even if order words also appear.
const PHONE_CONTEXT_RE = /(رقم|هاتف|جوال|موبايل|خلوي|تلفون|تليفون|اتصل|اتصلي|كلمني|كلميني|تواصل|واتس|phone|mobile|tel\b|call me|رقمك|هاتفك|جوالك)/i;
// Words signalling a non-contact number (price/order/total).
const ORDER_CONTEXT_RE = /(طلب|فاتورة|order|مبلغ|سعر|السعر|الإجمالي|اجمالي|حساب|invoice|total|price)/i;
const CONTEXT_WINDOW = 25;

function digitCount(s: string): number {
  const m = normalizeDigits(s).match(/[0-9]/g);
  return m ? m.length : 0;
}

/** ASCII digits only (all shapes normalized, separators stripped). */
export function normalizePhoneDigits(s: string): string {
  return normalizeDigits(s).replace(/[^0-9]/g, "");
}

function hasPhoneContext(text: string, start: number, length: number): boolean {
  const window = text.slice(Math.max(0, start - CONTEXT_WINDOW), start + length + CONTEXT_WINDOW);
  return PHONE_CONTEXT_RE.test(window);
}

function hasOrderOnlyContext(text: string, start: number, length: number): boolean {
  const window = text.slice(Math.max(0, start - CONTEXT_WINDOW), start + length + CONTEXT_WINDOW);
  return ORDER_CONTEXT_RE.test(window) && !PHONE_CONTEXT_RE.test(window);
}

function isPhoneShaped(raw: string): boolean {
  const digits = digitCount(raw);
  if (digits < 7) return false;
  const t = raw.trim();
  if (/^[+\s(]*[+0٠۰]/.test(t)) return true; // +… / 0… prefix
  if (/[\s\-.()/]/.test(t)) return true; // separators
  return digits >= 9; // long bare run
}

export interface CandidateOpts {
  /** Normalized known-phone digit strings — matched in ANY spelling. */
  knownPhones?: string[];
  /** Also accept bare 7–8 runs sitting in phone context. */
  contextAware?: boolean;
  /** Reply-side strictness: suspect every bare 7–8 run (needs allowlist). */
  strictBare?: boolean;
}

function matchesKnownPhone(candidateDigits: string, knownPhones: string[]): boolean {
  if (!candidateDigits) return false;
  for (const known of knownPhones) {
    if (!known) continue;
    if (candidateDigits === known) return true;
    // Country-prefixed spelling of the same number (+222 12…): allow a
    // 1–4 digit country prefix, nothing else.
    if (
      candidateDigits.length > known.length &&
      candidateDigits.length - known.length <= 4 &&
      candidateDigits.endsWith(known)
    ) {
      return true;
    }
  }
  return false;
}

export function findPhoneCandidates(text: string, opts: CandidateOpts = {}): string[] {
  const { knownPhones = [], contextAware = false, strictBare = false } = opts;
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (cand: string) => {
    const c = cand.trim();
    if (!c || seen.has(c)) return;
    seen.add(c);
    out.push(c);
  };
  for (const m of text.matchAll(PHONE_CANDIDATE_RE)) {
    const cand = m[0].trim();
    if (cand.startsWith("[PII-")) continue;
    if (!isPhoneShaped(cand)) continue;
    push(cand);
  }
  // Bare 7–8 runs: only by known-phone equality, phone context, or strictness.
  for (const m of text.matchAll(BARE_RUN_RE)) {
    const cand = m[0];
    const digits = digitCount(cand);
    if (digits < 7 || digits > 8) continue;
    if (cand.startsWith("[PII-")) continue;
    const idx = m.index ?? 0;
    if (knownPhones.length && matchesKnownPhone(normalizePhoneDigits(cand), knownPhones)) {
      push(cand);
      continue;
    }
    if (strictBare) {
      // Reply-side: suspect unless the caller allowlists it. Order-only
      // context ("الإجمالي 12345678") still exempts — prices must survive.
      if (!hasOrderOnlyContext(text, idx, cand.length)) push(cand);
      continue;
    }
    if (contextAware && hasPhoneContext(text, idx, cand.length)) push(cand);
  }
  // Spaced/dashed/Indic spellings of KNOWN phones (generic regex misses
  // nothing here because separators are included — this pass normalizes).
  if (knownPhones.length) {
    for (const m of text.matchAll(/[+\d٠-٩۰-۹][\d٠-٩۰-۹\s\-()./]{5,}[\d٠-٩۰-۹]/g)) {
      const cand = m[0].trim();
      if (cand.startsWith("[PII-") || seen.has(cand)) continue;
      if (matchesKnownPhone(normalizePhoneDigits(cand), knownPhones)) push(cand);
    }
  }
  return out;
}

/** Normalized known-phone digit strings from a PII set (length ≥ 6). */
export function knownPhoneDigits(pii: CustomerPII = {}): string[] {
  const out: string[] = [];
  if (pii.phone) {
    const d = normalizePhoneDigits(pii.phone);
    if (d.length >= 6) out.push(d);
  }
  return out;
}

/**
 * Deterministic phone extraction from ORIGINAL text (authoritative for the
 * order pipeline — the rules engine decides, the model only suggests).
 * Prefers 0-prefixed numbers (local mobile/landline shapes).
 */
export function extractPhoneDeterministic(text: string): string | null {
  const cands = findPhoneCandidates(text, { contextAware: true });
  if (!cands.length) return null;
  const local = cands.find((c) => /^[0٠۰]/.test(normalizeDigits(c).replace(/^\+/, "")) || /^[0٠۰]/.test(c.trim()));
  return normalizeDigits(local ?? cands[0]).replace(/[^0-9]/g, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceWholeWord(haystack: string, needle: string, token: string): string {
  // Unicode-aware whole-word replacement (Arabic has no case to fold).
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}(?=$|[^\\p{L}\\p{N}_])`, "gu");
  return haystack.replace(re, `$1${token}`);
}

/**
 * Replace known PII + phone/email shapes with per-call tokens.
 * Throws PrivacyError on invalid input (fail-closed — no partial masking).
 */
export function protectText(
  text: string,
  pii: CustomerPII = {},
  purpose?: string
): { text: string; vault: PrivacyVault } {
  if (typeof text !== "string") {
    throw new PrivacyError("unmaskable input (non-string prompt)", purpose);
  }
  const fail = (why: string): never => {
    throw new PrivacyError(why, purpose);
  };
  const vault: PrivacyVault = { entries: [] };
  let out = text;
  const put = (original: string): string => {
    if (vault.entries.length >= MAX_VAULT_ENTRIES) {
      fail("PII volume exceeds per-call vault budget — refusing rather than partially masking");
    }
    const token = `[PII-${vault.entries.length + 1}]`;
    vault.entries.push({ token, original, normalized: normalizeDigits(original).replace(/[^0-9a-zA-Z]/g, "") });
    return token;
  };

  // Longest-first so overlapping values (phone inside address) stay consistent.
  const known: string[] = [];
  if (pii.phone && normalizeDigits(pii.phone).replace(/[^0-9]/g, "").length >= 6) known.push(pii.phone);
  if (pii.email && pii.email.includes("@")) known.push(pii.email);
  if (pii.address && pii.address.trim().length >= 4) known.push(pii.address);
  if (pii.name && pii.name.trim().length >= 2) known.push(pii.name);
  known.sort((a, b) => b.length - a.length);
  for (const value of known) {
    if (!out.includes(value)) continue;
    const token = put(value);
    out = value.length <= 30 ? replaceWholeWord(out, value, token) : out.split(value).join(token);
    // Fallback for values embedded without word boundaries (digits in URLs etc.).
    if (out.includes(value)) out = out.split(value).join(token);
  }

  // Generic shapes the caller did not declare (typed-but-unknown numbers),
  // plus spaced/dashed/Indic spellings of the KNOWN phone and bare runs in
  // phone context (P1.1 — the required formats).
  const knownDigits = knownPhoneDigits(pii);
  for (const cand of findPhoneCandidates(out, { knownPhones: knownDigits, contextAware: true })) {
    if (cand.startsWith("[PII-")) continue;
    const token = put(cand);
    out = out.split(cand).join(token);
  }
  out = out.replace(EMAIL_RE, (m) => {
    if (m.startsWith("[PII-")) return m;
    return put(m);
  });
  return { text: out, vault };
}

/** Restore vault tokens from trusted originals (local only). */
export function restoreText(text: string, vault: PrivacyVault): string {
  if (typeof text !== "string" || !vault) return text;
  let out = text;
  // Tokens are fixed-width `[PII-N]`; longest-first is a no-op safeguard.
  const ordered = [...vault.entries].sort((a, b) => b.token.length - a.token.length);
  for (const e of ordered) {
    if (out.includes(e.token)) out = out.split(e.token).join(e.original);
  }
  return out;
}

/** Deep token restore for structured (JSON) model outputs. */
export function restoreTokensDeep<T>(value: T, vault: PrivacyVault): T {
  if (typeof value === "string") return restoreText(value, vault) as T;
  if (Array.isArray(value)) return value.map((v) => restoreTokensDeep(v, vault)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = restoreTokensDeep(v, vault);
    return out as T;
  }
  return value;
}

/**
 * Redact phone-like runs / emails that did NOT come from the vault
 * (model-hallucinated contact details). Trusted = vault originals +
 * explicit trustedContacts + allowedNumbers (prices/totals). Reply-side
 * runs strict: every bare 7–8 run is suspect unless allowlisted or saved
 * by order-only context (prices must survive).
 */
export function scrubUntrustedContacts(
  text: string,
  vault: PrivacyVault,
  trustedContacts: string[] = [],
  allowedNumbers: Array<string | number> = []
): string {
  if (typeof text !== "string") return text;
  const allowed = new Set<string>();
  for (const e of vault.entries) {
    const d = normalizeDigits(e.original).replace(/[^0-9]/g, "");
    if (d.length >= 7) allowed.add(d);
    allowed.add(e.original.trim());
  }
  for (const c of trustedContacts) {
    const d = normalizeDigits(c).replace(/[^0-9]/g, "");
    if (d.length >= 7) allowed.add(d);
    if (String(c).trim()) allowed.add(String(c).trim());
  }
  for (const n of allowedNumbers) {
    const d = normalizePhoneDigits(String(n));
    if (d.length >= 7) allowed.add(d);
    if (String(n).trim()) allowed.add(String(n).trim());
  }
  let out = text;
  for (const cand of findPhoneCandidates(out, { strictBare: true })) {
    const d = normalizeDigits(cand).replace(/[^0-9]/g, "");
    if (!allowed.has(d) && !allowed.has(cand.trim())) {
      out = out.split(cand).join(REDACTED_CONTACT);
    }
  }
  out = out.replace(EMAIL_RE, (m) => (allowed.has(m.trim()) ? m : REDACTED_CONTACT));
  return out;
}

/** Short, static privacy directive appended to external system prompts. */
export function privacyDirective(): string {
  return [
    "ملاحظة خصوصية ملزمة: الرموز مثل [PII-1] عناصر نائبة لبيانات خاصة — انسخها كما هي دون تغيير.",
    "يُمنع اختراع أرقام هواتف أو عناوين أو بيانات اتصال غير واردة في السياق.",
  ].join("\n");
}

/** Delivery classifier — declared connection property, never name sniffing. */
export function requiresMasking(provider: AIProvider): boolean {
  const delivery = (provider as unknown as { delivery?: unknown }).delivery;
  if (delivery === "external") return true;
  if (delivery === "internal" || delivery === "local") return false;
  throw new PrivacyError("unknown provider delivery — refusing external call");
}

function gateLogSafe(_msg: string): void {
  // Intentionally no-op: the gate never logs prompts, vaults, or originals.
}

export async function sendProtectedText(
  provider: AIProvider,
  req: TextRequest,
  opts: ProtectionOpts = {}
): Promise<AIResponse> {
  const purpose = opts.purpose ?? "AI_CALL";
  if (!requiresMasking(provider)) {
    gateLogSafe("local/internal send");
    return provider.generateText(req);
  }
  let combined: { system: string; user: string; vault: PrivacyVault };
  try {
    combined = protectCombined(req.system, req.user, opts.pii, purpose);
    const res = await provider.generateText({
      ...req,
      system: `${combined.system}\n\n${privacyDirective()}`,
      user: combined.user,
    });
    const restored = restoreText(res.text, combined.vault);
    return { ...res, text: scrubUntrustedContacts(restored, combined.vault, opts.trustedContacts, opts.allowedNumbers) };
  } catch (err) {
    if (err instanceof PrivacyError) throw err;
    if (err instanceof AIProviderError) throw err;
    throw new PrivacyError("masking pipeline failure — external call aborted", purpose);
  }
}

/** Protect system+user with ONE vault (unique token ids per call). */
function protectCombined(
  system: string,
  user: string,
  pii: CustomerPII | undefined,
  purpose: string
): { system: string; user: string; vault: PrivacyVault } {
  const vault: PrivacyVault = { entries: [] };
  const protectOne = (text: string): string => {
    if (typeof text !== "string") throw new PrivacyError("unmaskable input (non-string prompt)", purpose);
    let out = text;
    const put = (original: string): string => {
      if (vault.entries.length >= MAX_VAULT_ENTRIES) {
        throw new PrivacyError("PII volume exceeds per-call vault budget — refusing rather than partially masking", purpose);
      }
      const token = `[PII-${vault.entries.length + 1}]`;
      vault.entries.push({ token, original, normalized: "" });
      return token;
    };
    const known: string[] = [];
    const src = pii ?? {};
    if (src.phone && normalizeDigits(src.phone).replace(/[^0-9]/g, "").length >= 6) known.push(src.phone);
    if (src.email && src.email.includes("@")) known.push(src.email);
    if (src.address && src.address.trim().length >= 4) known.push(src.address);
    if (src.name && src.name.trim().length >= 2) known.push(src.name);
    known.sort((a, b) => b.length - a.length);
    for (const value of known) {
      if (!out.includes(value)) continue;
      const token = put(value);
      out = replaceWholeWord(out, value, token);
      if (out.includes(value)) out = out.split(value).join(token);
    }
    const knownDigits = knownPhoneDigits(pii);
    for (const cand of findPhoneCandidates(out, { knownPhones: knownDigits, contextAware: true })) {
      if (cand.startsWith("[PII-")) continue;
      out = out.split(cand).join(put(cand));
    }
    out = out.replace(EMAIL_RE, (m) => (m.startsWith("[PII-") ? m : put(m)));
    return out;
  };
  const ps = protectOne(system);
  const pu = protectOne(user);
  return { system: ps, user: pu, vault };
}

export async function sendProtectedStructured<T>(
  provider: AIProvider,
  req: StructuredRequest<T>,
  opts: ProtectionOpts = {}
): Promise<AIResponse & { value: T }> {
  const purpose = opts.purpose ?? "AI_STRUCTURED_CALL";
  if (!requiresMasking(provider)) {
    gateLogSafe("local/internal send");
    return provider.generateStructured(req);
  }
  try {
    const combined = protectCombined(req.system, req.user, opts.pii, purpose);
    const res = await provider.generateStructured<T>({
      ...req,
      system: `${combined.system}\n\n${privacyDirective()}\n\nRespond with a single valid JSON object only. No markdown, no commentary.`,
      user: combined.user,
      validate: req.validate,
    });
    // NOTE: validation ran on masked text (tokens satisfy the string
    // schemas); restore trusted originals AFTER validation.
    const restored = restoreTokensDeep<T>(res.value, combined.vault);
    return { ...res, value: scrubStructuredContacts(restored, combined.vault, opts.trustedContacts, opts.allowedNumbers) };
  } catch (err) {
    if (err instanceof PrivacyError) throw err;
    if (err instanceof AIProviderError) throw err;
    throw new PrivacyError("masking pipeline failure — external call aborted", purpose);
  }
}

/** Apply contact scrubbing to every string inside a structured result. */
function scrubStructuredContacts<T>(value: T, vault: PrivacyVault, trusted: string[] = [], allowedNumbers: Array<string | number> = []): T {
  if (typeof value === "string") return scrubUntrustedContacts(value, vault, trusted, allowedNumbers) as T;
  if (Array.isArray(value)) return value.map((v) => scrubStructuredContacts(v, vault, trusted, allowedNumbers)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubStructuredContacts(v, vault, trusted, allowedNumbers);
    return out as T;
  }
  return value;
}

/** Generic-pattern scrub for embedding inputs (no restoration needed). */
export function scrubForEmbedding(text: string): string {
  if (typeof text !== "string") throw new PrivacyError("unmaskable embedding input");
  let out = text;
  for (const cand of findPhoneCandidates(out, { contextAware: true })) {
    out = out.split(cand).join(REDACTED_CONTACT);
  }
  out = out.replace(EMAIL_RE, REDACTED_CONTACT);
  return out;
}
