import type { Prisma } from "@prisma/client";
import { childLogger } from "@/core/logger";
import { eachUtcDay } from "@/core/analytics/time";
import type { Db } from "@/modules/customers/service";

const log = childLogger("analytics");

type DbClient = Db | Prisma.TransactionClient;

export interface DailyCounts {
  conversations: number;
  inboundMessages: number;
  outboundMessages: number;
  aiCalls: number;
  aiTokens: number;
  aiCostUsd: number | null;
  ordersCreated: number;
  ordersConfirmed: number;
  ordersDelivered: number;
  revenueConfirmed: number;
  revenueDelivered: number;
  handoffs: number;
  automationExecutions: number;
  followUpsSent: number;
}

/**
 * Recomputes one UTC day for one workspace from source tables and upserts it.
 * Idempotent by construction: recompute → upsert (unique workspaceId+date),
 * so running twice — or rebuilding after a late event — yields correct totals.
 */
export async function rebuildDailyAnalytics(db: DbClient, workspaceId: string, day: Date): Promise<void> {
  const start = new Date(day);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  const range = { gte: start, lt: end };

  const [conversations, messages, aiLogs, orders, handoffs, automations, followUps] = await Promise.all([
    db.conversation.count({ where: { workspaceId, createdAt: range } }),
    db.message.findMany({
      // P4: internal notes are team records, not customer/channel volume.
      where: { workspaceId, createdAt: range, isNote: false },
      select: { direction: true },
    }),
    db.aIUsageLog.findMany({
      where: { workspaceId, createdAt: range },
      select: { promptTokens: true, completionTokens: true, costUsd: true },
    }),
    db.order.findMany({ where: { workspaceId, createdAt: range }, select: { status: true, total: true } }),
    db.humanHandoff.count({ where: { workspaceId, createdAt: range } }),
    db.automationExecution.count({ where: { workspaceId, startedAt: range } }),
    db.followUp.count({ where: { workspaceId, status: "SENT", executedAt: range } }),
  ]);

  const confirmedStatuses = ["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED"];
  const counts: DailyCounts = {
    conversations,
    inboundMessages: messages.filter((m) => m.direction === "INBOUND").length,
    outboundMessages: messages.filter((m) => m.direction === "OUTBOUND").length,
    aiCalls: aiLogs.length,
    aiTokens: aiLogs.reduce((s, l) => s + l.promptTokens + l.completionTokens, 0),
    aiCostUsd: aiLogs.some((l) => l.costUsd !== null)
      ? aiLogs.reduce((s, l) => s + (l.costUsd ?? 0), 0)
      : null,
    ordersCreated: orders.length,
    ordersConfirmed: orders.filter((o) => confirmedStatuses.includes(o.status)).length,
    ordersDelivered: orders.filter((o) => o.status === "DELIVERED").length,
    revenueConfirmed: orders
      .filter((o) => confirmedStatuses.includes(o.status))
      .reduce((s, o) => s + Number(o.total), 0),
    revenueDelivered: orders.filter((o) => o.status === "DELIVERED").reduce((s, o) => s + Number(o.total), 0),
    handoffs,
    automationExecutions: automations,
    followUpsSent: followUps,
  };

  await db.dailyWorkspaceAnalytics.upsert({
    where: { workspaceId_date: { workspaceId, date: start } },
    create: { workspaceId, date: start, ...counts },
    update: { ...counts },
  });
  log.debug({ workspaceId, day: start instanceof Date && !isNaN(start.getTime()) ? start.toISOString() : String(start) }, "daily_analytics_rebuilt");
}

/** Rebuilds a range of days for one workspace (idempotent, resumable). */
export async function rebuildRange(db: DbClient, workspaceId: string, start: Date, end: Date): Promise<number> {
  const days = eachUtcDay(start, end);
  for (const day of days) {
    await rebuildDailyAnalytics(db, workspaceId, day);
  }
  return days.length;
}
