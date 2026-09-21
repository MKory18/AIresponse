import type { Prisma } from "@prisma/client";
import { resolveRange, median, avg, type RangeQuery } from "@/core/analytics/time";
import type { Db } from "@/modules/customers/service";

/**
 * Analytics — READ-ONLY aggregation over domain data.
 * Every query is workspace-scoped. Definitions:
 *
 * firstResponseTime = first OUTBOUND message after the conversation's first
 *   INBOUND customer message (webhook duplicates and system events excluded —
 *   they never create messages).
 * resolutionTime = conversation.updatedAt - createdAt for conversations with
 *   status RESOLVED/CLOSED; null otherwise (never invented).
 * revenueConfirmed = SUM(Order.total) with status CONFIRMED/PROCESSING/
 *   OUT_FOR_DELIVERY/DELIVERED (snapshot prices from OrderItem, never
 *   Product.currentPrice).
 */

type DbClient = Db | Prisma.TransactionClient;

export { resolveRange };
export type { RangeQuery };

// ── Overview ────────────────────────────────────────────────────────────────

export async function getOverview(db: DbClient, workspaceId: string, q: RangeQuery) {
  const { start, end } = resolveRange(q);
  const range = { gte: start, lt: end };

  const [conversationsTotal, conversationsActive, conversationsResolved, inbound, outbound, aiLogs, orders, handoffs, automations] =
    await Promise.all([
      db.conversation.count({ where: { workspaceId, createdAt: range } }),
      db.conversation.count({ where: { workspaceId, status: "OPEN" } }),
      db.conversation.count({ where: { workspaceId, status: { in: ["RESOLVED", "CLOSED"] }, updatedAt: range } }),
      db.message.count({ where: { workspaceId, direction: "INBOUND", createdAt: range } }),
      db.message.count({ where: { workspaceId, direction: "OUTBOUND", createdAt: range } }),
      db.aIUsageLog.findMany({
        where: { workspaceId, createdAt: range },
        select: { promptTokens: true, completionTokens: true, costUsd: true, success: true },
      }),
      db.order.findMany({
        where: { workspaceId, createdAt: range },
        select: { status: true, total: true },
      }),
      db.humanHandoff.findMany({
        where: { workspaceId, createdAt: range },
        select: { status: true, createdAt: true, resolvedAt: true },
      }),
      db.automationExecution.findMany({
        where: { workspaceId, startedAt: range },
        select: { status: true },
      }),
    ]);

  const aiTokens = aiLogs.reduce((s, l) => s + l.promptTokens + l.completionTokens, 0);
  const aiCost = aiLogs.reduce((s, l) => s + (l.costUsd ?? 0), 0);
  const orderCount = (statuses: string[]) => orders.filter((o) => statuses.includes(o.status)).length;
  const revenue = (statuses: string[]) =>
    orders.filter((o) => statuses.includes(o.status)).reduce((s, o) => s + Number(o.total), 0);
  const resolvedHandoffs = handoffs.filter((h) => h.resolvedAt);
  const handoffResolutionMs = resolvedHandoffs.map((h) => (new Date(h.resolvedAt!).getTime() - new Date(h.createdAt).getTime()));

  return {
    conversations: {
      total: conversationsTotal,
      active: conversationsActive,
      resolved: conversationsResolved,
    },
    messages: { inbound, outbound },
    orders: {
      created: orders.length,
      confirmed: orderCount(["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED"]),
      delivered: orderCount(["DELIVERED"]),
      cancelled: orderCount(["CANCELLED"]),
    },
    revenue: {
      confirmed: revenue(["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED"]),
      delivered: revenue(["DELIVERED"]),
    },
    ai: {
      calls: aiLogs.length,
      failed: aiLogs.filter((l) => !l.success).length,
      tokens: aiTokens,
      estimatedCost: aiCost,
    },
    handoffs: {
      total: handoffs.length,
      open: handoffs.filter((h) => h.status === "OPEN").length,
      avgResolutionMinutes: avg(handoffResolutionMs.map((ms) => ms / 60_000)),
      medianResolutionMinutes: median(handoffResolutionMs.map((ms) => ms / 60_000)),
    },
    automation: {
      executions: automations.length,
      completed: automations.filter((a) => a.status === "COMPLETED").length,
      failed: automations.filter((a) => a.status === "FAILED").length,
      skipped: automations.filter((a) => a.status === "SKIPPED").length,
    },
  };
}

// ── Conversations (incl. first response time) ───────────────────────────────

export async function getConversationAnalytics(db: DbClient, workspaceId: string, q: RangeQuery) {
  const { start, end } = resolveRange(q);
  const conversations = await db.conversation.findMany({
    where: { workspaceId, createdAt: { gte: start, lt: end } },
    select: { id: true, createdAt: true, status: true, aiState: true, updatedAt: true },
  });
  const conversationIds = conversations.map((c) => c.id);

  const messages = conversationIds.length
    ? await db.message.findMany({
        where: { workspaceId, conversationId: { in: conversationIds }, deletedAt: null },
        select: { conversationId: true, direction: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      })
    : [];

  // firstResponseTime per conversation (see definition above).
  const frtMinutes: number[] = [];
  const byConversation = new Map<string, { direction: string; createdAt: Date }[]>();
  for (const m of messages) {
    const list = byConversation.get(m.conversationId) ?? [];
    list.push({ direction: m.direction, createdAt: new Date(m.createdAt) });
    byConversation.set(m.conversationId, list);
  }
  for (const [convId, list] of byConversation) {
    const firstInbound = list.find((m) => m.direction === "INBOUND");
    if (!firstInbound) continue;
    const firstOutbound = list.find(
      (m) => m.direction === "OUTBOUND" && new Date(m.createdAt).getTime() >= firstInbound.createdAt.getTime()
    );
    if (firstOutbound) {
      frtMinutes.push((new Date(firstOutbound.createdAt).getTime() - firstInbound.createdAt.getTime()) / 60_000);
    }
    void convId;
  }

  const resolved = conversations.filter((c) => c.status === "RESOLVED" || c.status === "CLOSED");
  const resolutionMinutes = resolved.map((c) => (new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime()) / 60_000);

  return {
    newConversations: conversations.length,
    inboundMessages: messages.filter((m) => m.direction === "INBOUND").length,
    outboundMessages: messages.filter((m) => m.direction === "OUTBOUND").length,
    firstResponse: {
      avgMinutes: avg(frtMinutes),
      medianMinutes: median(frtMinutes),
      count: frtMinutes.length,
    },
    resolution: {
      avgMinutes: avg(resolutionMinutes),
      medianMinutes: median(resolutionMinutes),
      count: resolutionMinutes.length,
    },
  };
}

// ── Orders ──────────────────────────────────────────────────────────────────

export async function getOrderAnalytics(db: DbClient, workspaceId: string, q: RangeQuery) {
  const { start, end } = resolveRange(q);
  const orders = await db.order.findMany({
    where: { workspaceId, createdAt: { gte: start, lt: end } },
    select: { status: true, subtotal: true, discount: true, deliveryFee: true, total: true, province: true },
  });
  const sum = (pred: (o: (typeof orders)[number]) => boolean, field: "total" | "subtotal") =>
    orders.filter(pred).reduce((s, o) => s + Number(o[field]), 0);
  const confirmedStatuses = ["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED"];

  return {
    created: orders.length,
    confirmed: orders.filter((o) => confirmedStatuses.includes(o.status)).length,
    cancelled: orders.filter((o) => o.status === "CANCELLED").length,
    delivered: orders.filter((o) => o.status === "DELIVERED").length,
    returned: orders.filter((o) => o.status === "RETURNED").length,
    failed: orders.filter((o) => o.status === "FAILED").length,
    gmv: {
      // Distinct definitions — created GMV ≠ revenue.
      createdGmv: sum(() => true, "total"),
      confirmedGmv: sum((o) => confirmedStatuses.includes(o.status), "total"),
      deliveredGmv: sum((o) => o.status === "DELIVERED", "total"),
      discounts: orders.reduce((s, o) => s + Number(o.discount), 0),
      deliveryFees: orders.reduce((s, o) => s + Number(o.deliveryFee), 0),
    },
    byProvince: Object.entries(
      orders.reduce<Record<string, number>>((acc, o) => {
        const key = o.province ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})
    ).map(([province, count]) => ({ province, count })),
  };
}

// ── Products (snapshot prices from OrderItem) ───────────────────────────────

export async function getProductAnalytics(db: DbClient, workspaceId: string, q: RangeQuery) {
  const { start, end } = resolveRange(q);
  const ordersInRange = await db.order.findMany({
    where: { workspaceId, createdAt: { gte: start, lt: end } },
    select: { id: true },
  });
  const items = ordersInRange.length
    ? await db.orderItem.findMany({
        where: { orderId: { in: ordersInRange.map((o) => o.id) } },
        include: { order: { select: { status: true } } },
      })
    : [];
  if (process.env.DEBUG_ANALYTICS) {
    console.log("DBG ordersInRange", ordersInRange.length, "items", items.length, JSON.stringify(items.map((i: Record<string, unknown>) => i.order)));
  }
  const confirmedStatuses = ["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED"];
  const byProduct = new Map<string, {
    productName: string;
    units: number;
    confirmedOrders: Set<string>;
    deliveredOrders: Set<string>;
    confirmedRevenue: number;
    deliveredRevenue: number;
  }>();

  for (const item of items) {
    const key = item.productId;
    const entry = byProduct.get(key) ?? {
      productName: item.productNameSnapshot,
      units: 0,
      confirmedOrders: new Set<string>(),
      deliveredOrders: new Set<string>(),
      confirmedRevenue: 0,
      deliveredRevenue: 0,
    };
    if (confirmedStatuses.includes(item.order.status)) {
      entry.units += item.quantity;
      entry.confirmedOrders.add(item.orderId);
      entry.confirmedRevenue += Number(item.subtotal); // snapshot price
    }
    if (item.order.status === "DELIVERED") {
      entry.deliveredOrders.add(item.orderId);
      entry.deliveredRevenue += Number(item.subtotal);
    }
    byProduct.set(key, entry);
  }

  return [...byProduct.entries()].map(([productId, e]) => ({
    productId,
    productName: e.productName,
    units: e.units,
    confirmedOrders: e.confirmedOrders.size,
    deliveredOrders: e.deliveredOrders.size,
    confirmedRevenue: e.confirmedRevenue, // historical snapshot — never currentPrice
    deliveredRevenue: e.deliveredRevenue,
  }));
}

// ── AI ──────────────────────────────────────────────────────────────────────

export async function getAIAnalytics(db: DbClient, workspaceId: string, q: RangeQuery) {
  const { start, end } = resolveRange(q);
  const logs = await db.aIUsageLog.findMany({
    where: { workspaceId, createdAt: { gte: start, lt: end } },
    select: { purpose: true, model: true, promptTokens: true, completionTokens: true, costUsd: true, success: true, latencyMs: true },
  });
  const group = <T extends string>(key: keyof (typeof logs)[number]) =>
    Object.entries(
      logs.reduce<Record<string, { calls: number; inputTokens: number; outputTokens: number; estimatedCost: number | null }>>((acc, l) => {
        const k = String(l[key]);
        const g = acc[k] ?? { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
        g.calls += 1;
        g.inputTokens += l.promptTokens;
        g.outputTokens += l.completionTokens;
        if (l.costUsd !== null) g.estimatedCost = (g.estimatedCost ?? 0) + l.costUsd;
        else g.estimatedCost = g.estimatedCost === 0 ? null : g.estimatedCost;
        acc[k] = g;
        return acc;
      }, {})
    ).map(([k, v]) => ({ key: k, ...v }));

  const knownCosts = logs.filter((l) => l.costUsd !== null);
  return {
    calls: logs.length,
    successful: logs.filter((l) => l.success).length,
    failed: logs.filter((l) => !l.success).length,
    inputTokens: logs.reduce((s, l) => s + l.promptTokens, 0),
    outputTokens: logs.reduce((s, l) => s + l.completionTokens, 0),
    // Cost only from configured pricing; null when unknown — never $0-as-actual.
    estimatedCost: knownCosts.length ? knownCosts.reduce((s, l) => s + (l.costUsd ?? 0), 0) : logs.length ? null : 0,
    avgLatencyMs: avg(logs.map((l) => l.latencyMs)),
    byTask: group("purpose"),
    byModel: group("model"),
  };
}

// ── Automations / Follow-ups / Handoffs ─────────────────────────────────────

export async function getAutomationAnalytics(db: DbClient, workspaceId: string, q: RangeQuery) {
  const { start, end } = resolveRange(q);
  const executions = await db.automationExecution.findMany({
    where: { workspaceId, startedAt: { gte: start, lt: end } },
    select: { automationId: true, status: true, automation: { select: { name: true } } },
  });
  const byAutomation = new Map<string, { name: string; completed: number; failed: number; skipped: number }>();
  for (const e of executions) {
    const g = byAutomation.get(e.automationId) ?? { name: e.automation?.name ?? e.automationId, completed: 0, failed: 0, skipped: 0 };
    if (e.status === "COMPLETED") g.completed += 1;
    if (e.status === "FAILED") g.failed += 1;
    if (e.status === "SKIPPED") g.skipped += 1;
    byAutomation.set(e.automationId, g);
  }
  return [...byAutomation.entries()].map(([id, g]) => ({
    automationId: id,
    name: g.name,
    executions: g.completed + g.failed + g.skipped,
    completed: g.completed,
    failed: g.failed,
    skipped: g.skipped,
    // successRate = completed / (completed + failed); null when denominator 0.
    successRate: g.completed + g.failed > 0 ? g.completed / (g.completed + g.failed) : null,
  }));
}

export async function getFollowUpAnalytics(db: DbClient, workspaceId: string, q: RangeQuery) {
  const { start, end } = resolveRange(q);
  const followUps = await db.followUp.findMany({
    where: { workspaceId, createdAt: { gte: start, lt: end } },
    select: { status: true, type: true, attempts: true },
  });
  return {
    scheduled: followUps.filter((f) => f.status === "SCHEDULED").length,
    sent: followUps.filter((f) => f.status === "SENT").length,
    skipped: followUps.filter((f) => f.status === "SKIPPED").length,
    cancelled: followUps.filter((f) => f.status === "CANCELLED").length,
    failed: followUps.filter((f) => f.status === "FAILED").length,
    totalRetries: followUps.reduce((s, f) => s + Math.max(0, f.attempts - 1), 0),
    byType: Object.entries(
      followUps.reduce<Record<string, number>>((acc, f) => {
        acc[f.type] = (acc[f.type] ?? 0) + 1;
        return acc;
      }, {})
    ).map(([type, count]) => ({ type, count })),
  };
}

export async function getHandoffAnalytics(db: DbClient, workspaceId: string, q: RangeQuery) {
  const { start, end } = resolveRange(q);
  const handoffs = await db.humanHandoff.findMany({
    where: { workspaceId, createdAt: { gte: start, lt: end } },
    select: { status: true, reason: true, priority: true, assignedTo: true, createdAt: true, resolvedAt: true },
  });
  const resolutions = handoffs
    .filter((h) => h.resolvedAt)
    .map((h) => (new Date(h.resolvedAt!).getTime() - new Date(h.createdAt).getTime()) / 60_000);
  const groupBy = <K extends keyof (typeof handoffs)[number]>(key: K) =>
    Object.entries(
      handoffs.reduce<Record<string, number>>((acc, h) => {
        const k = String(h[key] ?? "unknown");
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {})
    ).map(([k, count]) => ({ key: k, count }));

  return {
    total: handoffs.length,
    open: handoffs.filter((h) => h.status === "OPEN").length,
    claimed: handoffs.filter((h) => h.status === "CLAIMED").length,
    resolved: handoffs.filter((h) => h.status === "RESOLVED").length,
    cancelled: handoffs.filter((h) => h.status === "CANCELLED").length,
    avgResolutionMinutes: avg(resolutions),
    medianResolutionMinutes: median(resolutions),
    byReason: groupBy("reason"),
    byPriority: groupBy("priority"),
    byAgent: groupBy("assignedTo"),
  };
}

// ── Funnel ──────────────────────────────────────────────────────────────────

export async function getFunnel(db: DbClient, workspaceId: string, q: RangeQuery) {
  const { start, end } = resolveRange(q);
  const range = { gte: start, lt: end };
  const [conversations, drafts, draftsReady, ordersConfirmed, ordersDelivered] = await Promise.all([
    db.conversation.count({ where: { workspaceId, createdAt: range } }),
    db.orderDraft.count({ where: { workspaceId, createdAt: range, state: { not: "EMPTY" } } }),
    db.orderDraft.count({ where: { workspaceId, createdAt: range, state: { in: ["READY", "CONFIRMING", "CONFIRMED", "CONVERTED"] } } }),
    db.order.count({ where: { workspaceId, createdAt: range, status: { in: ["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED"] } } }),
    db.order.count({ where: { workspaceId, createdAt: range, status: "DELIVERED" } }),
  ]);
  // Rates only when denominator > 0 — never NaN.
  const rate = (n: number, d: number) => (d > 0 ? n / d : null);
  return {
    conversations,
    draftsStarted: drafts,
    draftsReady,
    ordersConfirmed,
    ordersDelivered,
    rates: {
      draftStartRate: rate(drafts, conversations),
      readyRate: rate(draftsReady, drafts),
      confirmRate: rate(ordersConfirmed, draftsReady),
      deliveryRate: rate(ordersDelivered, ordersConfirmed),
    },
  };
}

// ── SLA ─────────────────────────────────────────────────────────────────────

export async function getSLA(db: DbClient, workspaceId: string, q: RangeQuery, settings: { slaFirstResponseMinutes: number | null; slaHandoffResolutionMinutes: number | null }) {
  const { start, end } = resolveRange(q);
  const conversations = await db.conversation.findMany({
    where: { workspaceId, createdAt: { gte: start, lt: end } },
    select: { id: true, createdAt: true },
  });
  const messages = conversations.length
    ? await db.message.findMany({
        where: { workspaceId, conversationId: { in: conversations.map((c) => c.id) }, deletedAt: null },
        select: { conversationId: true, direction: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const byConv = new Map<string, { direction: string; createdAt: Date }[]>();
  for (const m of messages) {
    const l = byConv.get(m.conversationId) ?? [];
    l.push({ direction: m.direction, createdAt: new Date(m.createdAt) });
    byConv.set(m.conversationId, l);
  }
  const frts: number[] = [];
  for (const [, list] of byConv) {
    const firstInbound = list.find((m) => m.direction === "INBOUND");
    if (!firstInbound) continue;
    const firstOut = list.find((m) => m.direction === "OUTBOUND" && new Date(m.createdAt) >= firstInbound.createdAt);
    if (firstOut) frts.push((new Date(firstOut.createdAt).getTime() - firstInbound.createdAt.getTime()) / 60_000);
  }

  const slaFrt = settings.slaFirstResponseMinutes;
  const handoffs = await db.humanHandoff.findMany({
    where: { workspaceId, createdAt: { gte: start, lt: end } },
    select: { createdAt: true, resolvedAt: true },
  });
  const slaHandoff = settings.slaHandoffResolutionMinutes;

  return {
    firstResponse: {
      target: slaFrt,
      measured: frts.length,
      breached: slaFrt === null ? null : frts.filter((m) => m > slaFrt).length,
      met: slaFrt === null ? null : frts.filter((m) => m <= slaFrt).length,
      breachRate: slaFrt === null || frts.length === 0 ? null : frts.filter((m) => m > slaFrt).length / frts.length,
    },
    handoffResolution: {
      target: slaHandoff,
      resolutions: handoffs.filter((h) => h.resolvedAt).map((h) => (new Date(h.resolvedAt!).getTime() - new Date(h.createdAt).getTime()) / 60_000),
      get breached() {
        return slaHandoff === null ? null : this.resolutions.filter((m) => m > slaHandoff).length;
      },
    },
  };
}

// ── Queue metrics ───────────────────────────────────────────────────────────

export async function getQueueMetrics(db: DbClient, workspaceId: string | null) {
  const where: Prisma.BackgroundJobWhereInput = workspaceId ? { workspaceId } : {};
  const jobs = await db.backgroundJob.findMany({ where, select: { status: true, type: true } });
  const by = (status: string) => jobs.filter((j) => j.status === status).length;
  const byType: Record<string, number> = {};
  for (const j of jobs) byType[j.type] = (byType[j.type] ?? 0) + 1;
  return {
    pending: by("PENDING"),
    running: by("PROCESSING"),
    completed: by("DONE"),
    failed: by("FAILED"),
    byType,
  };
}
