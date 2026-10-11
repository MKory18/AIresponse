/**
 * P12 — بناء JSON Schema حرفي لدليل الأدوات (agent-door/v1): كل كائن
 * additionalProperties: false — الجسر يرفض أي رد فيه حقل برّا المخطط.
 * (التحقق الفعلي وقت التشغيل بـ zod بنفس الشكل؛ اختبار عقد يطابق الاتنين.)
 */

export type JsonSchema = Record<string, unknown>;

export const S = {
  str(opts: { min?: number; max?: number; pattern?: string; enum?: readonly string[]; format?: string } = {}): JsonSchema {
    const s: JsonSchema = { type: "string" };
    if (opts.min !== undefined) s.minLength = opts.min;
    if (opts.max !== undefined) s.maxLength = opts.max;
    if (opts.pattern) s.pattern = opts.pattern;
    if (opts.enum) s.enum = [...opts.enum];
    if (opts.format) s.format = opts.format;
    return s;
  },
  int(min?: number, max?: number): JsonSchema {
    const s: JsonSchema = { type: "integer" };
    if (min !== undefined) s.minimum = min;
    if (max !== undefined) s.maximum = max;
    return s;
  },
  num(min?: number, max?: number): JsonSchema {
    const s: JsonSchema = { type: "number" };
    if (min !== undefined) s.minimum = min;
    if (max !== undefined) s.maximum = max;
    return s;
  },
  bool(): JsonSchema {
    return { type: "boolean" };
  },
  /**
   * قيمة أو null — بـ anyOf دايمًا (لا type: ["x","null"]): ajv بوضعه الصارم
   * بيرفض الأنواع المركّبة بلا allowUnionTypes، والجسر بيرفض الأداة كلها.
   */
  nullable(inner: JsonSchema): JsonSchema {
    return { anyOf: [inner, { type: "null" }] };
  },
  arr(items: JsonSchema, maxItems?: number): JsonSchema {
    const s: JsonSchema = { type: "array", items };
    if (maxItems !== undefined) s.maxItems = maxItems;
    return s;
  },
  obj(properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema {
    return { type: "object", properties, required, additionalProperties: false };
  },
  /** كائن بمفاتيح ثابتة كلها من نفس النوع (by_channel · last_sync) — حرفي بلا مفاتيح حرة. */
  fixed(keys: readonly string[], value: JsonSchema): JsonSchema {
    return S.obj(Object.fromEntries(keys.map((k) => [k, value])));
  },
};

/**
 * تاريخ ISO (يوم أو وقت مع منطقة) — بنمط لا بـ format: ajv بلا ajv-formats
 * بوضعه الصارم بيرفض format مش معروف، فالنمط أضمن لكل جسر.
 */
export const ISO_DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,3})?)?(Z|[+-]\\d{2}:\\d{2})?)?$";

/** مدخل الفترة الموحّد (agent-door/v1 §6). */
export const PERIOD_INPUT: Record<string, JsonSchema> = {
  period: S.str({ enum: ["today", "yesterday", "last_7d", "last_week", "last_30d", "last_month", "month_to_date"] }),
  from: S.str({ pattern: ISO_DATE_PATTERN, max: 40 }),
  to: S.str({ pattern: ISO_DATE_PATTERN, max: 40 }),
};

export const PERIOD_OUTPUT: JsonSchema = S.obj({
  from: S.str({ max: 40 }),
  to: S.str({ max: 40 }),
  label: S.str({ max: 20 }),
});
