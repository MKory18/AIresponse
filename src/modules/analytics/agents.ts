import { median, avg, resolveRange, type RangeQuery } from "@/core/analytics/time";
import { sumMoney } from "./csv";

/**
 * P10 — أداء الموظفين: كل مؤشر بإسناد موثق ومعلن، لا "آخر شخص شاهد".
 *
 * تعريفات الإسناد (الرسمية):
 * - محادثات معينة     = Conversation.assignedAgentId == الموظف (الإسناد الرسمي
 *   عبر conversations.assign) ضمن الفترة.
 * - ردود صادرة        = Message OUTBOUND غير ملاحظة senderId == الموظف (رسائل
 *   الموظف فقط — رسائل AI مستثناة).
 * - زمن أول رد (للموظف) = median لزمن أول رد على محادثاته المعينة (أول رد صادر
 *   بعد أول رسالة عميل — أي مصدر، فالأهم زمن العميل لا هوية المرسل).
 * - تحويلات موظف      = HumanHandoff.assignedTo == الموظف ضمن الفترة؛ المُحلولة
 *   بـ resolvedAt ضمن الفترة.
 * - طلبات مرتبطة      = Order.conversationId في محادثات الموظف المعينة —
 *   الإسناد عبر المحادثة المسندة رسميًا (وليس آخر مشاهدة). الاستخدام غير الموثق
 *   لا يُنسب (بلا conversationId → غير مرتبط).
 * - اعتمادات الخصم    = AuditLog.sales.discount_approved/rejected.userId — سجل
 *   التدقيق هو المصدر (فصل الواجبات: الاعتماد للمصرح له فقط).
 * - مقاييس العروض لكل موظف = غير متاحة (SalesEvent لا يحمل هوية فاعل) — تُعاد
 *   UNAVAILABLE بسبب موثق، لا صفر ولا تخمين.
 */

type Db = Parameters<typeof resolveRange>[0] extends never ? never : import("@/modules/customers/service").Db;

export interface AgentRow {
  agentId: string;
  conversationsAssigned: number;
  repliesSent: number;
  firstResponseMedianMinutes: number | null;
  handoffsClaimed: number;
  handoffsResolved: number;
  ordersLinked: number;
  ordersLinkedConfirmed: number;
  ordersLinkedConfirmedValue: number | null;
  discountApproved: number;
  discountRejected: number;
  offerMetrics: { status: "UNAVAILABLE"; reason: "SALES_EVENT_HAS_NO_ACTOR" };
}

export async function getAgentAnalytics(db: Db, workspaceId: string, q: RangeQuery): Promise<{ attribution: Record<string, string>; agents: AgentRow[]; totalAgents: number }> {
  const { start, end } = resolveRange(q);
  const range = { gte: start, lt: end };

  const [convs, humanReplies, handoffs, discounts] = await Promise.all([
    db.conversation.findMany({
      where: { workspaceId, assignedAgentId: { not: null }, createdAt: range },
      select: { id: true, assignedAgentId: true, createdAt: true },
    }),
    db.message.findMany({
      where: { workspaceId, direction: "OUTBOUND", isNote: false, createdAt: range, senderId: { not: null }, senderType: "HUMAN" },
      select: { senderId: true, senderType: true },
    }),
    db.humanHandoff.findMany({
      where: { workspaceId, assignedTo: { not: null }, createdAt: range },
      select: { assignedTo: true, status: true, resolvedAt: true },
    }),
    db.auditLog.findMany({
      where: { workspaceId, action: { in: ["sales.discount_approved", "sales.discount_rejected"] }, createdAt: range },
      select: { userId: true, action: true },
    }),
  ]);

  const agentIds = new Set<string>();
  for (const c of convs) if (c.assignedAgentId) agentIds.add(c.assignedAgentId);
  // رسائل AI مستثناة من هوية الموظف (الموثق أعلاه)
  for (const r of humanReplies) if (r.senderType === "HUMAN" && r.senderId) agentIds.add(r.senderId);
  for (const h of handoffs) if (h.assignedTo) agentIds.add(h.assignedTo);
  for (const d of discounts) if (d.userId) agentIds.add(d.userId);

  // ردود الصادر لكل موظف + أول رد على محادثاته المعينة
  const repliesByAgent = new Map<string, number>();
  for (const r of humanReplies) {
    if (!r.senderId) continue;
    repliesByAgent.set(r.senderId, (repliesByAgent.get(r.senderId) ?? 0) + 1);
  }

  const frtByAgent = new Map<string, number[]>();
  const assignedConvsByAgent = new Map<string, string[]>();
  for (const c of convs) {
    if (!c.assignedAgentId) continue;
    const list = assignedConvsByAgent.get(c.assignedAgentId) ?? [];
    list.push(c.id);
    assignedConvsByAgent.set(c.assignedAgentId, list);
  }
  const allConvIds = [...assignedConvsByAgent.values()].flat();
  const messages = allConvIds.length
    ? await db.message.findMany({
        where: { workspaceId, conversationId: { in: allConvIds }, deletedAt: null },
        select: { conversationId: true, direction: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const msgByConv = new Map<string, { direction: string; createdAt: Date }[]>();
  for (const m of messages) {
    const l = msgByConv.get(m.conversationId) ?? [];
    l.push({ direction: m.direction, createdAt: new Date(m.createdAt) });
    msgByConv.set(m.conversationId, l);
  }
  const agentOfConv = new Map<string, string>();
  for (const [agentId, ids] of assignedConvsByAgent) for (const id of ids) agentOfConv.set(id, agentId);
  for (const [convId, list] of msgByConv) {
    const agentId = agentOfConv.get(convId);
    if (!agentId) continue;
    const firstInbound = list.find((m) => m.direction === "INBOUND");
    if (!firstInbound) continue;
    const firstOut = list.find((m) => m.direction === "OUTBOUND" && new Date(m.createdAt).getTime() >= firstInbound.createdAt.getTime());
    if (!firstOut) continue;
    const frt = (new Date(firstOut.createdAt).getTime() - firstInbound.createdAt.getTime()) / 60_000;
    const arr = frtByAgent.get(agentId) ?? [];
    arr.push(frt);
    frtByAgent.set(agentId, arr);
  }

  // طلبات مرتبطة بمحادثات الموظفين (إسناد رسمي عبر assignedAgentId)
  const orders = allConvIds.length
    ? await db.order.findMany({
        where: { workspaceId, conversationId: { in: allConvIds }, createdAt: range },
        select: { conversationId: true, status: true, total: true },
      })
    : [];
  const confirmedStatuses = ["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED"];
  const ordersByAgent = new Map<string, { count: number; confirmed: number; confirmedTotal: Array<string | number | null> }>();
  for (const o of orders) {
    const convId = o.conversationId ?? "";
    const agentId = agentOfConv.get(convId);
    if (!agentId) continue;
    const g = ordersByAgent.get(agentId) ?? { count: 0, confirmed: 0, confirmedTotal: [] };
    g.count += 1;
    if (confirmedStatuses.includes(o.status)) {
      g.confirmed += 1;
      g.confirmedTotal.push(o.total as unknown as string);
    }
    ordersByAgent.set(agentId, g);
  }

  const agents: AgentRow[] = [...agentIds].sort().map((agentId) => {
    const g = ordersByAgent.get(agentId);
    const d = discounts.filter((x) => x.userId === agentId);
    return {
      agentId,
      conversationsAssigned: assignedConvsByAgent.get(agentId)?.length ?? 0,
      repliesSent: repliesByAgent.get(agentId) ?? 0,
      firstResponseMedianMinutes: median(frtByAgent.get(agentId) ?? []),
      handoffsClaimed: handoffs.filter((h) => h.assignedTo === agentId).length,
      handoffsResolved: handoffs.filter((h) => h.assignedTo === agentId && h.resolvedAt).length,
      ordersLinked: g?.count ?? 0,
      ordersLinkedConfirmed: g?.confirmed ?? 0,
      ordersLinkedConfirmedValue: g ? sumMoney(g.confirmedTotal) : null,
      discountApproved: d.filter((x) => x.action === "sales.discount_approved").length,
      discountRejected: d.filter((x) => x.action === "sales.discount_rejected").length,
      offerMetrics: { status: "UNAVAILABLE" as const, reason: "SALES_EVENT_HAS_NO_ACTOR" as const },
    };
  });

  return {
    attribution: {
      conversations: "Conversation.assignedAgentId ضمن الفترة (إسناد رسمي عبر conversations.assign)",
      orders: "Order.conversationId في محادثة معينة للموظف — لا إسناد لآخر مشاهد",
      handoffs: "HumanHandoff.assignedTo",
      discounts: "AuditLog (sales.discount_approved/rejected)",
      offers: "غير متاح: SalesEvent لا يحمل هوية فاعل (UNAVAILABLE — لا تخمين)",
      notes: "اقتراحات Sales Coach لا تُحسب مبيعات؛ رسائل AI لا تُحسب ردود موظف",
    },
    agents,
    totalAgents: agents.length,
  };
}

/** متوسط FRT إجمالي (للمقارنة بين الفترات) — يُكمل وحدة الموظفين. */
export function aggregateFrt(rows: AgentRow[]): { median: number | null; avg: number | null } {
  const all = rows.flatMap((r) => (r.firstResponseMedianMinutes === null ? [] : [r.firstResponseMedianMinutes]));
  return { median: median(all), avg: avg(all) };
}
