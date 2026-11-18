/** نموذج «المنتجات» (3.4ب) — دوال صرفة: فلاتر الحالة · نبرة المخزون · نص الجاهزية · الحقول المقفولة لما الـ OMS مربوط. */
import type { Tone } from "@/components/ui/status-chip";
import { MISSING_LABELS, type Missing } from "@/modules/products/readiness";
import { PRODUCTS_STRINGS as S } from "./strings";

export type StatusFilter = "active" | "inactive" | "archived" | "incomplete";

export const STATUS_TABS: ReadonlyArray<{ key: StatusFilter; label: string }> = [
  { key: "active", label: "شغّال" },
  { key: "inactive", label: "متوقف" },
  { key: "archived", label: "مؤرشف" },
  { key: "incomplete", label: "ناقصة المحتوى" },
];

export function parseStatus(v: string | null | undefined): StatusFilter {
  return STATUS_TABS.some((t) => t.key === v) ? (v as StatusFilter) : "active";
}

/**
 * المخزون: «متوفر / غير متوفر» بشارة — مش حالة التفعيل بتسمية المخزون (كان تناقض بالقائمة القديمة).
 */
export function stockChip(stockStatus: string): { text: string; tone: Tone } {
  const text = S.stock[stockStatus] ?? stockStatus;
  if (stockStatus === "IN_STOCK") return { text, tone: "success" };
  if (stockStatus === "OUT_OF_STOCK") return { text, tone: "danger" };
  if (stockStatus === "PRE_ORDER") return { text, tone: "info" };
  return { text, tone: "neutral" };
}

export function readinessChip(r: { ready: boolean; missing: Missing[] }): { text: string; tone: Tone } {
  if (r.ready) return { text: S.ready, tone: "success" };
  return { text: `${S.missingPrefix}: ${r.missing.map((m) => MISSING_LABELS[m]).join(" · ")}`, tone: "warning" };
}

/** لما الـ OMS مربوط: الاسم والرمز والسعر والعملة والمخزون للقراءة بس (بتيجي منه). «شو بيقول الوكيل» والصور بتضل قابلة للتعديل. */
export const OMS_LOCKED_FIELDS = ["name", "sku", "price", "compareAtPrice", "currency", "stockStatus", "stockQty", "priceTiers"] as const;

export function isLocked(field: string, omsConnected: boolean): boolean {
  return omsConnected && (OMS_LOCKED_FIELDS as readonly string[]).includes(field);
}
