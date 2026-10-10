import type { Prisma } from "@prisma/client";
import { childLogger } from "@/core/logger";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { Db } from "@/modules/customers/service";
import { dispatchOutbound } from "@/modules/channels/outbound";

const log = childLogger("followups");

export interface CreateFollowUpInput {
  workspaceId: string;
  customerId: string;
  conversationId?: string | null;
  orderId?: string | null;
  type: string;
  messageText: string;
  scheduledAt: Date;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persists a follow-up. Idempotent via unique idempotencyKey — the same
 * automation event can never schedule the same follow-up twice.
 */
export async function createFollowUp(db: Db, input: CreateFollowUpInput) {
  const existing = await db.followUp.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return existing;
  const followUp = await db.followUp.create({
    data: {
      workspaceId: input.workspaceId,
      customerId: input.customerId,
      conversationId: input.conversationId ?? null,
      orderId: input.orderId ?? null,
      type: input.type,
      messageText: input.messageText,
      scheduledAt: input.scheduledAt,
      idempotencyKey: input.idempotencyKey,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
  await recordAudit(db, {
    workspaceId: input.workspaceId,
    action: "followup.scheduled",
    entityType: "FollowUp",
    entityId: followUp.id,
    metadata: { type: input.type, scheduledAt: input.scheduledAt.toISOString() },
  });
  return followUp;
}

export async function cancelFollowUp(db: Db, ctx: { userId: string; workspaceId: string }, followUpId: string) {
  const followUp = await db.followUp.findUnique({ where: { id: followUpId } });
  if (!followUp || followUp.workspaceId !== ctx.workspaceId) {
    throw new Error("FollowUp not found");
  }
  if (followUp.status !== "SCHEDULED") {
    throw new Error(`Cannot cancel a follow-up in status ${followUp.status}`);
  }
  const updated = await db.followUp.update({
    where: { id: followUpId },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "followup.cancelled",
    entityType: "FollowUp",
    entityId: followUpId,
  });
  return updated;
}

export interface ClaimedFollowUp {
  id: string;
  workspaceId: string;
  customerId: string;
  conversationId: string | null;
  orderId: string | null;
  type: string;
  messageText: string | null;
  attempts: number;
}

/**
 * Atomic claim: SCHEDULED → RUNNING. With the unique status guard only one
 * worker wins even with N concurrent claims (optimistic transition).
 */
export async function claimDueFollowUps(db: Db, limit = 10): Promise<ClaimedFollowUp[]> {
  const due = await db.followUp.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
    take: limit,
  });
  const claimed: ClaimedFollowUp[] = [];
  for (const f of due) {
    // Atomic-ish claim via updateMany conditioned on status; count=1 → we won.
    const res = await db.followUp.updateMany({
      where: { id: f.id, status: "SCHEDULED" },
      data: { status: "RUNNING", attempts: { increment: 1 } },
    });
    if (res.count === 1) {
      claimed.push({
        id: f.id,
        workspaceId: f.workspaceId,
        customerId: f.customerId,
        conversationId: f.conversationId,
        orderId: f.orderId,
        type: f.type,
        messageText: f.messageText,
        attempts: f.attempts + 1,
      });
    }
  }
  return claimed;
}

/** Executes one claimed follow-up through the ChannelSender (policy enforced). */
export async function executeFollowUp(db: Db, f: ClaimedFollowUp): Promise<"SENT" | "SKIPPED" | "FAILED"> {
  try {
    if (!f.conversationId || !f.messageText) {
      await db.followUp.update({
        where: { id: f.id },
        data: { status: "SKIPPED", executedAt: new Date(), lastError: "NO_CONVERSATION_OR_TEXT" },
      });
      return "SKIPPED";
    }
    const result = await dispatchOutbound(db, {
      workspaceId: f.workspaceId,
      conversationId: f.conversationId,
      // Outbound idempotency: the follow-up itself is the source identity.
      sourceMessageId: `followup:${f.id}`,
      text: f.messageText,
    });
    if (result.deliveryStatus === "SENT") {
      await db.followUp.update({ where: { id: f.id }, data: { status: "SENT", executedAt: new Date() } });
      await eventBus.publish(
        makeEvent("CustomerUpdated", f.workspaceId, { customerId: f.customerId, type: "followup.sent", followUpId: f.id })
      );
      log.info({ followUpId: f.id }, "followup.sent");
      return "SENT";
    }
    if (result.deliveryStatus === "FAILED" && result.error?.startsWith("POLICY_")) {
      // Policy blocked (e.g. window closed) → SKIPPED, never retried blindly.
      await db.followUp.update({
        where: { id: f.id },
        data: { status: "SKIPPED", executedAt: new Date(), lastError: result.error },
      });
      return "SKIPPED";
    }
    // Transient channel failure → back to SCHEDULED for retry (max 5 attempts).
    const current = await db.followUp.findUniqueOrThrow({ where: { id: f.id } });
    if (current.attempts >= 5) {
      await db.followUp.update({
        where: { id: f.id },
        data: { status: "FAILED", lastError: result.error ?? "max attempts" },
      });
      return "FAILED";
    }
    await db.followUp.update({
      where: { id: f.id },
      data: { status: "SCHEDULED", scheduledAt: new Date(Date.now() + 15 * 60_000), lastError: result.error },
    });
    return "FAILED";
  } catch (err) {
    await db.followUp.update({
      where: { id: f.id },
      data: { status: "FAILED", lastError: err instanceof Error ? err.message : String(err) },
    });
    return "FAILED";
  }
}

/**
 * P7: cancel all SCHEDULED follow-ups for a customer (optionally by type).
 * Used by the CANCEL_FOLLOW_UPS workflow action ("customer replied" flows).
 * Workspace-scoped; returns the count actually cancelled.
 */
export async function cancelFollowUpsFor(
  db: Db,
  workspaceId: string,
  customerId: string,
  type: string | null
): Promise<number> {
  const where: Record<string, unknown> = { workspaceId, customerId, status: "SCHEDULED" };
  if (type) where.type = type;
  const res = await db.followUp.updateMany({
    where: where as never,
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  if (res.count > 0) {
    await recordAudit(db, {
      workspaceId,
      action: "followup.bulk_cancelled",
      entityType: "Customer",
      entityId: customerId,
      metadata: { count: res.count, type: type ?? null },
    });
  }
  return res.count;
}

/** Scheduler entry: claim + execute due follow-ups (called by the worker/cron). */
export async function processDueFollowUps(db: Db, limit = 10) {
  const claimed = await claimDueFollowUps(db, limit);
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const f of claimed) {
    const res = await executeFollowUp(db, f);
    if (res === "SENT") sent += 1;
    else if (res === "SKIPPED") skipped += 1;
    else failed += 1;
  }
  return { claimed: claimed.length, sent, skipped, failed };
}


