import { orderStatusLabel } from "@/lib/order-status";
import { resolveRange, type TodayRange } from "./range";

/**
 * «اليوم» (3.3، 03 §5.1 + 05 §2): 4 أرقام بس، كل رقم معه **قاعدة احتسابه** (قاعدة المالك)، وقائمتين:
 * «بتتثبّت هلأ» و«آخر الطلبات». بلا ضرائب. المنطقة الزمنية = `Workspace.timezone`.
 * محسوب من الجداول الأصلية — ولا جدول جديد. «يحتاجك» من `GET /api/attention` (مصدر واحد).
 */

export interface Metric {
  key: "newConversations" | "sealedOrders" | "ordersValue" | "conversionRate";
  label: string;
  /** القيمة الخام؛ `null` = ما في عيّنة كافية (ما بنعرض 0% مضلّل). */
  value: number | null;
  /** فرق عن الفترة السابقة (نفس الوحدة)؛ `null` = ما في أساس للمقارنة. */
  delta: number | null;
  unit: "count" | "money" | "percent";
  currency: string | null;
  /** «كيف بنحسبه». */
  definition: string;
}

export interface SettlingOrder {
  id: string;
  orderNumber: string;
  settleAt: string;
  recipientName: string | null;
  items: string;
  conversationId: string | null;
}

export interface RecentOrder {
  id: string;
  orderNumber: string;
  status: string;
  statusTone: string;
  total: number;
  currency: string;
  createdAt: string;
}

export interface TodayData {
  range: TodayRange;
  timezone: string;
  prevLabel: string;
  metrics: Metric[];
  settling: SettlingOrder[];
  recent: RecentOrder[];
}

type Rows = Array<Record<string, unknown>>;
type Db = Record<string, { findMany(a: unknown): Promise<Rows>; findUnique(a: unknown): Promise<Record<string, unknown> | null>; count(a: unknown): Promise<number> }>;

/** الحالات اللي بنعدّها «مثبّتة»: بعد التجميع والمراجعة، وغير ملغية/فاشلة. */
export const SEALED_STATUSES = ["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED"] as const;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "");

export const DEFINITIONS = {
  newConversations: "عدد المحادثات اللي بلّشت بالفترة (أول رسالة من عميل جديد أو قديم بمحادثة جديدة).",
  sealedOrders: "الطلبات اللي انثبّتت (مش قيد التجميع ولا ملغاة ولا فاشلة) وانسجّلت بالفترة.",
  ordersValue: "مجموع قيمة الطلبات المثبّتة بالفترة، بعملة الطلبات الأكثر. بلا ضرائب.",
  conversionRate: "الطلبات المثبّتة ÷ المحادثات الجديدة بالفترة. بتظهر لما يكون في 5 محادثات على الأقل.",
} as const;

async function periodStats(db: Db, workspaceId: string, start: Date, end: Date) {
  const range = { gte: start, lt: end };
  const conversations = await db.conversation!.count({ where: { workspaceId, createdAt: range, deletedAt: null } });
  const orders = await db.order!.findMany({
    where: { workspaceId, createdAt: range, status: { in: [...SEALED_STATUSES] } },
    select: { total: true, currency: true },
    take: 5000,
  });
  const byCurrency = new Map<string, { count: number; sum: number }>();
  for (const o of orders) {
    const c = typeof o.currency === "string" && o.currency ? o.currency : "USD";
    const cur = byCurrency.get(c) ?? { count: 0, sum: 0 };
    cur.count += 1;
    cur.sum += num(o.total);
    byCurrency.set(c, cur);
  }
  return { conversations, sealed: orders.length, byCurrency };
}

function mainCurrency(map: Map<string, { count: number; sum: number }>): string | null {
  let best: string | null = null;
  for (const [c, v] of map) if (!best || v.count > (map.get(best)?.count ?? 0)) best = c;
  return best;
}

export async function getToday(dbIn: unknown, workspaceId: string, range: TodayRange, now: Date = new Date()): Promise<TodayData> {
  const db = dbIn as Db;
  const ws = await db.workspace!.findUnique({ where: { id: workspaceId }, select: { timezone: true } });
  const timezone = typeof ws?.timezone === "string" && ws.timezone ? ws.timezone : "UTC";
  const r = resolveRange(range, now, timezone);

  const [cur, prev] = await Promise.all([periodStats(db, workspaceId, r.start, r.end), periodStats(db, workspaceId, r.prevStart, r.prevEnd)]);
  const currency = mainCurrency(cur.byCurrency) ?? mainCurrency(prev.byCurrency);
  const valueOf = (s: typeof cur) => (currency ? s.byCurrency.get(currency)?.sum ?? 0 : 0);
  const rate = (s: typeof cur) => (s.conversations >= 5 ? Math.round((s.sealed / s.conversations) * 1000) / 10 : null);
  const curRate = rate(cur);
  const prevRate = rate(prev);

  const metrics: Metric[] = [
    { key: "newConversations", label: "محادثات جديدة", value: cur.conversations, delta: cur.conversations - prev.conversations, unit: "count", currency: null, definition: DEFINITIONS.newConversations },
    { key: "sealedOrders", label: "طلبات مثبّتة", value: cur.sealed, delta: cur.sealed - prev.sealed, unit: "count", currency: null, definition: DEFINITIONS.sealedOrders },
    { key: "ordersValue", label: "قيمة الطلبات", value: Math.round(valueOf(cur) * 100) / 100, delta: Math.round((valueOf(cur) - valueOf(prev)) * 100) / 100, unit: "money", currency, definition: DEFINITIONS.ordersValue },
    {
      key: "conversionRate",
      label: "نسبة التحويل",
      value: curRate,
      delta: curRate !== null && prevRate !== null ? Math.round((curRate - prevRate) * 10) / 10 : null,
      unit: "percent",
      currency: null,
      definition: DEFINITIONS.conversionRate,
    },
  ];

  // بتتثبّت هلأ: طلبات NEW إلها مهلة تثبيت جاية (مش موقوفة).
  const settlingRows = await db.order!.findMany({
    where: { workspaceId, status: "NEW", settleAt: { gt: now }, heldBy: null, sealedAt: null },
    orderBy: { settleAt: "asc" },
    take: 10,
  });
  const itemRows = settlingRows.length
    ? await db.orderItem!.findMany({ where: { orderId: { in: settlingRows.map((o) => String(o.id)) } } })
    : [];
  const settling: SettlingOrder[] = settlingRows.map((o) => {
    const items = itemRows.filter((i) => i.orderId === o.id);
    return {
      id: String(o.id),
      orderNumber: typeof o.orderNumber === "string" ? o.orderNumber : "",
      settleAt: iso(o.settleAt),
      recipientName: typeof o.recipientName === "string" ? o.recipientName : null,
      items: items.map((i) => `${typeof i.productNameSnapshot === "string" ? i.productNameSnapshot : "منتج"} ×${num(i.quantity) || 1}`).join("، "),
      conversationId: typeof o.conversationId === "string" ? o.conversationId : null,
    };
  });

  const recentRows = await db.order!.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 5 });
  const recent: RecentOrder[] = recentRows.map((o) => {
    const label = orderStatusLabel({
      status: String(o.status),
      sealedAt: (o.sealedAt as Date | string | null) ?? null,
      heldBy: (o.heldBy as string | null) ?? null,
      omsStatus: (o.omsStatus as string | null) ?? null,
      omsShippingStatus: (o.omsShippingStatus as string | null) ?? null,
    });
    return { id: String(o.id), orderNumber: String(o.orderNumber ?? ""), status: label.text, statusTone: label.tone, total: num(o.total), currency: typeof o.currency === "string" ? o.currency : "USD", createdAt: iso(o.createdAt) };
  });

  return { range, timezone, prevLabel: r.prevLabel, metrics, settling, recent };
}
