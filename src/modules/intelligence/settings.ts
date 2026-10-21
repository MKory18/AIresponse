import {
  INTEL_FIELD_CATALOG,
  INTEL_FIELD_KEY_PATTERN,
  INTEL_FIELD_KINDS,
  type IntelFieldDef,
  type IntelFieldKind,
} from "./fields";

type AnyDb = Record<string, any>;

export interface CollectionFieldSetting extends IntelFieldDef {
  enabled: boolean;
  sortOrder: number;
  isCustom: boolean;
}

export const MAX_COLLECTION_FIELDS = 30;
export const MAX_FIELD_LABEL = 40;

/** الإعداد الافتراضي: كل حقول الكتالوج مفعّلة، والمطلوب منها ما هو مطلوب أصلًا. */
export const DEFAULT_COLLECTION_FIELDS: CollectionFieldSetting[] = INTEL_FIELD_CATALOG.map((f, i) => ({
  ...f,
  enabled: true,
  sortOrder: i,
  isCustom: false,
}));

/** الحقول التي يطلبها الاستخراج فعلًا (المفعّلة فقط). */
export function enabledFieldDefs(settings: CollectionFieldSetting[]): IntelFieldDef[] {
  return settings
    .filter((f) => f.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((f) => ({ key: f.key, label: f.label, kind: f.kind, required: f.required }));
}

/**
 * إعدادات الحقول لمساحة: صفوف محفوظة، أو الافتراضي إذا لم يخصّص المالك شيئًا.
 * الافتراضي لا يُكتب بقاعدة البيانات — القراءة وحدها كافية.
 */
export async function getCollectionFields(db: AnyDb, workspaceId: string): Promise<CollectionFieldSetting[]> {
  const rows = await db.collectionFieldSetting.findMany({
    where: { workspaceId },
    orderBy: { sortOrder: "asc" },
  });
  if (!rows?.length) return DEFAULT_COLLECTION_FIELDS;
  return (rows as Array<Record<string, any>>).map((r, i) => ({
    key: String(r.key),
    label: String(r.label),
    kind: (INTEL_FIELD_KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as IntelFieldKind) : "TEXT",
    required: Boolean(r.required),
    enabled: r.enabled !== false,
    sortOrder: Number.isFinite(Number(r.sortOrder)) ? Number(r.sortOrder) : i,
    isCustom: Boolean(r.isCustom),
  }));
}

export type NormalizeResult =
  | { ok: true; fields: CollectionFieldSetting[] }
  | { ok: false; error: string };

/**
 * تحقّق من مدخلات المالك قبل الحفظ.
 * - المفاتيح القياسية تحافظ على نوعها (ما بينقلب رقم لنص).
 * - الحقول الخاصة بمفاتيح جديدة بصيغة آمنة فقط.
 * - لازم يضل حقل مفعّل واحد على الأقل.
 */
export function normalizeCollectionFields(input: unknown): NormalizeResult {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: "FIELDS_REQUIRED" };
  if (input.length > MAX_COLLECTION_FIELDS) return { ok: false, error: "TOO_MANY_FIELDS" };

  const seen = new Set<string>();
  const out: CollectionFieldSetting[] = [];

  for (const [index, raw] of input.entries()) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "INVALID_FIELD" };
    const row = raw as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    if (!key) return { ok: false, error: "INVALID_KEY" };
    if (seen.has(key)) return { ok: false, error: "DUPLICATE_KEY" };
    seen.add(key);

    const catalogDef = INTEL_FIELD_CATALOG.find((c) => c.key === key);
    const isCustom = !catalogDef;
    if (isCustom && !INTEL_FIELD_KEY_PATTERN.test(key)) return { ok: false, error: "INVALID_KEY" };

    const labelRaw = typeof row.label === "string" ? row.label.trim() : "";
    const label = (labelRaw || catalogDef?.label || key).slice(0, MAX_FIELD_LABEL);
    const kind: IntelFieldKind = catalogDef
      ? catalogDef.kind
      : (INTEL_FIELD_KINDS as readonly string[]).includes(String(row.kind))
        ? (row.kind as IntelFieldKind)
        : "TEXT";

    out.push({
      key,
      label,
      kind,
      enabled: row.enabled !== false,
      required: row.enabled !== false && row.required === true,
      sortOrder: index,
      isCustom,
    });
  }

  if (!out.some((f) => f.enabled)) return { ok: false, error: "NO_ENABLED_FIELDS" };
  return { ok: true, fields: out };
}

/** استبدال إعدادات المساحة بالكامل (حذف المحذوف + تحديث الموجود + إضافة الجديد). */
export async function saveCollectionFields(
  db: AnyDb,
  workspaceId: string,
  input: unknown
): Promise<{ ok: true; fields: CollectionFieldSetting[] } | { ok: false; error: string }> {
  const parsed = normalizeCollectionFields(input);
  if (!parsed.ok) return parsed;

  const existing = (await db.collectionFieldSetting.findMany({ where: { workspaceId } })) as Array<Record<string, any>>;
  const keep = new Set(parsed.fields.map((f) => f.key));
  for (const row of existing) {
    if (!keep.has(String(row.key))) await db.collectionFieldSetting.delete({ where: { id: row.id } });
  }

  for (const field of parsed.fields) {
    const current = existing.find((r) => String(r.key) === field.key);
    const data = {
      label: field.label,
      kind: field.kind,
      required: field.required,
      enabled: field.enabled,
      sortOrder: field.sortOrder,
      isCustom: field.isCustom,
    };
    if (current) await db.collectionFieldSetting.update({ where: { id: current.id }, data });
    else await db.collectionFieldSetting.create({ data: { workspaceId, key: field.key, ...data } });
  }

  return { ok: true, fields: parsed.fields };
}
