/**
 * تسميات حالة الـ OMS بالعربي — ملف نقي (بلا خادم) عشان يتشارك بين الواجهة وبرومبت الرد.
 */
const up = (v: unknown) => String(v ?? "").trim().toUpperCase();

const STATUS_AR: Record<string, string> = {
  NEW: "جديد",
  IN_PROGRESS: "قيد المتابعة",
  CONFIRMED: "مؤكد",
  REJECTED: "مرفوض",
  CANCELLED: "ملغى",
  CANCELED: "ملغى",
  NO_ANSWER: "ما رد",
  FOLLOW_UP_REQUIRED: "بحاجة متابعة",
  POSTPONED: "مؤجّل",
  DELIVERED: "تم التسليم",
  RETURNED: "مرتجع",
};
const SHIPPING_AR: Record<string, string> = {
  NOT_READY: "قيد التجهيز",
  READY: "جاهز للشحن",
  SHIPPED: "مشحون",
  IN_TRANSIT: "بالطريق",
  OUT_FOR_DELIVERY: "بالتوصيل",
  DELIVERED: "تم التسليم",
  RETURNED: "مرتجع",
};

/** «مؤكد · مشحون» — لبرومبت الرد («طلبات العميل الأخيرة») وللموظف. فاضي = ما في معلومة. */
export function omsStatusLabel(status?: string | null, shipping?: string | null): string {
  const parts: string[] = [];
  if (status) parts.push(STATUS_AR[up(status)] ?? String(status));
  if (shipping && up(shipping) !== "NOT_READY") parts.push(SHIPPING_AR[up(shipping)] ?? String(shipping));
  return parts.join(" · ");
}

