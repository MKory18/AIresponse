/**
 * نص إشعار الطلب على تيليجرام — دالة نقية قابلة للاختبار.
 *
 * سيستم 1: اسم/رقم/عنوان الزبون بيانات شخصية. افتراضيًا **لا تُرسل** لتيليجرام؛
 * تُضاف فقط عند تفعيل المالك الصريح `TELEGRAM_ORDER_PII=1`.
 */
export interface OrderNotificationInput {
  orderNumber: string;
  productName: string;
  quantity: number | null;
  total: number | string;
  currency: string;
  status: string;
  customerName?: string | null;
  customerPhone?: string | null;
  /** صريح فقط: هل نضمّن اسم/رقم الزبون؟ الافتراضي بالنداء = لا. */
  includePii: boolean;
}

export function orderNotificationText(input: OrderNotificationInput): string {
  const lines = ["📦 طلب جديد", `رقم: ${input.orderNumber}`];
  if (input.includePii) {
    lines.push(`العميل: ${input.customerName ?? input.customerPhone ?? "-"}`);
  }
  lines.push(
    `المنتج: ${input.productName} × ${input.quantity}`,
    `المجموع: ${input.total} ${input.currency}`,
    `الحالة: ${input.status}`
  );
  return lines.join("\n");
}

/** هل فعّل المالك إرسال بيانات الزبون لتيليجرام؟ (افتراضي: لا). */
export function telegramOrderPiiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TELEGRAM_ORDER_PII === "1" || env.TELEGRAM_ORDER_PII === "true";
}
