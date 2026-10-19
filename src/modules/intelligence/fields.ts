import { z } from "zod";

/**
 * حقول «معلومات العميل المستخرجة» — عقد واحد بين الموديل والواجهة.
 * قواعد صارمة:
 * - أي حقل غير مذكور صراحةً بالنص = null (لا اختراع).
 * - `sourceMessageIds` تُفلتر على الرسائل المُرسلة فعلًا للموديل.
 * - مصدر كل معلومة محفوظ بـ fieldMeta، والتعارض يُسجّل ولا يُحسم عشوائيًا.
 */
export const INTEL_FIELD_KEYS = [
  "customerName",
  "phone",
  "city",
  "address",
  "products",
  "quantity",
  "budget",
  "purchaseIntent",
  "needs",
  "notes",
] as const;

export type IntelFieldKey = (typeof INTEL_FIELD_KEYS)[number];

const shortText = z.string().trim().min(1).max(200);
const shortTextOrNull = shortText.nullable().default(null);
const listOfText = z.array(shortText).max(10).default([]);

export const intelFieldsSchema = z
  .object({
    customerName: shortTextOrNull,
    phone: z
      .string()
      .trim()
      .max(24)
      .nullable()
      .default(null)
      .refine((v) => v === null || /^[0-9+\-()\s]{6,24}$/.test(v), "invalid phone"),
    city: shortTextOrNull,
    address: z.string().trim().max(300).nullable().default(null),
    products: listOfText,
    quantity: z.number().int().positive().max(1_000_000).nullable().default(null),
    budget: z.string().trim().max(80).nullable().default(null),
    purchaseIntent: z.enum(["high", "medium", "low", "unknown"]).default("unknown"),
    needs: listOfText,
    notes: listOfText,
    confidence: z.number().min(0).max(1).default(0),
    sourceMessageIds: z.array(z.string().min(1)).max(20).default([]),
  })
  .strict();

export type IntelFields = z.infer<typeof intelFieldsSchema>;

export const EMPTY_INTEL_FIELDS: IntelFields = {
  customerName: null,
  phone: null,
  city: null,
  address: null,
  products: [],
  quantity: null,
  budget: null,
  purchaseIntent: "unknown",
  needs: [],
  notes: [],
  confidence: 0,
  sourceMessageIds: [],
};

export type IntelFieldStatus = "MISSING" | "EXTRACTED" | "CONFIRMED" | "CONFLICT";

export interface IntelFieldMeta {
  status: IntelFieldStatus;
  /** معرّفات الرسائل التي ذُكرت فيها المعلومة. */
  sources: string[];
  updatedAt?: string;
  /** قيم بديلة ظهرت برسائل أخرى ولم تُحسم. */
  conflicts?: string[];
}

export type IntelFieldMetaMap = Record<IntelFieldKey, IntelFieldMeta>;

export interface IntelSnapshotShape {
  data: IntelFields;
  meta: IntelFieldMetaMap;
  confidence: number;
}

export function emptyMeta(): IntelFieldMetaMap {
  return Object.fromEntries(INTEL_FIELD_KEYS.map((k) => [k, { status: "MISSING", sources: [] }])) as unknown as IntelFieldMetaMap;
}

export function validateIntel(raw: unknown): { ok: true; value: IntelFields } | { ok: false; error: string } {
  const parsed = intelFieldsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  return { ok: true, value: parsed.data };
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

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}

/** إزالة أي قيمة غير موجودة حرفيًا بالنص (خطأ الموديل لا يصير بيانات عميل). */
export function groundFields(fields: IntelFields, sourceText: string): { fields: IntelFields; dropped: IntelFieldKey[] } {
  const dropped: IntelFieldKey[] = [];
  const out: IntelFields = { ...fields };
  const singles: IntelFieldKey[] = ["customerName", "phone", "city", "address", "quantity", "budget"];
  for (const key of singles) {
    const v = out[key];
    if (isEmptyValue(v)) continue;
    if (!isGrounded(v as string | number, sourceText)) {
      (out as Record<string, unknown>)[key] = null;
      dropped.push(key);
    }
  }
  for (const key of ["products", "needs", "notes"] as const) {
    const kept = out[key].filter((v) => isGrounded(v, sourceText));
    if (kept.length !== out[key].length) dropped.push(key);
    out[key] = kept;
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
  allowedSourceIds: string[]
): { snapshot: IntelSnapshotShape; needsReview: boolean } {
  const base: IntelSnapshotShape = current
    ? { data: { ...EMPTY_INTEL_FIELDS, ...current.data }, meta: { ...emptyMeta(), ...current.meta }, confidence: current.confidence }
    : { data: { ...EMPTY_INTEL_FIELDS }, meta: emptyMeta(), confidence: 0 };

  const data: IntelFields = { ...base.data };
  const meta: IntelFieldMetaMap = JSON.parse(JSON.stringify(base.meta));
  const now = new Date().toISOString();
  let needsReview = incoming.confidence < 0.6;

  const sources = incoming.sourceMessageIds.filter((id) => allowedSourceIds.includes(id));
  if (sources.length === 0 && incoming.confidence > 0) sources.push(sourceMessageId);

  for (const key of INTEL_FIELD_KEYS) {
    const value = incoming[key];
    if (isEmptyValue(value)) continue;

    if (key === "products" || key === "needs" || key === "notes") {
      const merged = Array.from(new Set([...(data[key] as string[]), ...(value as string[])])).slice(0, 10);
      (data as Record<string, unknown>)[key] = merged;
      meta[key] = { status: "EXTRACTED", sources: Array.from(new Set([...meta[key].sources, ...sources])), updatedAt: now };
      continue;
    }
    if (key === "purchaseIntent") {
      if (value === "unknown") continue;
      if (data.purchaseIntent !== "unknown" && data.purchaseIntent !== value) {
        meta.purchaseIntent = {
          ...meta.purchaseIntent,
          status: "CONFLICT",
          conflicts: Array.from(new Set([...(meta.purchaseIntent.conflicts ?? []), data.purchaseIntent, String(value)])),
          updatedAt: now,
        };
        needsReview = true;
        continue;
      }
      data.purchaseIntent = value as IntelFields["purchaseIntent"];
      meta.purchaseIntent = { status: "EXTRACTED", sources: Array.from(new Set([...meta.purchaseIntent.sources, ...sources])), updatedAt: now };
      continue;
    }

    const currentValue = data[key];
    if (isEmptyValue(currentValue)) {
      (data as Record<string, unknown>)[key] = value;
      meta[key] = { status: "EXTRACTED", sources: Array.from(new Set([...meta[key].sources, ...sources])), updatedAt: now };
      continue;
    }
    if (stringifyValue(currentValue) === stringifyValue(value)) {
      meta[key] = { ...meta[key], sources: Array.from(new Set([...meta[key].sources, ...sources])), updatedAt: now };
      continue;
    }
    // اختلاف: المؤكد يبقى، ويُسجّل التعارض مع القيمة الجديدة.
    const conflicts = Array.from(new Set([...(meta[key].conflicts ?? []), stringifyValue(value)]));
    meta[key] = { ...meta[key], status: meta[key].status === "CONFIRMED" ? "CONFIRMED" : "CONFLICT", conflicts, updatedAt: now };
    if (meta[key].status === "CONFLICT") needsReview = true;
  }

  const confidence = Math.max(base.confidence, incoming.confidence);
  return {
    snapshot: { data, meta, confidence },
    needsReview: needsReview || INTEL_FIELD_KEYS.some((k) => meta[k].status === "CONFLICT"),
  };
}

/** تأكيد/تصحيح موظف لحقل واحد — يصير CONFIRMED ولا يُستبدل بتحليل لاحق. */
export function confirmField(
  snapshot: IntelSnapshotShape,
  key: IntelFieldKey,
  value: string | null,
  userId: string
): IntelSnapshotShape {
  const meta: IntelFieldMetaMap = JSON.parse(JSON.stringify(snapshot.meta));
  const data: IntelFields = { ...snapshot.data };
  const now = new Date().toISOString();
  if (key === "products" || key === "needs" || key === "notes") {
    (data as Record<string, unknown>)[key] = value ? value.split("·").map((s) => s.trim()).filter(Boolean).slice(0, 10) : [];
  } else if (key === "quantity") {
    const n = value ? Number(value) : null;
    data.quantity = n !== null && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } else if (key === "purchaseIntent") {
    data.purchaseIntent = (value === "high" || value === "medium" || value === "low" ? value : "unknown") as IntelFields["purchaseIntent"];
  } else {
    (data as Record<string, unknown>)[key] = value && value.trim() ? value.trim() : null;
  }
  meta[key] = { status: "CONFIRMED", sources: meta[key].sources, updatedAt: now, } as IntelFieldMeta;
  void userId;
  return { data, meta, confidence: snapshot.confidence };
}
