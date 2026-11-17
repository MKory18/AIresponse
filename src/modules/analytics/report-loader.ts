import { getAgentAnalytics } from "./agents";
import { emptyReportData, type ReportData, type RptConversation, type RptOrder } from "./report-data";
import { UNANSWERED_AFTER_MIN } from "./kpi-catalog";

/**
 * تحميل بيانات التقارير (3.7): كل شي **حي من الجداول المصدرية** بحدود الفترة بمنطقة المساحة — ما في اعتماد على
 * الجدول اليومي المجمّع (كان يوم اليوم فيه دايمًا ناقص وبينعاد البناء بكل فتح، L-18). كل استعلام مقيّد بالمساحة وبسقف.
 */

type Rows = Array<Record<string, unknown>>;
type Delegate = { findMany(a: unknown): Promise<Rows> };
type Db = Record<string, Delegate>;

const SEALED_STATUSES = ["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED"];
const CAP = { orders: 20_000, conversations: 20_000, messages: 60_000, items: 60_000, logs: 30_000 };
const DAY = 86_400_000;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const date = (v: unknown) => (v ? new Date(v as string) : null);
const chunks = <T,>(xs: T[], n = 5000): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

function toOrder(r: Record<string, unknown>): RptOrder {
  return {
    id: str(r.id),
    conversationId: r.conversationId ? str(r.conversationId) : null,
    status: str(r.status),
    total: num(r.total),
    currency: str(r.currency) || "USD",
    createdAt: new Date(r.createdAt as string),
    sealedAt: date(r.sealedAt),
    omsOrderId: r.omsOrderId ? str(r.omsOrderId) : null,
    omsStatus: r.omsStatus ? str(r.omsStatus) : null,
    reviewReasons: Array.isArray(r.reviewReasons) ? (r.reviewReasons as unknown[]).map(str) : [],
  };
}

const ORDER_SELECT = { id: true, conversationId: true, status: true, total: true, currency: true, createdAt: true, sealedAt: true, omsOrderId: true, omsStatus: true, reviewReasons: true };

export interface LoadOptions {
  start: Date;
  end: Date;
  timezone: string;
  now?: Date;
  /** صلاحية «أداء الموظفين»: جدول الفريق ما بينحمّل بدونها. */
  withTeam?: boolean;
}

export async function loadReportData(dbIn: unknown, workspaceId: string, opts: LoadOptions): Promise<ReportData> {
  const db = dbIn as Db;
  const now = opts.now ?? new Date();
  const d = emptyReportData(opts.start, opts.end, opts.timezone, now);
  const range = { gte: opts.start, lt: opts.end };

  // ── الطلبات: مثبّتة بالفترة · منخلقة بالفترة ──
  const [sealedRows, createdRows, convRows] = await Promise.all([
    db.order!.findMany({
      where: { workspaceId, OR: [{ sealedAt: range }, { sealedAt: null, status: { in: SEALED_STATUSES }, createdAt: range }] },
      select: ORDER_SELECT,
      take: CAP.orders,
    }),
    db.order!.findMany({ where: { workspaceId, createdAt: range }, select: ORDER_SELECT, take: CAP.orders }),
    db.conversation!.findMany({ where: { workspaceId, createdAt: range }, select: { id: true, createdAt: true, aiState: true }, take: CAP.conversations }),
  ]);
  d.sealed = sealedRows.map(toOrder);
  d.created = createdRows.map(toOrder);
  const convIds = convRows.map((c) => str(c.id));
  const sealedIds = d.sealed.map((o) => o.id);

  // ── مجموعة المحادثات (القمع): قراءاتها · طلباتها · رسالتها الأولى والرد الأول ──
  const readings: Rows = [];
  const cohort: Rows = [];
  const cohortMsgs: Rows = [];
  for (const ids of chunks(convIds)) {
    const [r, o, m] = await Promise.all([
      db.conversationReading!.findMany({ where: { workspaceId, conversationId: { in: ids } }, select: { conversationId: true, firstOrderingAt: true } }),
      db.order!.findMany({ where: { workspaceId, conversationId: { in: ids } }, select: ORDER_SELECT, take: CAP.orders }),
      db.message!.findMany({
        where: { workspaceId, conversationId: { in: ids }, deletedAt: null, isNote: false },
        select: { conversationId: true, direction: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: CAP.messages,
      }),
    ]);
    readings.push(...r);
    cohort.push(...o);
    cohortMsgs.push(...m);
  }
  d.cohortOrders = cohort.map(toOrder);
  const orderingAt = new Map(readings.map((r) => [str(r.conversationId), date(r.firstOrderingAt)]));
  const firstIn = new Map<string, Date>();
  const firstOut = new Map<string, Date>();
  for (const m of cohortMsgs) {
    const id = str(m.conversationId);
    const at = new Date(m.createdAt as string);
    if (m.direction === "INBOUND") {
      if (!firstIn.has(id)) firstIn.set(id, at);
    } else if (m.direction === "OUTBOUND") {
      const fi = firstIn.get(id);
      if (fi && at.getTime() >= fi.getTime() && !firstOut.has(id)) firstOut.set(id, at);
    }
  }
  d.conversations = convRows.map<RptConversation>((c) => ({
    id: str(c.id),
    createdAt: new Date(c.createdAt as string),
    firstInboundAt: firstIn.get(str(c.id)) ?? null,
    firstOutboundAt: firstOut.get(str(c.id)) ?? null,
    firstOrderingAt: orderingAt.get(str(c.id)) ?? null,
  }));

  // ── بنود وتعديلات الطلبات المثبّتة · اسم الصفحة ──
  const currencyOf = new Map(d.sealed.map((o) => [o.id, o.currency]));
  const convOfOrder = new Map(d.sealed.filter((o) => o.conversationId).map((o) => [o.id, o.conversationId!]));
  for (const ids of chunks(sealedIds)) {
    const [items, revs] = await Promise.all([
      db.orderItem!.findMany({ where: { orderId: { in: ids } }, select: { orderId: true, productId: true, productNameSnapshot: true, quantity: true, subtotal: true }, take: CAP.items }),
      db.orderRevision!.findMany({ where: { workspaceId, orderId: { in: ids }, kind: { in: ["AMEND_REQUEST", "CANCEL_REQUEST", "STAFF_EDIT"] } }, select: { orderId: true, kind: true } }),
    ]);
    for (const i of items) d.items.push({ orderId: str(i.orderId), productId: str(i.productId), name: str(i.productNameSnapshot), quantity: num(i.quantity), subtotal: num(i.subtotal), currency: currencyOf.get(str(i.orderId)) ?? "USD" });
    for (const r of revs) d.revisions.push({ orderId: str(r.orderId), kind: str(r.kind) });
  }
  const sealedConvIds = [...new Set(convOfOrder.values())];
  if (sealedConvIds.length) {
    const channelOfConv = new Map<string, string>();
    for (const ids of chunks(sealedConvIds)) {
      const convs = await db.conversation!.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, channelId: true } });
      for (const c of convs) channelOfConv.set(str(c.id), str(c.channelId));
    }
    const channels = await db.channel!.findMany({ where: { workspaceId }, select: { id: true, displayName: true, externalId: true, type: true } });
    const nameOf = new Map(channels.map((c) => [str(c.id), str(c.displayName) || str(c.externalId) || str(c.type)]));
    for (const [orderId, convId] of convOfOrder) {
      const name = nameOf.get(channelOfConv.get(convId) ?? "");
      if (name) d.pageOfOrder[orderId] = name;
    }
  }

  // ── رسائل الفترة: ردود الوكيل · ردود الموظفين · نجاح الرد ──
  const msgs = await db.message!.findMany({
    where: { workspaceId, createdAt: range, isNote: false, deletedAt: null },
    select: { conversationId: true, direction: true, senderType: true, senderId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: CAP.messages,
  });
  const aiOut = new Map<string, number[]>();
  const inbound: Array<{ conv: string; at: number }> = [];
  for (const m of msgs) {
    const at = new Date(m.createdAt as string);
    if (m.direction === "OUTBOUND" && m.senderType === "AI") {
      d.agentReplies += 1;
      d.agentReplyTimes.push(at);
      (aiOut.get(str(m.conversationId)) ?? aiOut.set(str(m.conversationId), []).get(str(m.conversationId))!).push(at.getTime());
    } else if (m.direction === "OUTBOUND" && m.senderType === "HUMAN" && m.senderId && m.senderId !== "campaign-system") {
      d.staffReplyTimes.push(at);
    } else if (m.direction === "INBOUND") inbound.push({ conv: str(m.conversationId), at: at.getTime() });
  }
  if (inbound.length) {
    const aiState = new Map<string, string>();
    for (const ids of chunks([...new Set(inbound.map((i) => i.conv))])) {
      const convs = await db.conversation!.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, aiState: true } });
      for (const c of convs) aiState.set(str(c.id), str(c.aiState));
    }
    for (const i of inbound) {
      if (aiState.get(i.conv) !== "AI_ACTIVE") continue;
      d.customerMessages.needed += 1;
      // الرسالة المغطّاة برد أحدث (رشقة) محسوبة ناجحة: يكفي أي رد وكيل بعدها.
      if ((aiOut.get(i.conv) ?? []).some((t) => t >= i.at)) d.customerMessages.answered += 1;
    }
  }

  // ── لحظي: بلا رد (آخر 24 ساعة، نفس تعريف بنود «يحتاجك») ──
  const cutoff = new Date(now.getTime() - UNANSWERED_AFTER_MIN * 60_000);
  const floor = new Date(now.getTime() - DAY);
  const open = await db.conversation!.findMany({
    where: { workspaceId, status: "OPEN", deletedAt: null, lastCustomerMessageAt: { gte: floor, lt: cutoff } },
    select: { lastCustomerMessageAt: true, lastAgentMessageAt: true },
    take: 5000,
  });
  d.unansweredNow = open.filter((c) => !c.lastAgentMessageAt || new Date(c.lastAgentMessageAt as string) < new Date(c.lastCustomerMessageAt as string)).length;

  // ── الاستلام · وعد بلا طلب ──
  const handoffs = await db.humanHandoff!.findMany({ where: { workspaceId, createdAt: range }, select: { conversationId: true, metadata: true }, take: CAP.conversations });
  d.aiPromises = handoffs.filter((h) => (h.metadata as Record<string, unknown> | null)?.aiClaimedNoOrder === true).length;
  const takeovers = await db.auditLog!.findMany({ where: { workspaceId, action: "conversation.takeover", createdAt: range }, select: { entityId: true }, take: CAP.conversations });
  const claimed = await db.humanHandoff!.findMany({ where: { workspaceId, claimedAt: range }, select: { conversationId: true }, take: CAP.conversations });
  d.takenOver = new Set([...takeovers.map((t) => str(t.entityId)), ...claimed.map((c) => str(c.conversationId))].filter(Boolean)).size;

  // ── الوكيل: فشل · كلفة ──
  const logs = await db.aIUsageLog!.findMany({ where: { workspaceId, createdAt: range }, select: { costUsd: true, success: true, status: true, error: true }, take: CAP.logs });
  d.cost.calls = logs.length;
  for (const l of logs) {
    if (l.costUsd === null || l.costUsd === undefined) d.cost.unknownCalls += 1;
    else d.cost.knownUsd += num(l.costUsd);
    if (l.success === false) d.failures.push({ error: l.error ? str(l.error) : null, status: str(l.status) });
  }

  // ── الفريق ──
  if (opts.withTeam) {
    const a = await getAgentAnalytics(db as never, workspaceId, { range: "custom", from: opts.start.toISOString(), to: opts.end.toISOString() });
    const users = a.agents.length ? await db.user!.findMany({ where: { id: { in: a.agents.map((x) => x.agentId) } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(users.map((u) => [str(u.id), str(u.name)]));
    d.team = a.agents.map((x) => ({
      agentId: x.agentId,
      name: nameOf.get(x.agentId) || "موظف",
      conversationsAssigned: x.conversationsAssigned,
      repliesSent: x.repliesSent,
      firstResponseMedianMinutes: x.firstResponseMedianMinutes,
      handoffsClaimed: x.handoffsClaimed,
      handoffsResolved: x.handoffsResolved,
      ordersLinked: x.ordersLinked,
      ordersLinkedConfirmed: x.ordersLinkedConfirmed,
    }));
  }
  return d;
}
