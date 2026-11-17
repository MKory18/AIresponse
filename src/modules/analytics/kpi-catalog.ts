import type { Permission } from "@/modules/rbac/permissions";
import { median } from "@/core/analytics/time";
import type { ReportData, RptOrder } from "./report-data";

/**
 * كتالوج المؤشرات (3.7، 05-DASHBOARDS §4) — **مصدر واحد**: لكل مؤشر `{ key, label, formula, compute }`.
 * الواجهة (ⓘ) والتصدير والاختبارات كلهم منه: المعادلة المكتوبة للمستخدم هي نفسها المنفّذة.
 *
 * قواعد عامة: الفترة `[بداية، نهاية)` بمنطقة المساحة · المبالغ بتنجمع لكل عملة لحالها (ما بتنجمع عملتين أبدًا) ·
 * بلا ضرائب · «طلب» = طلب **مثبّت** إلا إذا مكتوب غير هيك · مقام صفر = «غير متاح» (null) مش 0%.
 */

export type KpiTab = "sales" | "conversations" | "agent" | "team";
export const KPI_TABS: ReadonlyArray<{ key: KpiTab; label: string }> = [
  { key: "sales", label: "المبيعات" },
  { key: "conversations", label: "المحادثات" },
  { key: "agent", label: "الوكيل" },
  { key: "team", label: "الفريق" },
];

export interface MoneyLine {
  currency: string;
  value: number;
}
export interface Column {
  key: string;
  label: string;
}
export type KpiValue =
  | { kind: "count"; value: number; note?: string }
  | { kind: "percent"; value: number | null; num: number; den: number; note?: string }
  | { kind: "minutes"; value: number | null; n: number; note?: string }
  | { kind: "money"; value: MoneyLine[]; note?: string }
  | { kind: "rows"; columns: Column[]; rows: Array<Record<string, string | number | null>>; note?: string }
  | { kind: "unavailable"; reason: string };

export interface KpiDef {
  key: string;
  tab: KpiTab;
  label: string;
  /** المعادلة بالعربي (بتظهر بـⓘ وبالتصدير). */
  formula: string;
  /** صلاحية إضافية فوق `analytics.read`. */
  permission?: Permission;
  /** تفاصيل تقنية (مطوية). */
  technical?: boolean;
  compute: (d: ReportData) => KpiValue;
}

// ── أدوات صرفة ─────────────────────────────────────────────────────────────

const SEALED_STATUSES = new Set(["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED"]);
/** مثبّت = `sealedAt` (طلبات القارئ) أو حالة بعد التأكيد (طلبات قديمة). */
export const isSealedOrder = (o: Pick<RptOrder, "sealedAt" | "status">) => Boolean(o.sealedAt) || SEALED_STATUSES.has(o.status);

const up = (v: unknown) => String(v ?? "").trim().toUpperCase();
const OMS_REJECTED = new Set(["REJECTED", "CANCELLED", "CANCELED"]);
const OMS_CONFIRMED = new Set(["CONFIRMED", "DELIVERED", "RETURNED"]);

/** نتيجة الطلب عند الـ OMS: مؤكد · مرفوض/ملغى · عند فريق التأكيد · ما انبعت. */
export function omsOutcome(o: Pick<RptOrder, "omsOrderId" | "omsStatus" | "status">): "confirmed" | "rejected" | "pending" | "unsent" {
  if (!o.omsOrderId) return "unsent";
  const s = up(o.omsStatus);
  if (OMS_REJECTED.has(s) || o.status === "CANCELLED" || o.status === "FAILED") return "rejected";
  if (OMS_CONFIRMED.has(s) || ["PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED"].includes(o.status)) return "confirmed";
  return "pending";
}

/** جمع نقدي بالسنتات لكل عملة (بلا انجراف الفاصلة العائمة)، مرتّب بالرمز. */
export function sumByCurrency(items: Array<{ currency: string; amount: number }>): MoneyLine[] {
  const cents = new Map<string, number>();
  for (const i of items) cents.set(i.currency, (cents.get(i.currency) ?? 0) + Math.round((Number.isFinite(i.amount) ? i.amount : 0) * 100));
  return [...cents.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, c]) => ({ currency, value: c / 100 }));
}

const pct = (num: number, den: number, note?: string): KpiValue => ({ kind: "percent", value: den > 0 ? (num / den) * 100 : null, num, den, ...(note ? { note } : {}) });
const count = (value: number, note?: string): KpiValue => ({ kind: "count", value, ...(note ? { note } : {}) });

/** مدة الانتظار اللي بعدها «بلا رد» بتنحسب (دقايق). */
export const UNANSWERED_AFTER_MIN = 10;

// ── القمع (على نفس مجموعة المحادثات) ───────────────────────────────────────

export interface FunnelStage {
  key: "new" | "intent" | "ordered" | "sealed" | "oms_confirmed" | "delivered";
  label: string;
  count: number;
  /** نسبتها من اللي قبلها (null للأولى أو إذا اللي قبلها صفر). */
  rateFromPrev: number | null;
}

/**
 * محادثات جديدة ← نية شراء ← طلب مكتمل ← مثبّت ← أكّده الـ OMS ← تسلّم. كل مرحلة مجموعة جزئية من اللي قبلها
 * (يعني النسبة ما بتتخطى 100%)، والمحادثة بتنعدّ بالمرحلة اللي وصلت إلها **مرة وحدة** حتى لو إلها أكتر من طلب.
 * المسودات خارج الحساب: النية من `firstOrderingAt` أو من وجود طلب فعلي.
 */
export function funnelStages(d: ReportData): FunnelStage[] {
  const ids = new Set(d.conversations.map((c) => c.id));
  const byConv = new Map<string, RptOrder[]>();
  for (const o of d.cohortOrders) {
    if (!o.conversationId || !ids.has(o.conversationId)) continue;
    (byConv.get(o.conversationId) ?? byConv.set(o.conversationId, []).get(o.conversationId)!).push(o);
  }
  let intent = 0, ordered = 0, sealed = 0, oms = 0, delivered = 0;
  for (const c of d.conversations) {
    const orders = byConv.get(c.id) ?? [];
    const hasOrder = orders.length > 0;
    const hasSealed = orders.some(isSealedOrder);
    const hasOms = orders.some((o) => isSealedOrder(o) && omsOutcome(o) === "confirmed");
    const hasDelivered = orders.some((o) => isSealedOrder(o) && o.status === "DELIVERED");
    if (!(c.firstOrderingAt || hasOrder)) continue;
    intent += 1;
    if (!hasOrder) continue;
    ordered += 1;
    if (!hasSealed) continue;
    sealed += 1;
    if (!hasOms && !hasDelivered) continue;
    oms += 1;
    if (hasDelivered) delivered += 1;
  }
  const raw: Array<[FunnelStage["key"], string, number]> = [
    ["new", "محادثات جديدة", d.conversations.length],
    ["intent", "فيها نية شراء", intent],
    ["ordered", "طلب مكتمل", ordered],
    ["sealed", "مثبّت", sealed],
    ["oms_confirmed", "أكّده الـ OMS", oms],
    ["delivered", "تسلّم", delivered],
  ];
  return raw.map(([key, label, n], i) => ({ key, label, count: n, rateFromPrev: i === 0 || raw[i - 1]![2] === 0 ? null : n / raw[i - 1]![2] }));
}

// ── أسباب فشل الوكيل بالعربي (بلا نص خام ولا بيانات) ──────────────────────

const FAILURE_REASONS: Array<{ reason: string; test: RegExp; fix: string; href: string }> = [
  { reason: "رفض الحارس", test: /guardrail|\bguard\b|blocked|رفض/i, fix: "راجع المحادثات اللي انرفض ردها وصحّح التعليمات.", href: "/conversations" },
  { reason: "مهلة", test: /time(?:d)?[\s_-]?out|ETIMEDOUT|مهلة|deadline/i, fix: "جرّب مزوّد أسرع أو أعد المحاولة.", href: "/settings/ai" },
  { reason: "مفتاح أو رصيد", test: /\b40[123]\b|api[\s_-]?key|unauthori[sz]ed|quota|insufficient|credit|billing|payment|مفتاح|رصيد/i, fix: "تأكد من مفتاح المزوّد ورصيده.", href: "/settings/ai" },
  { reason: "المزوّد واقع", test: /\b5\d\d\b|unavailable|overload|ECONN|ENOTFOUND|fetch failed|bad gateway|rate[\s_-]?limit|\b429\b/i, fix: "المزوّد بحاله؛ فعّل مزوّد بديل أو انتظر.", href: "/settings/ai" },
];

export function classifyFailure(f: { error: string | null; status: string }): { reason: string; fix: string; href: string } {
  const text = `${f.status} ${f.error ?? ""}`;
  for (const r of FAILURE_REASONS) if (r.test.test(text)) return { reason: r.reason, fix: r.fix, href: r.href };
  return { reason: "غير مصنّف", fix: "افتح صفحة الوكيل ← الحالة لتفاصيل الأخطاء.", href: "/settings/ai" };
}

// ── الكتالوج ───────────────────────────────────────────────────────────────

const noOrders = (d: ReportData) => d.sealed.length;

export const KPI_CATALOG: KpiDef[] = [
  // المبيعات (§4.1)
  {
    key: "sales.sealed",
    tab: "sales",
    label: "طلبات مثبّتة",
    formula: "عدد الطلبات اللي لحظة تثبيتها ضمن الفترة. الطلبات القديمة (قبل قارئ الطلب) بتنحسب بتاريخ إنشائها.",
    compute: (d) => count(d.sealed.length),
  },
  {
    key: "sales.value",
    tab: "sales",
    label: "قيمة الطلبات",
    formula: "مجموع إجمالي الطلبات المثبّتة بالفترة، لكل عملة لحالها (ما بنجمع عملتين). بلا ضرائب.",
    compute: (d) => ({ kind: "money", value: sumByCurrency(d.sealed.map((o) => ({ currency: o.currency, amount: o.total }))) }),
  },
  {
    key: "sales.avg_value",
    tab: "sales",
    label: "متوسط قيمة الطلب",
    formula: "قيمة الطلبات ÷ عددها، لكل عملة لحالها.",
    compute: (d) => {
      const byCur = new Map<string, number>();
      for (const o of d.sealed) byCur.set(o.currency, (byCur.get(o.currency) ?? 0) + 1);
      return {
        kind: "money",
        value: sumByCurrency(d.sealed.map((o) => ({ currency: o.currency, amount: o.total }))).map((l) => ({ currency: l.currency, value: Math.round((l.value / (byCur.get(l.currency) ?? 1)) * 100) / 100 })),
      };
    },
  },
  {
    key: "sales.conversion",
    tab: "sales",
    label: "نسبة التحويل",
    formula: "محادثات انفتحت بالفترة وإلها طلب مثبّت واحد على الأقل ÷ كل المحادثات اللي انفتحت بالفترة (نفس المجموعة — ما بتتخطى 100%).",
    compute: (d) => {
      const stages = funnelStages(d);
      return pct(stages[3]!.count, stages[0]!.count);
    },
  },
  {
    key: "sales.oms_confirm",
    tab: "sales",
    label: "نسبة تأكيد الـ OMS",
    formula: "من الطلبات المثبّتة والمرسلة للـ OMS: اللي أكّدها ÷ (اللي أكّدها + اللي رفضها أو ألغاها). اللي لسا عند فريق التأكيد بتنعرض جنبها كعدد وما بتدخل بالنسبة.",
    compute: (d) => {
      const out = d.sealed.map(omsOutcome);
      const c = out.filter((x) => x === "confirmed").length;
      const r = out.filter((x) => x === "rejected").length;
      const p = out.filter((x) => x === "pending").length;
      return pct(c, c + r, `عند فريق التأكيد: ${p}`);
    },
  },
  {
    key: "sales.delivery_rate",
    tab: "sales",
    label: "نسبة التسليم",
    formula: "من الطلبات المثبّتة بالفترة: المسلّمة ÷ (المسلّمة + المرتجعة). «بالطريق» بتنعرض جنبها كعدد.",
    compute: (d) => {
      const delivered = d.sealed.filter((o) => o.status === "DELIVERED").length;
      const returned = d.sealed.filter((o) => o.status === "RETURNED").length;
      const way = d.sealed.filter((o) => o.status === "OUT_FOR_DELIVERY").length;
      return pct(delivered, delivered + returned, `بالطريق: ${way}`);
    },
  },
  {
    key: "sales.amend_rate",
    tab: "sales",
    label: "تعديل بعد التثبيت",
    formula: "طلبات مثبّتة بالفترة إلها طلب تعديل أو إلغاء بعد التثبيت ÷ الطلبات المثبّتة. هاد مقياس «مهلة التثبيت»: إذا عالي، المهلة قصيرة.",
    compute: (d) => {
      const ids = new Set(d.revisions.filter((r) => r.kind === "AMEND_REQUEST" || r.kind === "CANCEL_REQUEST").map((r) => r.orderId));
      const sealedIds = new Set(d.sealed.map((o) => o.id));
      return pct([...ids].filter((id) => sealedIds.has(id)).length, noOrders(d));
    },
  },
  {
    key: "sales.pre_seal_cancel",
    tab: "sales",
    label: "تراجع قبل التثبيت",
    formula: "طلبات انلغت وهي لسا بلا تثبيت ÷ كل الطلبات اللي انخلقت بالفترة.",
    compute: (d) => pct(d.created.filter((o) => o.status === "CANCELLED" && !o.sealedAt).length, d.created.length),
  },
  {
    key: "sales.top_products",
    tab: "sales",
    label: "أكثر المنتجات",
    formula: "مجموع الكميات وقيمة السطور (قبل التوصيل) من بنود الطلبات المثبّتة بالفترة، لكل منتج وعملة.",
    compute: (d) => {
      const rows = new Map<string, { product: string; currency: string; quantity: number; cents: number }>();
      for (const i of d.items) {
        const k = `${i.productId}|${i.currency}`;
        const r = rows.get(k) ?? { product: i.name, currency: i.currency, quantity: 0, cents: 0 };
        r.quantity += i.quantity;
        r.cents += Math.round(i.subtotal * 100);
        rows.set(k, r);
      }
      const sorted = [...rows.values()].sort((a, b) => b.quantity - a.quantity || b.cents - a.cents).slice(0, 10);
      return {
        kind: "rows",
        columns: [
          { key: "product", label: "المنتج" },
          { key: "quantity", label: "الكمية" },
          { key: "value", label: "القيمة" },
          { key: "currency", label: "العملة" },
        ],
        rows: sorted.map((r) => ({ product: r.product, quantity: r.quantity, value: r.cents / 100, currency: r.currency })),
      };
    },
  },
  {
    key: "sales.by_page",
    tab: "sales",
    label: "حسب الصفحة",
    formula: "الطلبات المثبّتة بالفترة وقيمتها لكل صفحة، لكل عملة لحالها.",
    compute: (d) => {
      const rows = new Map<string, { page: string; currency: string; orders: number; cents: number }>();
      for (const o of d.sealed) {
        const page = d.pageOfOrder[o.id] ?? "غير محدّدة";
        const k = `${page}|${o.currency}`;
        const r = rows.get(k) ?? { page, currency: o.currency, orders: 0, cents: 0 };
        r.orders += 1;
        r.cents += Math.round(o.total * 100);
        rows.set(k, r);
      }
      return {
        kind: "rows",
        columns: [
          { key: "page", label: "الصفحة" },
          { key: "orders", label: "الطلبات" },
          { key: "value", label: "القيمة" },
          { key: "currency", label: "العملة" },
        ],
        rows: [...rows.values()].sort((a, b) => b.orders - a.orders).map((r) => ({ page: r.page, orders: r.orders, value: r.cents / 100, currency: r.currency })),
      };
    },
  },

  // المحادثات (§4.2)
  {
    key: "conversations.new",
    tab: "conversations",
    label: "محادثات جديدة",
    formula: "عدد المحادثات اللي انفتحت بالفترة.",
    compute: (d) => count(d.conversations.length),
  },
  {
    key: "conversations.funnel",
    tab: "conversations",
    label: "القمع",
    formula: "محادثات جديدة ← فيها نية شراء ← طلب مكتمل ← مثبّت ← أكّده الـ OMS ← تسلّم. كل مرحلة عدد ونسبتها من اللي قبلها، على نفس مجموعة المحادثات.",
    compute: (d) => ({
      kind: "rows",
      columns: [
        { key: "stage", label: "المرحلة" },
        { key: "count", label: "العدد" },
        { key: "rate", label: "من اللي قبلها %" },
      ],
      rows: funnelStages(d).map((s) => ({ stage: s.label, count: s.count, rate: s.rateFromPrev === null ? null : Math.round(s.rateFromPrev * 1000) / 10 })),
    }),
  },
  {
    key: "conversations.first_reply",
    tab: "conversations",
    label: "زمن أول رد",
    formula: `وسيط (أول رد − أول رسالة) للمحادثات الجديدة. المحادثة بلا رد لأكتر من ${UNANSWERED_AFTER_MIN} دقايق بتنحسب بزمن انتظارها الفعلي لهلأ (ما بتنشال).`,
    compute: (d) => {
      const values: number[] = [];
      let unanswered = 0;
      for (const c of d.conversations) {
        if (!c.firstInboundAt) continue;
        const inAt = c.firstInboundAt.getTime();
        if (c.firstOutboundAt && c.firstOutboundAt.getTime() >= inAt) values.push((c.firstOutboundAt.getTime() - inAt) / 60_000);
        else if (!c.firstOutboundAt) {
          const waited = (d.now.getTime() - inAt) / 60_000;
          if (waited > UNANSWERED_AFTER_MIN) {
            values.push(waited);
            unanswered += 1;
          }
        }
      }
      return { kind: "minutes", value: median(values), n: values.length, note: `بلا رد: ${unanswered}` };
    },
  },
  {
    key: "conversations.unanswered_now",
    tab: "conversations",
    label: "بلا رد الآن",
    formula: `محادثات آخر رسالة فيها من العميل قبل أكتر من ${UNANSWERED_AFTER_MIN} دقايق وما انردّ عليها، من آخر 24 ساعة. رقم لحظي: مش حسب الفترة المختارة.`,
    compute: (d) => count(d.unansweredNow, "لحظي"),
  },
  {
    key: "conversations.taken_over",
    tab: "conversations",
    label: "استلمها موظف",
    formula: "عدد المحادثات اللي صار فيها «استلم المحادثة» بالفترة.",
    compute: (d) => count(d.takenOver),
  },

  // الوكيل (§4.3)
  {
    key: "agent.replies",
    tab: "agent",
    label: "ردود الوكيل",
    formula: "رسائل صادرة مرسلها الوكيل بالفترة (بدون الملاحظات الداخلية).",
    compute: (d) => count(d.agentReplies),
  },
  {
    key: "agent.reply_success",
    tab: "agent",
    label: "نجاح الرد",
    formula: "رسائل عملاء أخدت رد من الوكيل ÷ رسائل عملاء كان لازم يرد عليها (محادثتها بوضع «الوكيل يرد»). الرسالة المغطّاة برد أحدث (رشقة رسائل) محسوبة ناجحة.",
    compute: (d) => pct(d.customerMessages.answered, d.customerMessages.needed),
  },
  {
    key: "agent.read_accuracy",
    tab: "agent",
    label: "دقة القراءة",
    formula: "طلبات مثبّتة بلا أي تعديل موظف وبلا سبب مراجعة ÷ الطلبات المثبّتة.",
    compute: (d) => {
      const edited = new Set(d.revisions.filter((r) => r.kind === "STAFF_EDIT").map((r) => r.orderId));
      const clean = d.sealed.filter((o) => !edited.has(o.id) && o.reviewReasons.length === 0).length;
      return pct(clean, d.sealed.length);
    },
  },
  {
    key: "agent.needs_review",
    tab: "agent",
    label: "يحتاج مراجعة",
    formula: "طلبات دخلت «تحتاج مراجعة» (فيها سبب مراجعة) ÷ الطلبات اللي انخلقت بالفترة. التفصيل حسب السبب بالجدول.",
    compute: (d) => pct(d.created.filter((o) => o.reviewReasons.length > 0 || o.status === "CONFIRMATION_PENDING").length, d.created.length),
  },
  {
    key: "agent.ai_promise",
    tab: "agent",
    label: "وعد بلا طلب",
    formula: "عدد المرات اللي الوكيل وعد فيها بتثبيت طلب والبيانات ناقصة (بند «يحتاجك») بالفترة. المطلوب: صفر.",
    compute: (d) => count(d.aiPromises),
  },
  {
    key: "agent.cost",
    tab: "agent",
    label: "الكلفة",
    permission: "usage.read",
    formula: "مجموع كلفة الاستهلاك المعروف بالدولار + عدد النداءات بلا سعر معروف (ما بنعرض مجموع ناقص كأنه كامل).",
    compute: (d) => {
      if (d.cost.calls === 0) return { kind: "unavailable", reason: "ما في نداءات بالفترة." };
      if (d.cost.calls === d.cost.unknownCalls) return { kind: "unavailable", reason: "ما في سعر معروف لهالنماذج؛ حدّد الأسعار بإعدادات الوكيل." };
      return { kind: "money", value: [{ currency: "USD", value: Math.round(d.cost.knownUsd * 10000) / 10000 }], note: `${d.cost.unknownCalls} نداء بلا سعر معروف` };
    },
  },
  {
    key: "agent.failures",
    tab: "agent",
    label: "أسباب الفشل",
    formula: "محاولات الرد الفاشلة بالفترة مجمّعة بسبب بالعربي (مهلة · مفتاح أو رصيد · المزوّد واقع · رفض الحارس) وكل سبب معه رابط الحل.",
    compute: (d) => {
      const g = new Map<string, { reason: string; count: number; fix: string; href: string }>();
      for (const f of d.failures) {
        const c = classifyFailure(f);
        const r = g.get(c.reason) ?? { ...c, count: 0 };
        r.count += 1;
        g.set(c.reason, r);
      }
      return {
        kind: "rows",
        columns: [
          { key: "reason", label: "السبب" },
          { key: "count", label: "العدد" },
          { key: "fix", label: "الحل" },
        ],
        rows: [...g.values()].sort((a, b) => b.count - a.count).map((r) => ({ reason: r.reason, count: r.count, fix: r.fix, href: r.href })),
      };
    },
  },

  // الفريق (§4.4)
  {
    key: "team.agents",
    tab: "team",
    label: "أداء الموظفين",
    permission: "analytics.agents",
    formula: "لكل موظف: محادثات مسندة إله · ردوده · وسيط زمن أول رد على محادثاته · بنود «يحتاجك» اللي استلمها وحلّها · طلبات محادثاته. الإسناد الرسمي بس، مش «آخر شخص شاف».",
    compute: (d) => ({
      kind: "rows",
      columns: [
        { key: "name", label: "الموظف" },
        { key: "assigned", label: "محادثات مسندة" },
        { key: "replies", label: "ردوده" },
        { key: "first_reply", label: "وسيط أول رد (د)" },
        { key: "claimed", label: "بنود استلمها" },
        { key: "resolved", label: "بنود حلّها" },
        { key: "orders", label: "طلبات محادثاته" },
      ],
      rows: d.team.map((t) => ({
        name: t.name,
        assigned: t.conversationsAssigned,
        replies: t.repliesSent,
        first_reply: t.firstResponseMedianMinutes === null ? null : Math.round(t.firstResponseMedianMinutes * 10) / 10,
        claimed: t.handoffsClaimed,
        resolved: t.handoffsResolved,
        orders: t.ordersLinked,
      })),
    }),
  },
];

export function kpiByKey(key: string): KpiDef | undefined {
  return KPI_CATALOG.find((k) => k.key === key);
}

export function computeKpi(def: KpiDef, d: ReportData): KpiValue {
  return def.compute(d);
}

export function kpisForTab(tab: KpiTab): KpiDef[] {
  return KPI_CATALOG.filter((k) => k.tab === tab);
}
