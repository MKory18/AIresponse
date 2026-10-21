import { z } from "zod";

/**
 * حقول «معلومات العميل المستخرجة» — عقد واحد بين الموديل والواجهة.
 *
 * الحقول قابلة للضبط لكل مساحة: المالك يختار شو بدو يجمّع (اسم · رقم · عنوان ·
 * الطلبية · المنتج · الكمية …) ويمكن يضيف حقولًا خاصة. الاستخراج يطلب الحقول
 * المفعّلة فقط، وأي قيمة غير مذكورة حرفيًا بالنص تُسقط قبل الحفظ.
 *
 * قواعد ثابتة:
 * - الحقل غير المذكور = null (لا اختراع).
 * - مصدر كل معلومة محفوظ بـ fieldMeta، والتعارض يُسجّل ولا يُحسم عشوائيًا.
 * - القيمة المؤكدة من موظف لا يستبدلها أي تحليل لاحق.
 */

export const INTEL_FIELD_KINDS = ["TEXT", "PHONE", "NUMBER", "LIST"] as const;
export type IntelFieldKind = (typeof INTEL_FIELD_KINDS)[number];

export interface IntelFieldDef {
  key: string;
  label: string;
  kind: IntelFieldKind;
  /** ضمن البيانات المطلوب تجميعها (تظهر بنسبة الاكتمال). */
  required: boolean;
}

/** الحقول القياسية المتاحة لأي مساحة — يمكن تعطيلها أو إضافة حقول خاصة فوقها. */
export const INTEL_FIELD_CATALOG: IntelFieldDef[] = [
  { key: "customerName", label: "الاسم", kind: "TEXT", required: true },
  { key: "phone", label: "رقم الهاتف", kind: "PHONE", required: true },
  { key: "city", label: "المدينة", kind: "TEXT", required: false },
  { key: "address", label: "العنوان", kind: "TEXT", required: true },
  { key: "order", label: "الطلبية", kind: "TEXT", required: true },
  { key: "products", label: "المنتج", kind: "LIST", required: true },
  { key: "quantity", label: "الكمية", kind: "NUMBER", required: true },
  { key: "budget", label: "الميزانية / السعر المذكور", kind: "TEXT", required: false },
  { key: "purchaseIntent", label: "نية الشراء", kind: "TEXT", required: false },
  { key: "needs", label: "الأسئلة والاحتياجات", kind: "LIST", required: false },
  { key: "notes", label: "ملاحظات مستخرجة", kind: "LIST", required: false },
];

export const INTEL_FIELD_KEYS: string[] = INTEL_FIELD_CATALOG.map((f) => f.key);

/** مفتاح حقل قابل للتخزين: لاتيني صغير مع أرقام وشرطة سفلية. */
export const INTEL_FIELD_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{1,31}$/;

export type IntelValue = string | number | string[] | null;
export type IntelFields = Record<string, IntelValue>;

const MAX_TEXT = 300;
const MAX_SHORT_TEXT = 200;
const MAX_LIST_ITEMS = 10;

function defaultValue(kind: IntelFieldKind, key: string): IntelValue {
  if (kind === "LIST") return [];
  if (key === "purchaseIntent") return "unknown";
  return null;
}

export const EMPTY_INTEL_FIELDS: IntelFields = Object.fromEntries(
  INTEL_FIELD_CATALOG.map((f) => [f.key, defaultValue(f.kind, f.key)])
);

export type IntelFieldStatus = "MISSING" | "EXTRACTED" | "CONFIRMED" | "CONFLICT";

export interface IntelFieldMeta {
  status: IntelFieldStatus;
  /** معرّفات الرسائل التي ذُكرت فيها المعلومة. */
  sources: string[];
  updatedAt?: string;
  /** قيم بديلة ظهرت برسائل أخرى ولم تُحسم. */
  conflicts?: string[];
}

export type IntelFieldMetaMap = Record<string, IntelFieldMeta>;

export interface IntelSnapshotShape {
  data: IntelFields;
  meta: IntelFieldMetaMap;
  confidence: number;
}

export function emptyMeta(defs: IntelFieldDef[] = INTEL_FIELD_CATALOG): IntelFieldMetaMap {
  return Object.fromEntries(defs.map((f) => [f.key, { status: "MISSING", sources: [] }]));
}

/** الحقول المفعّلة فقط هي التي تُطلب من الموديل وتُحفظ. */
export function fieldDefsOf(defs: IntelFieldDef[] | undefined): IntelFieldDef[] {
  return defs && defs.length ? defs : INTEL_FIELD_CATALOG;
}

function coerceText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v ? v.slice(0, max) : null;
}

function coerceList(value: unknown): string[] {
  const arr = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const v = item.trim();
    if (!v) continue;
    out.push(v.slice(0, MAX_SHORT_TEXT));
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

function coerceNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return null;
  return Math.round(n);
}

function coercePhone(value: unknown): string | null {
  const v = coerceText(value, 24);
  if (!v || !/^[0-9+\-()\s]{6,24}$/.test(v)) return null;
  return v;
}

export function coerceFieldValue(def: IntelFieldDef, value: unknown): IntelValue {
  if (def.key === "purchaseIntent") {
    return value === "high" || value === "medium" || value === "low" ? value : "unknown";
  }
  switch (def.kind) {
    case "LIST":
      return coerceList(value);
    case "NUMBER":
      return coerceNumber(value);
    case "PHONE":
      return coercePhone(value);
    default:
      return coerceText(value, MAX_TEXT);
  }
}

/**
 * تحقّق من مخرجات الموديل. لا يفشل بسبب حقل واحد ناقص (الحقل الغائب = null)،
 * لكنه يفشل إذا كانت الاستجابة بلا أي حقل معروف وبلا ثقة — ليست بيانات عميل.
 */
export function validateIntel(
  raw: unknown,
  defs: IntelFieldDef[] = INTEL_FIELD_CATALOG
): { ok: true; value: IntelFields } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "response is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  const active = fieldDefsOf(defs);
  const recognized = active.some((d) => d.key in obj) || "confidence" in obj;
  if (!recognized) return { ok: false, error: "no recognized fields" };

  const value: IntelFields = {};
  for (const def of active) value[def.key] = coerceFieldValue(def, obj[def.key]);

  const confidenceRaw = typeof obj.confidence === "number" ? obj.confidence : Number(obj.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0;
  const sourceMessageIds = Array.isArray(obj.sourceMessageIds)
    ? obj.sourceMessageIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).slice(0, 20)
    : [];

  return { ok: true, value: { ...value, confidence, sourceMessageIds } as IntelFields };
}

/** تطبيع للمقارنة: أرقام عربية ← لاتينية · بلا تشكيل · حروف صغيرة · مسافات موحّدة. */
export function normalizeForMatch(value: string): string {
  return value
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u064b-\u0652\u0670\u0640]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function digitsOnly(value: string): string {
  return normalizeForMatch(value).replace(/[^0-9]/g, "");
}

/**
 * «لا تخترع»: أي قيمة مفردة لازم تكون موجودة حرفيًا بالنص المصدر.
 * (الأرقام تُقارن كأرقام · النصوص كتطابق بعد التطبيع.)
 */
export function isGrounded(value: string | number, sourceText: string): boolean {
  const src = normalizeForMatch(sourceText);
  if (typeof value === "number") {
    return new RegExp(`(^|[^0-9])${value}([^0-9]|$)`).test(src);
  }
  if (/^[0-9+\-()\s]+$/.test(value)) {
    const d = digitsOnly(value);
    return d.length >= 6 && digitsOnly(src).includes(d);
  }
  const needle = normalizeForMatch(value);
  return needle.length > 0 && src.includes(needle);
}

export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}

/** إزالة أي قيمة غير موجودة حرفيًا بالنص (خطأ الموديل لا يصير بيانات عميل). */
export function groundFields(
  fields: IntelFields,
  sourceText: string,
  defs: IntelFieldDef[] = INTEL_FIELD_CATALOG
): { fields: IntelFields; dropped: string[] } {
  const dropped: string[] = [];
  const out: IntelFields = { ...fields };
  for (const def of fieldDefsOf(defs)) {
    const value = out[def.key];
    if (isEmptyValue(value)) continue;
    if (def.key === "purchaseIntent") continue;
    if (def.kind === "LIST") {
      const list = Array.isArray(value) ? value : [];
      const kept = list.filter((v) => isGrounded(v, sourceText));
      if (kept.length !== list.length) dropped.push(def.key);
      out[def.key] = kept;
      continue;
    }
    if (!isGrounded(value as string | number, sourceText)) {
      out[def.key] = null;
      dropped.push(def.key);
    }
  }
  return { fields: out, dropped };
}

function stringifyValue(value: unknown): string {
  return Array.isArray(value) ? value.join(" · ") : String(value);
}

/**
 * دمج تحليل جديد مع اللقطة الحالية.
 * - القيمة المؤكدة من موظف لا تُستبدل أبدًا.
 * - اختلاف قيمتين على نفس الحقل = CONFLICT مع حفظ القيمتين (لا اختيار عشوائي).
 * - القوائم تُدمج (اتحاد) بلا تكرار.
 */
export function mergeIntel(
  current: IntelSnapshotShape | null,
  incoming: IntelFields,
  sourceMessageId: string,
  allowedSourceIds: string[],
  defs: IntelFieldDef[] = INTEL_FIELD_CATALOG
): { snapshot: IntelSnapshotShape; needsReview: boolean } {
  const active = fieldDefsOf(defs);
  const empty: IntelFields = Object.fromEntries(active.map((d) => [d.key, defaultValue(d.kind, d.key)]));
  const base: IntelSnapshotShape = current
    ? {
        data: { ...empty, ...current.data },
        meta: { ...emptyMeta(active), ...current.meta },
        confidence: current.confidence,
      }
    : { data: { ...empty }, meta: emptyMeta(active), confidence: 0 };

  const data: IntelFields = { ...base.data };
  const meta: IntelFieldMetaMap = JSON.parse(JSON.stringify(base.meta));
  const now = new Date().toISOString();
  const confidenceRaw = typeof incoming.confidence === "number" ? incoming.confidence : 0;
  let needsReview = confidenceRaw < 0.6;

  const incomingSources = Array.isArray(incoming.sourceMessageIds) ? (incoming.sourceMessageIds as string[]) : [];
  const sources = incomingSources.filter((id) => allowedSourceIds.includes(id));
  if (sources.length === 0 && confidenceRaw > 0) sources.push(sourceMessageId);

  for (const def of active) {
    const key = def.key;
    const value = incoming[key];
    if (isEmptyValue(value)) continue;
    const currentMeta: IntelFieldMeta = meta[key] ?? { status: "MISSING", sources: [] };

    if (def.kind === "LIST") {
      const merged = Array.from(new Set([...(data[key] as string[] | null ?? []), ...(value as string[])])).slice(0, MAX_LIST_ITEMS);
      data[key] = merged;
      meta[key] = { status: "EXTRACTED", sources: Array.from(new Set([...currentMeta.sources, ...sources])), updatedAt: now };
      continue;
    }
    if (key === "purchaseIntent") {
      if (value === "unknown") continue;
      if (data[key] !== "unknown" && data[key] !== value) {
        meta[key] = {
          ...currentMeta,
          status: "CONFLICT",
          conflicts: Array.from(new Set([...(currentMeta.conflicts ?? []), String(data[key]), String(value)])),
          updatedAt: now,
        };
        needsReview = true;
        continue;
      }
      data[key] = value;
      meta[key] = { status: "EXTRACTED", sources: Array.from(new Set([...currentMeta.sources, ...sources])), updatedAt: now };
      continue;
    }

    const currentValue = data[key];
    if (isEmptyValue(currentValue)) {
      data[key] = value;
      meta[key] = { status: "EXTRACTED", sources: Array.from(new Set([...currentMeta.sources, ...sources])), updatedAt: now };
      continue;
    }
    if (stringifyValue(currentValue) === stringifyValue(value)) {
      meta[key] = { ...currentMeta, sources: Array.from(new Set([...currentMeta.sources, ...sources])), updatedAt: now };
      continue;
    }
    // اختلاف: المؤكد يبقى، ويُسجّل التعارض مع القيمة الجديدة.
    const conflicts = Array.from(new Set([...(currentMeta.conflicts ?? []), stringifyValue(value)]));
    meta[key] = { ...currentMeta, status: currentMeta.status === "CONFIRMED" ? "CONFIRMED" : "CONFLICT", conflicts, updatedAt: now };
    if (meta[key].status === "CONFLICT") needsReview = true;
  }

  const confidence = Math.max(base.confidence, confidenceRaw);
  return {
    snapshot: { data, meta, confidence },
    needsReview: needsReview || active.some((d) => meta[d.key]?.status === "CONFLICT"),
  };
}

/** نوع الحقل عند التأكيد: من الإعدادات، أو مستنبطًا من القيمة الحالية. */
function kindForConfirm(key: string, defs: IntelFieldDef[], current: IntelValue): IntelFieldKind {
  const def = fieldDefsOf(defs).find((d) => d.key === key);
  if (def) return def.kind;
  if (key === "purchaseIntent") return "TEXT";
  if (Array.isArray(current)) return "LIST";
  if (typeof current === "number") return "NUMBER";
  return "TEXT";
}

/** تأكيد/تصحيح موظف لحقل واحد — يصير CONFIRMED ولا يُستبدل بتحليل لاحق. */
export function confirmField(
  snapshot: IntelSnapshotShape,
  key: string,
  value: string | null,
  userId: string,
  defs: IntelFieldDef[] = INTEL_FIELD_CATALOG
): IntelSnapshotShape {
  const meta: IntelFieldMetaMap = JSON.parse(JSON.stringify(snapshot.meta));
  const data: IntelFields = { ...snapshot.data };
  const now = new Date().toISOString();
  const current = data[key] ?? null;

  if (key === "purchaseIntent") {
    data[key] = value === "high" || value === "medium" || value === "low" ? value : "unknown";
  } else {
    const kind = kindForConfirm(key, defs, current);
    const coerceDef: IntelFieldDef = { key, label: key, kind, required: false };
    if (kind === "LIST") {
      data[key] = value ? value.split("·").map((s) => s.trim()).filter(Boolean).slice(0, MAX_LIST_ITEMS) : [];
    } else {
      const coerced = coerceFieldValue(coerceDef, value);
      data[key] = coerced;
    }
  }
  meta[key] = { status: "CONFIRMED", sources: meta[key]?.sources ?? [], updatedAt: now };
  void userId;
  return { data, meta, confidence: snapshot.confidence };
}

export interface RequiredProgress {
  filled: number;
  required: number;
  missing: string[];
}

/** تقدّم جمع البيانات المطلوبة لحقل معيّن (قيمة موجودة = مجمّعة). */
export function requiredProgress(
  data: IntelFields | null | undefined,
  defs: IntelFieldDef[] = INTEL_FIELD_CATALOG
): RequiredProgress {
  const requiredDefs = fieldDefsOf(defs).filter((d) => d.required);
  const missing = requiredDefs.filter((d) => isEmptyValue(data?.[d.key]) || data?.[d.key] === "unknown").map((d) => d.key);
  return { filled: requiredDefs.length - missing.length, required: requiredDefs.length, missing };
}

export function isKnownFieldKey(key: string, defs: IntelFieldDef[] = INTEL_FIELD_CATALOG): boolean {
  return fieldDefsOf(defs).some((d) => d.key === key);
}

/** يستخدمه أداة zod في مسارات API عند استقبال قيم نصية. */
export const intelValue = z.union([z.string(), z.number(), z.array(z.string()), z.null()]);
