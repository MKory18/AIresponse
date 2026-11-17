import { findPhoneCandidates } from "@/modules/ai/privacy-gate";
import { isGrounded } from "@/modules/intelligence/fields";
import { matchProductByName, normalizeProductName, type NameCandidate } from "@/modules/products/name-match";
import { DEFAULT_MAX_ORDER_QUANTITY, PROVINCES_BY_MARKET, KNOWN_PROVINCES, normalizePhone, parseQuantity, toWesternDigits } from "../primitives";
import type { OrderFieldKey } from "../required-fields";
import type { OrderReading } from "./schema";
import type { ReaderMessage } from "./transcript";

/**
 * التحقق الحتمي — «الموديل يقترح، هذا الملف يقرر» (02-ORDER-FLOW §7.5).
 * نقي: كل ما يلزم (الكتالوج · المحافظات · الرسوم) بيجي جاهز بالـ context من
 * القاعدة؛ هون ما في قراءة ولا كتابة. السعر دايمًا من الكتالوج مش من الموديل.
 */

export type ReaderStage = "NONE" | "INTERESTED" | "COLLECTING" | "COMPLETE" | "CANCELLED";

export type ReviewFlag =
  | "PRODUCT_AMBIGUOUS"
  | "PRODUCT_UNKNOWN"
  | "PHONE_INVALID"
  | "PHONE_AMBIGUOUS"
  | "QUANTITY_UNGROUNDED"
  | "AREA_UNKNOWN"
  | "AREA_NOT_SERVED"
  | "OUT_OF_STOCK"
  | "PRODUCT_INACTIVE"
  | "EXCEEDS_MAX"
  | "DUPLICATE_LIKELY"
  | "CUSTOMER_BLACKLISTED"
  | "NO_AGREEMENT"
  | "LOW_CONFIDENCE"
  | "AI_CLAIMED_NO_ORDER";

export type MissingField = "product" | "quantity" | "phone" | "address" | "name";

export interface CatalogProduct {
  id: string;
  name: string;
  sku?: string | null;
  /** السعر من قاعدة البيانات (رقم عشري). */
  price: number;
  currency: string;
  aliases?: string[];
  isActive?: boolean;
  inStock?: boolean;
}

export interface VerifyContext {
  /** من buildTranscript — المعرّفات المحلية m1…mN. */
  messages: ReaderMessage[];
  /** `Channel.market` (SY · JO) أو null. */
  market: string | null;
  /** منتجات الصفحة المسموحة فقط. */
  products: CatalogProduct[];
  required: OrderFieldKey[];
  /** أسماء مناطق التوصيل المضبوطة (فاضي = ما في قواعد). */
  deliveryProvinces?: string[];
  /** اسم بروفايل العميل — بيعوّض الاسم الناقص. */
  customerName?: string | null;
  isBlacklisted?: boolean;
  maxQuantity?: number;
  agreementPolicy?: "EXPLICIT_OR_IMPLICIT" | "EXPLICIT_ONLY";
  /** رسم التوصيل لمحافظة (من `quoteDelivery`): null = بلا قاعدة. */
  deliveryFee?: (province: string) => { fee: number; available: boolean } | null;
  /** أسباب مراجعة بتحسبها الطبقة اللي معها القاعدة (تكرار · قواعد الطلب…). */
  extraFlags?: ReviewFlag[];
}

export interface VerifiedItem {
  productId: string;
  sku: string | null;
  name: string;
  quantity: number | null;
  unitPrice: number;
  lineTotal: number | null;
  /** معرّفات الرسائل الحقيقية. */
  evidence: string[];
}

export interface UnresolvedItem {
  ref: string;
  reason: "PRODUCT_AMBIGUOUS" | "PRODUCT_UNKNOWN";
  candidates: string[];
}

export interface VerifiedReading {
  stage: ReaderStage;
  relation: OrderReading["relation"];
  items: VerifiedItem[];
  unresolved: UnresolvedItem[];
  recipient: {
    name: string | null;
    phone: string | null;
    altPhone: string | null;
    city: string | null;
    province: string | null;
    address: string | null;
    evidence: Record<string, string[]>;
  };
  totals: { subtotal: number; discount: number; deliveryFee: number; total: number; currency: string | null };
  agreement: { state: OrderReading["agreement"]["state"]; evidence: string[] };
  missing: MissingField[];
  flags: ReviewFlag[];
  openQuestions: string[];
  needsHuman: OrderReading["needsHuman"];
  memories: OrderReading["memories"];
  notes: string | null;
  cancelRequested: boolean;
  aiClaimedConfirmed: boolean;
  confidence: number;
  lastCustomerMessageId: string | null;
  lastCustomerMessageAt: string | null;
}

const money = (n: number) => Math.round(n * 100) / 100;

// ── مساعدات ──────────────────────────────────────────────────────────────

function evidenceFor(ids: string[] | undefined, byLocal: Map<string, ReaderMessage>): string[] {
  const out: string[] = [];
  for (const id of ids ?? []) {
    const m = byLocal.get(id);
    if (m && !out.includes(m.id)) out.push(m.id);
  }
  return out;
}

function matchProvince(text: string | null | undefined, provinces: string[]): string | null {
  if (!text) return null;
  const n = normalizeProductName(text);
  if (!n) return null;
  // الأطول أول: «ريف دمشق» قبل «دمشق».
  const sorted = [...provinces].sort((a, b) => b.length - a.length);
  for (const p of sorted) {
    const np = normalizeProductName(p);
    if (np && (n === np || n.includes(np))) return p;
  }
  return null;
}

interface PhoneCand {
  key: string;
  valid: boolean;
  lastIdx: number;
}

function collectPhones(messages: ReaderMessage[], market: string | null): PhoneCand[] {
  const byKey = new Map<string, PhoneCand>();
  messages.forEach((m, idx) => {
    if (m.role === "AGENT") return;
    for (const raw of findPhoneCandidates(m.text, { contextAware: true })) {
      const norm = normalizePhone(raw, market);
      if (!norm.canonical) continue;
      const prev = byKey.get(norm.canonical);
      byKey.set(norm.canonical, { key: norm.canonical, valid: norm.valid, lastIdx: Math.max(prev?.lastIdx ?? -1, idx) });
    }
  });
  return [...byKey.values()];
}

/**
 * الأرقام الطويلة (هواتف) بتنشال قبل قراءة الكمية: «2 حبة 0964123348 درعا» رسالة عادية
 * وكانت بتنعدّ «كمية ملتبسة» لأن فيها رقمين. مجموعات الأرقام المفصولة بفراغ/شرطة
 * (0964 123 348) بتنضم أول.
 */
export function maskPhoneNumbers(text: string): string {
  return toWesternDigits(text)
    .replace(/(?<=\d{3})[\s\-.](?=\d{3})/g, "")
    .replace(/\d{7,}/g, " ");
}

function quantityGrounded(q: number, customerTexts: string[], max: number): boolean {
  if (q === 1) return true;
  return customerTexts.some((t) => parseQuantity(maskPhoneNumbers(t), { max: Math.max(max, q) }).value === q);
}

/** منتج وحيد ← تمام · أكتر ← ملتبس · ولا واحد ← مجهول. */
function resolveProduct(ref: string, products: CatalogProduct[]): { product?: CatalogProduct; ambiguous: CatalogProduct[] } {
  const candidates: NameCandidate[] = [];
  for (const p of products) {
    candidates.push({ id: p.id, name: p.name });
    for (const a of p.aliases ?? []) candidates.push({ id: p.id, name: a });
  }
  const byId = new Map(products.map((p) => [p.id, p]));
  // الاسم الناقص اللي بيحتويه أكتر من منتج = ملتبس (مش «الأقصر بيفوز»).
  const q = normalizeProductName(ref);
  const normalized = candidates.map((c) => ({ id: c.id, n: normalizeProductName(c.name) })).filter((c) => c.n.length > 0);
  if (q.length >= 2 && !normalized.some((c) => c.n === q || q.includes(c.n))) {
    const containing = new Set(normalized.filter((c) => c.n.includes(q)).map((c) => c.id));
    if (containing.size >= 2) return { ambiguous: [...containing].map((id) => byId.get(id)!).filter(Boolean) };
  }
  const hit = matchProductByName(ref, candidates);
  if (hit) return { product: byId.get(hit.id)! , ambiguous: [] };
  // null = ملتبس أو مجهول: كم منتج بيطابق لحاله؟
  const matching = new Set<string>();
  for (const c of candidates) {
    if (matchProductByName(ref, [c])) matching.add(c.id);
  }
  return { ambiguous: [...matching].map((id) => byId.get(id)!).filter(Boolean) };
}

// ── التحقق ───────────────────────────────────────────────────────────────

export function verifyReading(reading: OrderReading, ctx: VerifyContext): VerifiedReading {
  const flags = new Set<ReviewFlag>(ctx.extraFlags ?? []);
  const byLocal = new Map(ctx.messages.map((m) => [m.localId, m]));
  const idxOf = new Map(ctx.messages.map((m, i) => [m.localId, i]));
  const max = ctx.maxQuantity ?? Number(process.env.MAX_ORDER_QUANTITY ?? DEFAULT_MAX_ORDER_QUANTITY);

  const customerTexts = ctx.messages.filter((m) => m.role === "CUSTOMER").map((m) => m.text);
  const contactText = ctx.messages.filter((m) => m.role !== "AGENT").map((m) => m.text).join("\n");

  // 2) الهاتف
  const cands = collectPhones(ctx.messages, ctx.market);
  const valids = cands.filter((c) => c.valid);
  const modelPhone = reading.customer.phone ? normalizePhone(reading.customer.phone, ctx.market).canonical : null;
  const modelAlt = reading.customer.altPhone ? normalizePhone(reading.customer.altPhone, ctx.market).canonical : null;
  const chosen = modelPhone ? cands.find((c) => c.key === modelPhone) : undefined; // مش بالنص ← undefined (بينشال)
  let phone: string | null = null;
  let altPhone: string | null = null;
  if (chosen) {
    if (!chosen.valid) {
      flags.add("PHONE_INVALID");
    } else {
      phone = chosen.key;
      const others = valids.filter((c) => c.key !== chosen.key);
      const alt = modelAlt ? valids.find((c) => c.key === modelAlt && c.key !== chosen.key) : undefined;
      if (alt) {
        altPhone = alt.key; // رقمين بأدوار واضحة: ما في مراجعة
      } else if (others.length > 0) {
        const latest = Math.max(...valids.map((c) => c.lastIdx));
        if (chosen.lastIdx !== latest) {
          flags.add("PHONE_AMBIGUOUS");
          altPhone = [...others].sort((a, b) => b.lastIdx - a.lastIdx)[0].key;
        }
      }
    }
  } else if (valids.length === 1) {
    phone = valids[0].key;
  } else if (valids.length >= 2) {
    flags.add("PHONE_AMBIGUOUS");
  } else if (cands.length > 0) {
    flags.add("PHONE_INVALID");
  }

  // 3) الاسم · العنوان · المدينة: لازم مكتوبين حرفيًا بكلام العميل/الموظف
  const grounded = (v: string | null | undefined) => (v && v.trim() && isGrounded(v.trim(), contactText) ? v.trim() : null);
  const name = grounded(reading.customer.name);
  const address = grounded(reading.customer.address);
  const city = grounded(reading.customer.city);

  // 4) المحافظة
  const provinceList = ctx.deliveryProvinces && ctx.deliveryProvinces.length > 0 ? ctx.deliveryProvinces : null;
  const marketList = (ctx.market && PROVINCES_BY_MARKET[ctx.market]) || KNOWN_PROVINCES;
  const province = matchProvince(city, provinceList ?? marketList) ?? matchProvince(address, provinceList ?? marketList);
  if (provinceList && !province && (city || address)) flags.add("AREA_UNKNOWN");

  // 5) المنتجات
  const items: VerifiedItem[] = [];
  const unresolved: UnresolvedItem[] = [];
  const impliedOrdering = reading.intent === "ORDERING" || reading.agreement.state === "EXPLICIT" || reading.agreement.state === "IMPLICIT";
  for (const it of reading.items) {
    const { product, ambiguous } = resolveProduct(it.productRef, ctx.products);
    if (!product) {
      if (ambiguous.length >= 2) {
        flags.add("PRODUCT_AMBIGUOUS");
        unresolved.push({ ref: it.productRef, reason: "PRODUCT_AMBIGUOUS", candidates: ambiguous.map((p) => p.name) });
      } else {
        flags.add("PRODUCT_UNKNOWN");
        unresolved.push({ ref: it.productRef, reason: "PRODUCT_UNKNOWN", candidates: [] });
      }
      continue;
    }
    // 6) الكمية
    let quantity: number | null = it.quantity;
    if (quantity === null) {
      quantity = impliedOrdering ? 1 : null;
    } else if (!quantityGrounded(quantity, customerTexts, max)) {
      flags.add("QUANTITY_UNGROUNDED");
      quantity = null;
    }
    if (quantity !== null && quantity > max) flags.add("EXCEEDS_MAX");
    if (product.isActive === false) flags.add("PRODUCT_INACTIVE");
    if (product.inStock === false) flags.add("OUT_OF_STOCK");
    const evidence = evidenceFor(it.evidence, byLocal);
    const evMax = Math.max(-1, ...(it.evidence ?? []).map((e) => idxOf.get(e) ?? -1));
    const existing = items.findIndex((x) => x.productId === product.id);
    const built: VerifiedItem = {
      productId: product.id,
      sku: product.sku ?? null,
      name: product.name,
      quantity,
      unitPrice: product.price,
      lineTotal: quantity === null ? null : money(product.price * quantity),
      evidence,
    };
    if (existing >= 0) {
      // عنصرين لنفس المنتج بيندمجوا: الكمية = الأحدث دليلًا (مش مجموع).
      const prevEv = Math.max(-1, ...items[existing].evidence.map((id) => ctx.messages.findIndex((m) => m.id === id)));
      if (evMax >= prevEv) items[existing] = { ...built, evidence: [...new Set([...items[existing].evidence, ...evidence])] };
      else items[existing].evidence = [...new Set([...items[existing].evidence, ...evidence])];
    } else {
      items.push(built);
    }
  }

  // 7) الموافقة: لازم دليلها رسالة عميل
  const agreementEvidence = evidenceFor(reading.agreement.evidence, byLocal);
  const customerEvidence = agreementEvidence.filter((id) => ctx.messages.find((m) => m.id === id)?.role === "CUSTOMER");
  const agreementState =
    (reading.agreement.state === "EXPLICIT" || reading.agreement.state === "IMPLICIT") && customerEvidence.length === 0
      ? "NONE"
      : reading.agreement.state;

  // 8) قواعد
  if (ctx.isBlacklisted) flags.add("CUSTOMER_BLACKLISTED");

  // 9) التسعير: من الكتالوج، ورسم التوصيل مرة وحدة للطلب
  const priced = items.filter((i) => i.lineTotal !== null);
  const subtotal = money(priced.reduce((s, i) => s + (i.lineTotal ?? 0), 0));
  let deliveryFee = 0;
  if (province && priced.length > 0 && ctx.deliveryFee) {
    const q = ctx.deliveryFee(province);
    if (q) {
      if (!q.available) flags.add("AREA_NOT_SERVED");
      else deliveryFee = money(q.fee);
    }
  }
  const currency = items.length > 0 ? ctx.products.find((p) => p.id === items[0].productId)?.currency ?? null : null;
  const totals = { subtotal, discount: 0, deliveryFee, total: money(subtotal + deliveryFee), currency };

  // 10) الثقة
  if (reading.confidence < 0.6) flags.add("LOW_CONFIDENCE");

  // missing
  const missing: MissingField[] = [];
  for (const f of ctx.required) {
    if (f === "product" && !items.length) missing.push("product");
    else if (f === "quantity" && (items.length === 0 || items.some((i) => i.quantity === null))) missing.push("quantity");
    else if (f === "phone" && !phone) missing.push("phone");
    else if (f === "address" && !address) missing.push("address");
    else if (f === "name" && !name && !ctx.customerName) missing.push("name");
  }

  // 12) stage
  let stage: ReaderStage;
  if (reading.intent === "CANCELLED" || reading.cancelRequested) stage = "CANCELLED";
  else if (reading.intent === "ORDERING") stage = missing.length === 0 ? "COMPLETE" : "COLLECTING";
  else if (reading.intent === "INTERESTED") stage = "INTERESTED";
  else stage = "NONE";

  if (stage === "COMPLETE") {
    const policy = ctx.agreementPolicy ?? "EXPLICIT_OR_IMPLICIT";
    if (agreementState === "NONE" || (policy === "EXPLICIT_ONLY" && agreementState !== "EXPLICIT")) flags.add("NO_AGREEMENT");
  }

  // 11) ادعاء الوكيل
  if (reading.aiClaimedConfirmed && stage !== "COMPLETE") flags.add("AI_CLAIMED_NO_ORDER");

  const lastCustomer = [...ctx.messages].reverse().find((m) => m.role === "CUSTOMER") ?? null;
  const evid: Record<string, string[]> = {};
  for (const [k, ids] of Object.entries(reading.customer.evidence ?? {})) evid[k] = evidenceFor(ids, byLocal);

  return {
    stage,
    relation: reading.relation,
    items,
    unresolved,
    recipient: { name, phone, altPhone, city, province, address, evidence: evid },
    totals,
    agreement: { state: agreementState, evidence: agreementEvidence },
    missing,
    flags: [...flags],
    openQuestions: reading.openQuestions,
    needsHuman: reading.needsHuman,
    memories: reading.memories,
    notes: reading.notes,
    cancelRequested: reading.cancelRequested,
    aiClaimedConfirmed: reading.aiClaimedConfirmed,
    confidence: reading.confidence,
    lastCustomerMessageId: lastCustomer?.id ?? null,
    lastCustomerMessageAt: lastCustomer ? lastCustomer.at.toISOString() : null,
  };
}
