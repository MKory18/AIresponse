/**
 * P19 — الحقول المطلوبة لإكمال مسودة الطلب، قابلة للضبط لكل صفحة.
 *
 * product + quantity دائمًا مطلوبان (بدونهم ما في طلب أصلًا). المالك يختار
 * حقول الاتصال الإضافية: الهاتف · العنوان · الاسم. أي قيمة غير معروفة تُهمل.
 */
export const ALWAYS_REQUIRED_ORDER_FIELDS = ["product", "quantity"] as const;
export const OPTIONAL_ORDER_FIELDS = ["phone", "address", "name"] as const;

export type OrderContactField = (typeof OPTIONAL_ORDER_FIELDS)[number];
export type OrderFieldKey = (typeof ALWAYS_REQUIRED_ORDER_FIELDS)[number] | OrderContactField;

export const DEFAULT_ORDER_FIELDS: OrderFieldKey[] = ["product", "quantity", "phone", "address"];

export function isOptionalOrderField(value: unknown): value is OrderContactField {
  return typeof value === "string" && (OPTIONAL_ORDER_FIELDS as readonly string[]).includes(value);
}

/**
 * يطبّع اختيار المالك: منتج + كمية دائمًا، ثم حقول الاتصال بترتيب ثابت.
 * undefined/null = الافتراضي (هاتف + عنوان).
 */
export function normalizeOrderFields(input: unknown): OrderFieldKey[] {
  if (!Array.isArray(input)) return [...DEFAULT_ORDER_FIELDS];
  const selected = new Set(input.filter(isOptionalOrderField));
  return [
    ...ALWAYS_REQUIRED_ORDER_FIELDS,
    ...OPTIONAL_ORDER_FIELDS.filter((f) => selected.has(f)),
  ];
}

/** التسمية العربية — للواجهة والملخص. */
export function orderFieldLabel(field: string): string {
  switch (field) {
    case "product": return "المنتج";
    case "quantity": return "الكمية";
    case "phone": return "الهاتف";
    case "address": return "العنوان";
    case "name": return "الاسم";
    default: return field;
  }
}
