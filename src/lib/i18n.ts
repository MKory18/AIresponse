/**
 * Central Arabic UI dictionary — single source of truth for interface copy.
 * All components must use these keys instead of scattered hardcoded strings.
 */

export const t = {
  app: { name: "AIresponse", tagline: "محرك المحادثات والمبيعات بالذكاء الاصطناعي" },
  nav: {
    dashboard: "لوحة التحكم",
    inbox: "صندوق المحادثات",
    conversations: "المحادثات",
    customers: "العملاء",
    orders: "الطلبات",
    products: "المنتجات",
    media: "الوسائط",
    feedback: "آراء العملاء",
    knowledge: "قاعدة المعرفة",
    personas: "شخصية الذكاء الاصطناعي",
    playground: "تجربة الذكاء الاصطناعي",
    channels: "القنوات",
    automation: "الأتمتة",
    followups: "المتابعات",
    handoffs: "التسليم للموظفين",
    analytics: "التحليلات",
    settings: "الإعدادات",
  },
  common: {
    send: "إرسال",
    reply: "الرد",
    assign: "تعيين",
    unassign: "إلغاء التعيين",
    assignToMe: "تعيين لي",
    close: "إغلاق",
    open: "فتح",
    cancel: "إلغاء",
    save: "حفظ",
    create: "إنشاء",
    edit: "تعديل",
    delete: "حذف",
    export: "تصدير",
    refresh: "تحديث",
    retry: "إعادة المحاولة",
    viewAll: "عرض الكل",
    logout: "تسجيل الخروج",
    loading: "جارٍ التحميل…",
    loadMore: "تحميل المزيد",
    search: "بحث",
    back: "رجوع",
    details: "التفاصيل",
    all: "الكل",
    today: "اليوم",
    yesterday: "أمس",
    actions: "إجراءات",
    status: "الحالة",
    date: "التاريخ",
    noData: "لا توجد بيانات",
  },
  states: {
    open: "مفتوحة",
    pending: "قيد الانتظار",
    resolved: "تم الحل",
    closed: "مغلقة",
    confirmed: "مؤكد",
    processing: "قيد المعالجة",
    done: "مكتمل",
    failed: "فشل",
    scheduled: "مجدولة",
    running: "جارٍ التنفيذ",
    skipped: "متجاوزة",
    cancelled: "ملغاة",
    high: "أولوية عالية",
    urgent: "عاجلة",
    low: "منخفضة",
    normal: "عادية",
    connected: "متصل",
    disconnected: "غير متصل",
    connecting: "جارٍ الاتصال",
    error: "خطأ",
  },
  roles: { ai: "الذكاء الاصطناعي", human: "موظف", system: "النظام" },
  inbox: {
    title: "صندوق المحادثات",
    searchPlaceholder: "بحث بالاسم أو الهاتف أو نص الرسالة…",
    unreadOnly: "غير المقروءة فقط",
    filterAll: "الكل",
    filterUnread: "غير المقروءة",
    filterMine: "المعيّنة لي",
    filterAi: "يديرها الذكاء الاصطناعي",
    filterHuman: "بحاجة لموظف",
    filterOrders: "مرتبطة بطلب",
    takeOver: "استلام من الذكاء الاصطناعي",
    backToAi: "إعادة إلى الذكاء الاصطناعي",
    resolve: "تم الحل",
    selectConversation: "اختر محادثة لعرضها",
    selectHint: "ستظهر رسائل المحادثة هنا بمجرد اختيارها من القائمة.",
    emptyListTitle: "لا توجد محادثات حتى الآن",
    emptyListDesc: "ستظهر المحادثات الجديدة هنا عند وصول أول رسالة من عملائك.",
    noResultsTitle: "لا توجد نتائج مطابقة",
    noResultsDesc: "جرّب كلمة بحث مختلفة أو أزل عوامل التصفية.",
    composerPlaceholder: "اكتب ردك… (Enter للإرسال، Shift+Enter لسطر جديد)",
    newLine: "سطر جديد",
    replyManually: "الرد يدويًا",
    replyWithAi: "الرد بواسطة الذكاء الاصطناعي",
    attach: "إرفاق ملف",
    emoji: "رموز تعبيرية",
    attachment: "مرفق",
    draftTitle: "مسودة طلب",
    draftMissing: "الحقول الناقصة",
    draftReady: "البيانات مكتملة وجاهزة للتأكيد",
    aiSummary: "ملخص الذكاء الاصطناعي",
    aiSummaryEmpty: "لم يُولَّد ملخص لهذا العميل بعد.",
    loadListFailed: "تعذّر تحميل المحادثات",
    actionFailed: "تعذّر تنفيذ الإجراء، حاول مجددًا",
  },
  customer: {
    panelTitle: "بيانات العميل",
    noSelection: "اختر محادثة لعرض بيانات العميل",
    phone: "الهاتف",
    province: "المحافظة",
    address: "العنوان",
    platform: "المنصة",
    lastActivity: "آخر نشاط",
    tags: "الوسوم",
    identities: "حسابات القنوات",
    recentOrders: "آخر الطلبات",
    noOrders: "لا توجد طلبات لهذا العميل بعد.",
    product: "المنتج",
    quantity: "الكمية",
  },
  orders: {
    title: "الطلبات",
    statTotal: "إجمالي الطلبات",
    statNew: "طلبات جديدة",
    statConfirming: "قيد التأكيد",
    statCompleted: "مكتملة",
    statNeedsReview: "تحتاج مراجعة",
    id: "رقم الطلب",
    customer: "العميل",
    phone: "الهاتف",
    product: "المنتج",
    quantity: "الكمية",
    total: "الإجمالي",
    status: "الحالة",
    assignee: "المسؤول",
    date: "التاريخ",
    actions: "الإجراءات",
    emptyTitle: "لا توجد طلبات بعد",
    emptyDesc: "ستظهر الطلبات هنا بمجرد تأكيد أول طلب من المحادثات.",
  },
  dashboard: {
    greeting: "مرحبًا",
    welcomeBack: "إليك نظرة سريعة على أداء متجرك اليوم",
    conversations: "المحادثات",
    orders: "الطلبات",
    customers: "العملاء",
    conversion: "نسبة التحويل",
    aiMessages: "رسائل الذكاء الاصطناعي",
    needsHuman: "تحتاج تدخلًا بشريًا",
    recentConversations: "أحدث المحادثات",
    recentOrders: "أحدث الطلبات",
    topProducts: "الأكثر مبيعًا",
    salesOverview: "نظرة على المبيعات",
    viewInbox: "فتح صندوق المحادثات",
    viewOrders: "عرض الطلبات",
    emptyActivity: "لا يوجد نشاط بعد",
    emptyActivityDesc: "ستظهر هنا أحدث المحادثات والطلبات فور وصولها.",
  },
  pages: {
    mediaTitle: "مكتبة الوسائط",
    mediaDesc: "صور المنتجات والفيديوهات والمرفقات في مكان واحد.",
    feedbackTitle: "آراء العملاء",
    feedbackDesc: "قيّم رضا العملاء واعتمد الشهادات المميزة.",
    knowledgeTitle: "قاعدة المعرفة",
    knowledgeDesc: "مستندات وأسئلة شائعة يتعلّم منها الذكاء الاصطناعي الرد على عملائك.",
    personasTitle: "شخصية الذكاء الاصطناعي",
    personasDesc: "حدّد نبرة المساعد وأسلوبه وحدود ردوده.",
    playgroundTitle: "تجربة الذكاء الاصطناعي",
    playgroundDesc: "جرّب ردود المساعد قبل وصولها إلى العملاء.",
    channelsTitle: "القنوات",
    channelsDesc: "اربط صفحات فيسبوك وأدر حالة الاتصال.",
    automationTitle: "الأتمتة",
    automationDesc: "قواعد تلقائية تتفاعل مع الأحداث دون تدخل يدوي.",
    followupsTitle: "المتابعات",
    followupsDesc: "رسائل مجدولة لإعادة إشراك العملاء وإتمام الطلبات.",
    handoffsTitle: "التسليم للموظفين",
    handoffsDesc: "محادثات تحتاج تدخلًا بشريًا مع أولويات وأسباب واضحة.",
    analyticsTitle: "التحليلات",
    analyticsDesc: "مؤشرات الأداء والمبيعات ونشاط الذكاء الاصطناعي.",
    settingsTitle: "الإعدادات",
    settingsDesc: "إعدادات مساحة العمل والحساب.",
    aiSettingsTitle: "إعدادات الذكاء الاصطناعي",
    aiSettingsDesc: "المزود والنماذج وعتبات الثقة والرد التلقائي.",
    customersTitle: "العملاء",
    customersDesc: "جميع عملائك ونشاطهم وطلباتهم في مكان واحد.",
    productsTitle: "المنتجات",
    productsDesc: "أدر الكتالوج والأسعار والمخزون والوسائط.",
  },
  theme: { light: "الوضع النهاري", dark: "الوضع الليلي" },
  a11y: {
    openMenu: "فتح القائمة",
    closeMenu: "إغلاق القائمة",
    toggleTheme: "تبديل الوضع",
    mainNav: "التنقل الرئيسي",
    closePanel: "إغلاق اللوحة",
  },
};

/** Arabic labels for raw enum values coming from the API. */
export const LABELS: Record<string, string> = {
  // Conversation status
  OPEN: "مفتوحة",
  PENDING: "قيد الانتظار",
  RESOLVED: "تم الحل",
  CLOSED: "مغلقة",
  // Priority
  LOW: "منخفضة",
  NORMAL: "عادية",
  HIGH: "عالية",
  URGENT: "عاجلة",
  // Customer status
  NEW_LEAD: "عميل جديد",
  INTERESTED: "مهتم",
  CONSIDERING: "يضع القرار",
  READY_TO_BUY: "جاهز للشراء",
  ORDERED: "طلب سابق",
  REPEAT_CUSTOMER: "عميل متكرر",
  AT_RISK: "عرضة للفقد",
  BLOCKED: "محظور",
  // Order status
  NEW: "جديد",
  CONFIRMATION_PENDING: "قيد التأكيد",
  CONFIRMED: "مؤكد",
  PROCESSING: "قيد المعالجة",
  OUT_FOR_DELIVERY: "قيد التوصيل",
  DELIVERED: "تم التوصيل",
  CANCELLED: "ملغى",
  FAILED: "فشل",
  RETURNED: "مُرجَع",
  // Confirmation status
  CONFIRMED_BY_CUSTOMER: "مؤكد من العميل",
  CONFIRMED_BY_AGENT: "مؤكد من الموظف",
  DECLINED: "مرفوض",
  // Payment / fulfillment
  UNPAID: "غير مدفوع",
  PAID: "مدفوع",
  REFUNDED: "مُسترد",
  COD: "الدفع عند الاستلام",
  UNFULFILLED: "لم تُجهَّز",
  PREPARING: "قيد التجهيز",
  SHIPPED: "تم الشحن",
  // Channels
  FACEBOOK: "فيسبوك ماسنجر",
  INSTAGRAM: "إنستغرام",
  WHATSAPP: "واتساب",
  TELEGRAM: "تيليغرام",
  WEB: "الويب",
  CONNECTED: "متصل",
  DISCONNECTED: "غير متصل",
  CONNECTING: "جارٍ الاتصال",
  // Stock
  IN_STOCK: "متوفر",
  OUT_OF_STOCK: "غير متوفر",
  PRE_ORDER: "طلب مسبق",
  DISCONTINUED: "متوقف",
  // Jobs / follow-ups (statuses shared with orders keep their first definition)
  DONE: "مكتمل",
  SCHEDULED: "مجدولة",
  RUNNING: "جارٍ التنفيذ",
  SENT: "أُرسلت",
  SKIPPED: "متجاوزة",
};

export function label(v: string | null | undefined): string {
  if (!v) return "—";
  return LABELS[v] ?? v;
}

/** Relative time in natural Arabic. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "الآن";
  if (mins < 60) return `قبل ${mins} د`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `قبل ${hours} س`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `قبل ${days} يوم`;
  return new Date(iso).toLocaleDateString("ar", { day: "numeric", month: "short" });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ar", { day: "numeric", month: "long" });
}

export function formatNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return isNaN(n) ? String(value) : n.toLocaleString("ar", { maximumFractionDigits: 2 });
}