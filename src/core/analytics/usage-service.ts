import type { Prisma } from "@prisma/client";
import { childLogger } from "@/core/logger";

const log = childLogger("usage");

type UsageDb = Pick<Prisma.TransactionClient, "workspaceUsage">;

export interface UsageDelta {
  messagesInbound?: number;
  messagesOutbound?: number;
  aiCalls?: number;
  aiInputTokens?: number;
  aiOutputTokens?: number;
  ordersCreated?: number;
  ordersConfirmed?: number;
  ordersDelivered?: number;
  automationExecutions?: number;
  followUpsSent?: number;
  humanHandoffs?: number;
}

function currentPeriod(now = new Date()): { periodStart: Date; periodEnd: Date } {
  // MONTHLY periods anchored to UTC month start (design allows DAILY later).
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart, periodEnd };
}

/**
 * Event-time usage increment. Called ONLY from trusted domain sites (never the
 * dashboard). Failure-isolated: a usage metering problem never breaks a domain
 * operation.
 */
export async function incrementUsage(db: UsageDb, workspaceId: string, delta: UsageDelta): Promise<void> {
  try {
    const { periodStart, periodEnd } = currentPeriod();
    await db.workspaceUsage.upsert({
      where: { workspaceId_periodStart: { workspaceId, periodStart } },
      create: {
        workspaceId, periodStart, periodEnd,
        ...(delta.messagesInbound ? { messagesInbound: delta.messagesInbound } : {}),
        ...(delta.messagesOutbound ? { messagesOutbound: delta.messagesOutbound } : {}),
        ...(delta.aiCalls ? { aiCalls: delta.aiCalls } : {}),
        ...(delta.aiInputTokens ? { aiInputTokens: delta.aiInputTokens } : {}),
        ...(delta.aiOutputTokens ? { aiOutputTokens: delta.aiOutputTokens } : {}),
        ...(delta.ordersCreated ? { ordersCreated: delta.ordersCreated } : {}),
        ...(delta.ordersConfirmed ? { ordersConfirmed: delta.ordersConfirmed } : {}),
        ...(delta.ordersDelivered ? { ordersDelivered: delta.ordersDelivered } : {}),
        ...(delta.automationExecutions ? { automationExecutions: delta.automationExecutions } : {}),
        ...(delta.followUpsSent ? { followUpsSent: delta.followUpsSent } : {}),
        ...(delta.humanHandoffs ? { humanHandoffs: delta.humanHandoffs } : {}),
      },
      update: {
        ...(delta.messagesInbound ? { messagesInbound: { increment: delta.messagesInbound } } : {}),
        ...(delta.messagesOutbound ? { messagesOutbound: { increment: delta.messagesOutbound } } : {}),
        ...(delta.aiCalls ? { aiCalls: { increment: delta.aiCalls } } : {}),
        ...(delta.aiInputTokens ? { aiInputTokens: { increment: delta.aiInputTokens } } : {}),
        ...(delta.aiOutputTokens ? { aiOutputTokens: { increment: delta.aiOutputTokens } } : {}),
        ...(delta.ordersCreated ? { ordersCreated: { increment: delta.ordersCreated } } : {}),
        ...(delta.ordersConfirmed ? { ordersConfirmed: { increment: delta.ordersConfirmed } } : {}),
        ...(delta.ordersDelivered ? { ordersDelivered: { increment: delta.ordersDelivered } } : {}),
        ...(delta.automationExecutions ? { automationExecutions: { increment: delta.automationExecutions } } : {}),
        ...(delta.followUpsSent ? { followUpsSent: { increment: delta.followUpsSent } } : {}),
        ...(delta.humanHandoffs ? { humanHandoffs: { increment: delta.humanHandoffs } } : {}),
      },
    });
  } catch (err) {
    log.error({ err }, "usage_increment_failed");
  }
}

export async function getWorkspaceUsageSummary(db: UsageDb, workspaceId: string) {
  const { periodStart, periodEnd } = currentPeriod();
  const usage = await db.workspaceUsage.findUnique({
    where: { workspaceId_periodStart: { workspaceId, periodStart } },
  });
  return {
    periodStart,
    periodEnd,
    usage: usage ?? {
      messagesInbound: 0, messagesOutbound: 0, aiCalls: 0, aiInputTokens: 0,
      aiOutputTokens: 0, ordersCreated: 0, ordersConfirmed: 0, ordersDelivered: 0,
      automationExecutions: 0, followUpsSent: 0, humanHandoffs: 0,
    },
  };
}
