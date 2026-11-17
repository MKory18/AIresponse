/** نصوص «الطلبات» الجديدة. التسميات من القاموس، والأزرار أفعال (لا اسم حالة). */
export const ORDERS_STRINGS = {
  search: "رقم الطلب · العميل · الهاتف",
  columns: { order: "الطلب", customer: "العميل", items: "المنتجات", total: "الإجمالي", status: "الحالة", updated: "آخر تحديث" },
  emptyTitle: "ما في طلبات هون",
  emptyDescription: "لما يوصل أول طلب بيظهر بهالقائمة.",
  emptyFiltered: "ما في طلبات بهالفلتر",
  emptyFilteredDescription: "غيّر التبويب أو امسح البحث.",
  openConversation: "افتح المحادثة",
  openPage: "افتح صفحة الطلب",
  drawerTitle: "الطلب",
  noConversation: "هالطلب مش مربوط بمحادثة (إدخال يدوي أو قديم).",
  loadError: "تعذّر تحميل الطلبات",
  retry: "أعد المحاولة",
  loadMore: "حمّل المزيد",
} as const;
