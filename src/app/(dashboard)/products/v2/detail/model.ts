/**
 * نموذج صفحة المنتج (3.4ب) — دوال صرفة: المسودة من المنتج · الفرق الوحيد اللي بيتحفظ · الحقول المقفولة لما الـ OMS مربوط.
 * حفظ واحد للصفحة: بنبعت **اللي تغيّر بس** (ما بنكتب فوق حقل ما لمسه المستخدم).
 */
import { isLocked } from "../model";

export type DetailTab = "basic" | "agent" | "images";
export const DETAIL_TABS: ReadonlyArray<{ value: DetailTab; label: string }> = [
  { value: "basic", label: "الأساسي" },
  { value: "agent", label: "شو بيقول الوكيل" },
  { value: "images", label: "الصور" },
];

export interface MediaAsset {
  id: string;
  url: string;
  type: string;
  title: string | null;
}
export interface ProductDetail {
  id: string;
  name: string;
  sku: string;
  description: string | null;
  shortDescription: string | null;
  price: string;
  compareAtPrice: string | null;
  currency: string;
  stockStatus: string;
  stockQty: number;
  category: string | null;
  tags: string[];
  aliases: string[];
  benefits: string[];
  ingredients: string | null;
  usage: string | null;
  warnings: string | null;
  objections: string[];
  salesNotes: string | null;
  isActive: boolean;
  isArchived: boolean;
  syncedFromOms: boolean;
  priceTiers: { id: string; label: string; price: string }[];
  variants: { id: string; name: string; sku: string; price: string; stockQty: number }[];
  mediaLinks: { mediaAsset: MediaAsset; isPrimary: boolean; sortOrder: number }[];
  faqs: { id: string; question: string; answer: string; isActive: boolean }[];
  oms: { connected: boolean };
}

export interface Draft {
  name: string;
  sku: string;
  price: string;
  compareAtPrice: string;
  currency: string;
  stockStatus: string;
  stockQty: string;
  category: string;
  tags: string;
  aliases: string;
  isActive: boolean;
  shortDescription: string;
  description: string;
  benefits: string;
  usage: string;
  warnings: string;
  objections: string;
  ingredients: string;
  salesNotes: string;
  tiers: { label: string; price: string }[];
}

const lines = (a: readonly string[]) => a.join("\n");
export const splitLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export function toDraft(p: ProductDetail): Draft {
  return {
    name: p.name,
    sku: p.sku,
    price: String(Number(p.price)),
    compareAtPrice: p.compareAtPrice === null ? "" : String(Number(p.compareAtPrice)),
    currency: p.currency,
    stockStatus: p.stockStatus,
    stockQty: String(p.stockQty),
    category: p.category ?? "",
    tags: lines(p.tags),
    aliases: lines(p.aliases),
    isActive: p.isActive,
    shortDescription: p.shortDescription ?? "",
    description: p.description ?? "",
    benefits: lines(p.benefits),
    usage: p.usage ?? "",
    warnings: p.warnings ?? "",
    objections: lines(p.objections),
    ingredients: p.ingredients ?? "",
    salesNotes: p.salesNotes ?? "",
    tiers: p.priceTiers.map((t) => ({ label: t.label, price: String(Number(t.price)) })),
  };
}

const tiersKey = (t: Draft["tiers"]) => JSON.stringify(t.filter((x) => x.label.trim() && x.price !== "").map((x) => [x.label.trim(), Number(x.price)]));

/** كل اللي تغيّر، بصيغة الخادم. حقول الـ OMS (لما مربوط) ما بتنبعت أبدًا. */
export function buildPatch(draft: Draft, base: Draft, omsConnected: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const changed = <K extends keyof Draft>(k: K) => draft[k] !== base[k] && !isLocked(String(k), omsConnected);
  const text = (k: "name" | "sku" | "currency" | "stockStatus") => changed(k) && (out[k] = k === "currency" ? draft[k].trim().toUpperCase() : draft[k].trim());
  text("name");
  text("sku");
  text("currency");
  text("stockStatus");
  if (changed("price")) out.price = Number(draft.price);
  if (changed("compareAtPrice")) out.compareAtPrice = draft.compareAtPrice === "" ? null : Number(draft.compareAtPrice);
  if (changed("stockQty")) out.stockQty = Math.max(0, Math.floor(Number(draft.stockQty) || 0));
  for (const k of ["category", "shortDescription", "description", "usage", "warnings", "ingredients", "salesNotes"] as const) {
    if (changed(k)) out[k] = draft[k].trim() === "" ? null : draft[k];
  }
  for (const k of ["tags", "aliases", "benefits", "objections"] as const) {
    if (changed(k)) out[k] = splitLines(draft[k]);
  }
  if (draft.isActive !== base.isActive) out.isActive = draft.isActive;
  if (!isLocked("priceTiers", omsConnected) && tiersKey(draft.tiers) !== tiersKey(base.tiers)) {
    out.priceTiers = draft.tiers.filter((x) => x.label.trim() && x.price !== "").map((x) => ({ label: x.label.trim(), price: Number(x.price) }));
  }
  return out;
}

export function isDirty(draft: Draft, base: Draft, omsConnected: boolean): boolean {
  return Object.keys(buildPatch(draft, base, omsConnected)).length > 0;
}
