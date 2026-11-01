/**
 * P18 — رسالة فشل حفظ المنتج بالعربي، قريبة من الزر.
 *
 * قبل: أي فشل (صلاحية/تحقق/خادم) كان يطلع شريطًا أعلى الصفحة فقط، فالمستخدم
 * الواقف عند زر الحفظ ما يشوف شي ويحس إن الزر «ما بيعمل». الدالة نقية كي تُختبر.
 */
const FIELD_AR: Record<string, string> = {
  name: "الاسم",
  sku: "SKU",
  description: "الوصف الكامل",
  shortDescription: "الوصف القصير",
  price: "السعر",
  compareAtPrice: "السعر قبل الخصم",
  currency: "العملة",
  stockStatus: "حالة المخزون",
  stockQty: "الكمية",
  category: "التصنيف",
  tags: "الوسوم",
  benefits: "الفوائد",
  ingredients: "المكونات",
  usage: "طريقة الاستخدام",
  warnings: "التحذيرات",
  objections: "الاعتراضات",
  salesNotes: "ملاحظات البيع",
  priceTiers: "الأسعار الإضافية",
  isActive: "الحالة",
  isArchived: "الأرشفة",
};

export interface ProductSaveErrorBody {
  error?: string;
  message?: string;
  details?: { path?: string; message?: string }[];
}

export function productSaveError(status: number, body: unknown): string {
  const b = (body ?? {}) as ProductSaveErrorBody;

  if (status === 403) {
    return "ما عندك صلاحية تعديل المنتجات. اطلب من المدير منحك صلاحية كتالوج المنتجات.";
  }

  const detail = b.details?.[0];
  if (detail?.path) {
    const [root, index] = detail.path.split(".");
    const field = FIELD_AR[root] ?? root;
    const line = index !== undefined && /^\d+$/.test(index) ? ` (السطر ${Number(index) + 1})` : "";
    return `تعذّر الحفظ — ${field}${line}: ${detail.message ?? "قيمة غير صالحة"}`;
  }

  if (b.message) return `تعذّر الحفظ: ${b.message}`;
  if (status === 422) return "تعذّر الحفظ — في حقل غير صالح. راجع القيم وجرّب مرة ثانية.";
  if (status >= 500) return "تعذّر الحفظ — خطأ بالخادم. جرّب مرة ثانية.";
  return `تعذّر الحفظ (HTTP ${status}).`;
}
