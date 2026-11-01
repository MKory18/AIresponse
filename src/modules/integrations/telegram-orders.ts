/**
 * P19 — رسالة "طلب جاهز" لتيليجرام (HTML آمن).
 *
 * البيانات تُقرأ من قاعدة البيانات (منتج/سعر/عميل) — لا شيء يُخترع هنا.
 * الرسالة تجميلية/تشغيلية: تُرسل لفريق المالك في مجموعة خاصة، ولا ترسل شيئًا
 * للزبون ولا تنشئ طلبًا مؤكدًا بحد ذاتها.
 */
export interface OrderReadyMessageInput {
  pageName: string | null;
  customerName: string | null;
  phone: string | null;
  province: string | null;
  address: string | null;
  productName: string | null;
  quantity: number | null;
  unitPrice: string | null;
  currency: string | null;
  /** إجمالي تقديري (قبل التوصيل) إن توفر — بلا اختراع. */
  estimatedTotal: string | null;
}

export function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildOrderReadyMessage(input: OrderReadyMessageInput): string {
  const esc = escapeTelegramHtml;
  const lines: string[] = [];

  const page = input.pageName?.trim();
  lines.push(`<b>🧾 طلب جاهز</b>${page ? ` — ${esc(page)}` : ""}`);

  const name = input.customerName?.trim();
  if (name) lines.push(`👤 الاسم: ${esc(name)}`);

  const phone = input.phone?.trim();
  if (phone) lines.push(`📞 الهاتف: <code>${esc(phone)}</code>`);

  const address = [input.province, input.address].filter((v): v is string => Boolean(v?.trim())).join(" - ");
  if (address) lines.push(`📍 العنوان: ${esc(address)}`);

  const product = input.productName?.trim();
  if (product) lines.push(`🛒 المنتج: <b>${esc(product)}</b>${input.quantity ? ` × ${input.quantity}` : ""}`);

  if (input.unitPrice) {
    lines.push(`💵 سعر الوحدة: ${esc(input.unitPrice)} ${esc(input.currency ?? "")}`.trimEnd());
  }
  if (input.estimatedTotal) {
    lines.push(`🧮 الإجمالي التقديري: ${esc(input.estimatedTotal)} ${esc(input.currency ?? "")}`.trimEnd());
  }

  lines.push("");
  lines.push("<i>الحالة: بانتظار تأكيد الزبون — لم يُنشأ طلب مؤكد بعد.</i>");
  return lines.join("\n");
}
