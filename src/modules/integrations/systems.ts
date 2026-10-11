/**
 * P12 — سجل أنظمة منظومة Zaki التي يحكي معها سيستم 7 (الردود).
 *
 * في الكود لا في جدول: ما يدعمه الكود هو الكود نفسه — صف «الكليبر متاح»
 * في قاعدة بيانات قد يكذب يوم يتغير المحوّل. الجدول يحفظ الاتصال فقط
 * (الرابط والتوكن والسر)، وهذا الملف يقول ماذا يعني كل نظام.
 *
 * المرجع: ملفات العقود لكل نظام (الميديا باير IN03/IN04 · الكليبر IN02–IN04 ·
 * المالية IN02/IN03 · سيستم 1 IN04 · Hermes IN01–IN04). أسماء الأحداث
 * والمسارات هنا حرفية من تلك العقود.
 */

export const ZAKI_SYSTEMS = [
  "oms",
  "mediabuyer",
  "clipper",
  "finance",
  "s1",
  "crisis",
  "tasks",
  "workspace",
  "bridge",
] as const;
export type ZakiSystem = (typeof ZAKI_SYSTEMS)[number];

/** الأنظمة التي تُحفظ اتصالاتها في IntegrationConnection (الـ OMS له جدوله). */
export const GENERIC_SYSTEMS = ZAKI_SYSTEMS.filter((s) => s !== "oms") as Exclude<ZakiSystem, "oms">[];
export type GenericSystem = (typeof GENERIC_SYSTEMS)[number];

export function isZakiSystem(v: string): v is ZakiSystem {
  return (ZAKI_SYSTEMS as readonly string[]).includes(v);
}
export function isGenericSystem(v: string): v is GenericSystem {
  return (GENERIC_SYSTEMS as readonly string[]).includes(v);
}

/** الأحداث التي يرسلها سيستم 7 — والجهات التي تستقبل كل حدث (من العقود). */
export const OUTBOUND_EVENT_ROUTES = {
  // الكليبر IN02: POST {CLIPPER}/api/v1/webhooks/replies
  "conversation.coded": ["clipper"],
  "retarget.result": ["clipper"],
  opt_out: ["clipper"],
  // الميديا باير IN04 (قاعدة قدرة الرد) + جسر Hermes IN04 (درجة «عاجل»)
  "capacity.alert": ["mediabuyer", "bridge"],
} as const satisfies Record<string, readonly GenericSystem[]>;
export type OutboundEventType = keyof typeof OUTBOUND_EVENT_ROUTES;
export const OUTBOUND_EVENT_TYPES = Object.keys(OUTBOUND_EVENT_ROUTES) as OutboundEventType[];

/** الأحداث التي يقبلها سيستم 7 على POST /api/v1/webhooks/{system}. */
export const INBOUND_EVENT_TYPES: Partial<Record<GenericSystem, readonly string[]>> = {
  // سيستم 1 IN04: compliance.updated لكل الأنظمة التي تكتب عن منتج
  s1: ["compliance.updated"],
};

/** صلاحيات التوكنات الداخلة على سيستم 7 — مسماة وبأقل حد. */
export const TOKEN_SCOPES = [
  "capacity.read",
  "retarget.create",
  "retarget.read",
  "agent.read",
  "agent.draft",
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** أصحاب التوكنات وصلاحياتهم الافتراضية (لا أكثر). */
export const TOKEN_PRESETS = {
  mediabuyer: { nameAr: "الميديا باير", scopes: ["capacity.read"] },
  clipper: { nameAr: "الكليبر", scopes: ["retarget.create", "retarget.read"] },
  "hermes-bridge": { nameAr: "جسر Hermes (zaki-bridge)", scopes: ["agent.read", "agent.draft"] },
} as const satisfies Record<string, { nameAr: string; scopes: readonly TokenScope[] }>;
export type TokenSystem = keyof typeof TOKEN_PRESETS;
export const TOKEN_SYSTEMS = Object.keys(TOKEN_PRESETS) as TokenSystem[];

export interface SystemCall {
  name: string;
  method: "GET" | "POST";
  path: string;
  descAr: string;
}

export interface SystemSpec {
  key: ZakiSystem;
  nameAr: string;
  summaryAr: string;
  /** المسار الافتراضي عند النظام لاستقبال أحداث سيستم 7 (إذا يستقبل). */
  eventsPath?: string;
  /** ما يرسله سيستم 7 لهذا النظام من أحداث. */
  sendsEvents: readonly string[];
  /** ما ينادِيه سيستم 7 عند هذا النظام. */
  calls: readonly SystemCall[];
  /** ما ينادِيه هذا النظام عند سيستم 7. */
  inbound: readonly { method: string; path: string; descAr: string }[];
  needsToken: boolean;
  needsEventsSecret: boolean;
}

export const SYSTEM_SPECS: Record<ZakiSystem, SystemSpec> = {
  oms: {
    key: "oms",
    nameAr: "Zaki OMS — الطلبات",
    summaryAr: "مالك الطلبات بعد التأكيد والأسعار والعروض والقائمة السوداء. سيستم 7 يرحّل الطلب المؤكد ويستقبل حالاته.",
    sendsEvents: [],
    calls: [
      { name: "products", method: "GET", path: "/api/v1/products?for=replies", descAr: "المنتجات والعروض وسقف الخصم" },
      { name: "customer-lookup", method: "GET", path: "/api/v1/customers/lookup?phone=", descAr: "هل الزبون موجود · القائمة السوداء" },
      { name: "create-order", method: "POST", path: "/api/v1/orders", descAr: "طلب مؤكد + مفتاح عدم تكرار + الإسناد" },
      { name: "order-note", method: "POST", path: "/api/v1/orders/{id}/notes", descAr: "ملاحظة متابعة مصنّفة" },
    ],
    inbound: [
      { method: "POST", path: "/api/webhooks/oms/{key}", descAr: "أحداث تطبيقات الـ OMS: order.created/confirmed/shipped/delivered/returned/cancelled" },
    ],
    needsToken: true,
    needsEventsSecret: true,
  },
  mediabuyer: {
    key: "mediabuyer",
    nameAr: "الميديا باير",
    summaryAr: "يقرأ قدرة الرد كل 30 دقيقة ويستقبل إنذار القدرة لتجميد تكبير حملات الرسائل.",
    eventsPath: "/api/v1/webhooks/replies",
    sendsEvents: OUTBOUND_EVENT_TYPES.filter((t) => (OUTBOUND_EVENT_ROUTES[t] as readonly string[]).includes("mediabuyer")),
    calls: [],
    inbound: [{ method: "GET", path: "/api/v1/capacity", descAr: "الرسائل بلا رد · وسيط أول رد · لكل قناة" }],
    needsToken: false,
    needsEventsSecret: true,
  },
  clipper: {
    key: "clipper",
    nameAr: "منصة الكليبر",
    summaryAr: "الرموز من أول رسالة · حملات إعادة التواصل للموافقين فقط · نتائجها وإلغاء الاشتراك.",
    eventsPath: "/api/v1/webhooks/replies",
    sendsEvents: OUTBOUND_EVENT_TYPES.filter((t) => (OUTBOUND_EVENT_ROUTES[t] as readonly string[]).includes("clipper")),
    calls: [{ name: "code", method: "GET", path: "/api/v1/codes/{code}", descAr: "صلاحية الرمز ومنتجه ونافذته" }],
    inbound: [
      { method: "POST", path: "/api/v1/retarget-campaigns", descAr: "حملة إعادة تواصل معتمدة (Idempotency-Key)" },
      { method: "GET", path: "/api/v1/retarget-campaigns/{id}", descAr: "حالة الحملة وأعدادها" },
    ],
    needsToken: true,
    needsEventsSecret: true,
  },
  finance: {
    key: "finance",
    nameAr: "المالية",
    summaryAr: "تقرير يومي بتكاليف الموديلات والسيرفر (usage-costs) — قيد مصروف بمصدره.",
    sendsEvents: [],
    calls: [{ name: "usage-costs", method: "POST", path: "/api/v1/usage-costs", descAr: "تكاليف اليوم بمفتاح replies-usage-وسم المساحة-التاريخ" }],
    inbound: [],
    needsToken: true,
    needsEventsSecret: false,
  },
  s1: {
    key: "s1",
    nameAr: "سيستم 1 — المنتجات والامتثال",
    summaryAr: "قواعد الادعاءات لكل منتج: المسموح والممنوع. الردود ما بتكتب ادعاء ممنوع حتى بالرسائل.",
    sendsEvents: [],
    calls: [{ name: "compliance", method: "GET", path: "/api/s1/v1/products/{ref}/compliance", descAr: "قواعد الادعاءات للمنتج" }],
    inbound: [{ method: "POST", path: "/api/v1/webhooks/s1", descAr: "compliance.updated — إعادة قراءة القواعد" }],
    needsToken: true,
    needsEventsSecret: true,
  },
  crisis: {
    key: "crisis",
    nameAr: "الأزمات",
    summaryAr: "إنذارات: قناة انقطعت · ضغط رسائل حرج.",
    sendsEvents: [],
    calls: [{ name: "alerts", method: "POST", path: "/api/v1/alerts", descAr: "إنذار بمرجع ودرجة ورسالة بلا بيانات شخصية" }],
    inbound: [],
    needsToken: true,
    needsEventsSecret: false,
  },
  tasks: {
    key: "tasks",
    nameAr: "المهام",
    summaryAr: "مهام للفريق: تحويلات بشرية متأخرة.",
    sendsEvents: [],
    calls: [{ name: "tasks", method: "POST", path: "/api/v1/tasks", descAr: "مهمة بمرجع ودور وموعد" }],
    inbound: [],
    needsToken: true,
    needsEventsSecret: false,
  },
  workspace: {
    key: "workspace",
    nameAr: "مساحة العمل",
    summaryAr: "أفكار أسبوعية من أكثر الأسئلة تكرارًا.",
    sendsEvents: [],
    calls: [{ name: "ideas", method: "POST", path: "/api/v1/ideas", descAr: "فكرة بعنوان وملخص ووسوم" }],
    inbound: [],
    needsToken: true,
    needsEventsSecret: false,
  },
  bridge: {
    key: "bridge",
    nameAr: "جسر Hermes (zaki-bridge)",
    summaryAr: "Hermes يقرأ أرقام الردود ويجهّز مسودات عبر باب الوكلاء، والجسر يستقبل إنذار القدرة.",
    eventsPath: "/events/replies",
    sendsEvents: OUTBOUND_EVENT_TYPES.filter((t) => (OUTBOUND_EVENT_ROUTES[t] as readonly string[]).includes("bridge")),
    calls: [],
    inbound: [
      { method: "GET", path: "/api/agent/tools", descAr: "دليل أدوات الردود لهالتوكن" },
      { method: "POST", path: "/api/agent/call", descAr: "نداء أداة قراءة أو مسودة" },
    ],
    needsToken: false,
    needsEventsSecret: true,
  },
};

/** يرجّع الجهات التي يجب أن تستقبل حدثًا معيّنًا (من جدول العقود فقط). */
export function targetsForEvent(type: string): GenericSystem[] {
  const route = (OUTBOUND_EVENT_ROUTES as Record<string, readonly GenericSystem[]>)[type];
  return route ? [...route] : [];
}
