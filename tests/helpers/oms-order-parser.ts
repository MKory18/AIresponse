/**
 * نسخة حرفية من المحلّل الحتمي بالـ Zaki OMS (ريبو MKory18/Zaki-ai-CRM:
 * src/lib/order-parser.ts → parseOrderText) — لاختبار عقد «نص الإدخال» بين
 * الردود والـ OMS بلا ما نستورد من ريبو تاني. إذا تغيّر المحلّل هناك، حدّث
 * هالنسخة واختبار p12-review-round2 بيقول إذا نصّنا لسا بينقرأ صح.
 * (فقط المحلّل — بلا مطابقة المنتجات وبلا أي موديل.)
 */

export interface ParsedOrder {
  customerName: string;
  phone: string;
  governorate: string;
  address: string;
  productQuery: string;
  quantity: number;
  price: number | null;
  notes: string;
  source: string;
}

const FIELD_PATTERNS: Array<{ key: keyof ParsedOrder; regex: RegExp }> = [
  { key: "customerName", regex: /(?:الاسم|اسم الزبون|اسم العميل|الاسم الكامل)\s*[:：-]\s*(.+)/i },
  { key: "phone", regex: /(?:الرقم|رقم الهاتف|الهاتف|رقم الموبايل|رقم الواتس|واتس)\s*[:：-]\s*([0-9+\-\s()]{7,20})/ },
  { key: "governorate", regex: /(?:اسم المحافظة|المحافظة|المحافظه)\s*[:：-]\s*(.+)/ },
  { key: "address", regex: /(?:العنوان|عنوان التوصيل|السكن)\s*[:：-]\s*(.+)/ },
  { key: "productQuery", regex: /(?:الطلب\s*\(\s*[^)]*\s*\)|الطلب|اسم المنتج|المنتج المطلوب|المنتج|المطلوب)\s*[:：-]\s*(.+)/ },
  { key: "quantity", regex: /(?:الكمية|الكميه|العدد)\s*[:：-]\s*([0-9]+)/ },
  { key: "price", regex: /(?:السعر|المبلغ|الثمن)\s*[:：-]\s*([0-9]+(?:[.,][0-9]+)?)\s*\$?/ },
  { key: "notes", regex: /(?:الملاحظات|ملاحظات|ملاحظة)\s*[:：-]\s*(.+)/ },
  { key: "source", regex: /(?:اسم الصفحة|اسم الصفحه|الصفحة|الصفحه|المصدر)\s*[:：-]\s*(.+)/ },
];

export function parseOrderText(text: string): ParsedOrder {
  const lines = text.split(/\n|؛|;/);
  const result: ParsedOrder = {
    customerName: "",
    phone: "",
    governorate: "",
    address: "",
    productQuery: "",
    quantity: 1,
    price: null,
    notes: "",
    source: "",
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "-") continue;

    for (const { key, regex } of FIELD_PATTERNS) {
      if (result[key] && key !== "quantity") continue;
      const m = trimmed.match(regex);
      if (m && m[1]) {
        const value = m[1].replace(/^\(|\)$/g, "").trim();
        if (value && value !== "-") {
          if (key === "quantity") {
            result.quantity = parseInt(value, 10);
          } else if (key === "price") {
            result.price = parseFloat(value.replace(",", "."));
          } else {
            (result[key] as string) = value;
          }
        }
      }
    }
  }

  if (!result.phone) {
    const phoneMatch = text.match(/\b(?:00962|00963|\+962|\+963)?0?[0-9]{9,10}\b/);
    if (phoneMatch) result.phone = phoneMatch[0];
  }

  result.customerName = result.customerName.replace(/^(?:الاسم|اسم الزبون)\s*/g, "").trim();
  result.source = result.source.trim() || "الشيت";

  return result;
}
