import type { Prisma } from "@prisma/client";
import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";

export type HandoffReason =
  | "CUSTOMER_REQUEST" | "COMPLAINT" | "LOW_CONFIDENCE" | "AI_FAILURE"
  | "ORDER_BLOCKED" | "PAYMENT_ISSUE" | "INJECTION_DETECTED" | "REPEATED_FAILURE" | "MANUAL";

export type HandoffPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

/** Server-side minimum priority per reason — AI never picks priority freely. */
const MIN_PRIORITY: Record<HandoffReason, HandoffPriority> = {
  PAYMENT_ISSUE: "HIGH",
  REPEATED_FAILURE: "HIGH",
  AI_FAILURE: "HIGH",
  INJECTION_DETECTED: "HIGH",
  ORDER_BLOCKED: "HIGH",
  COMPLAINT: "NORMAL",
  CUSTOMER_REQUEST: "NORMAL",
  LOW_CONFIDENCE: "NORMAL",
  MANUAL: "NORMAL",
};

const PRIORITY_ORDER: Record<HandoffPriority, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 };

export async function createHandoff(
  db: Db,
  params: {
    workspaceId: string;
    conversationId: string;
    customerId: string;
    reason: HandoffReason;
    priority?: HandoffPriority;
    metadata?: Record<string, unknown>;
    actorUserId?: string;
  }
) {
  // AI proposes the reason; server policy enforces the minimum priority.
  const minimum = MIN_PRIORITY[params.reason] ?? "NORMAL";
  const priority: HandoffPriority =
    params.priority && PRIORITY_ORDER[params.priority] > PRIORITY_ORDER[minimum]
      ? params.priority
      : minimum;

  // Reuse an existing OPEN handoff for the same conversation.
  const open = await db.humanHandoff.findFirst({
    where: { workspaceId: params.workspaceId, conversationId: params.conversationId, status: "OPEN" },
  });
  if (open) return open;

  const handoff = await db.humanHandoff.create({
    data: {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      customerId: params.customerId,
      reason: params.reason,
      priority,
      metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });

  // Invariant: a handoff pauses the AI. HUMAN_ACTIVE until explicit release.
  await db.conversation.update({
    where: { id: params.conversationId },
    data: { aiState: "HUMAN_ACTIVE", aiEnabled: false },
  });

  await recordAudit(db, {
    workspaceId: params.workspaceId,
    userId: params.actorUserId ?? null,
    action: "human.handoff_created",
    entityType: "HumanHandoff",
    entityId: handoff.id,
    metadata: { reason: params.reason, priority },
  });
  await eventBus.publish(
    makeEvent("ConversationUpdated", params.workspaceId, { type: "HumanHandoffCreated", handoffId: handoff.id, reason: params.reason })
  );
  return handoff;
}

export async function getOwnedHandoff(db: Db, workspaceId: string, handoffId: string) {
  const handoff = await db.humanHandoff.findUnique({ where: { id: handoffId } });
  if (!handoff || handoff.workspaceId !== workspaceId) throw new NotFoundError("Handoff");
  return handoff;
}

/** Atomic claim: OPEN → CLAIMED conditioned on status; loser gets 409. */
export async function claimHandoff(db: Db, ctx: ActorContext, handoffId: string) {
  const handoff = await getOwnedHandoff(db, ctx.workspaceId, handoffId);
  const res = await db.humanHandoff.updateMany({
    where: { id: handoff.id, status: "OPEN" },
    data: { status: "CLAIMED", assignedTo: ctx.userId, claimedAt: new Date() },
  });
  if (res.count === 0) {
    throw new AppError("Handoff already claimed", 409, "ALREADY_CLAIMED");
  }
  await db.conversation.update({
    where: { id: handoff.conversationId },
    data: { assignedAgentId: ctx.userId, aiState: "HUMAN_ACTIVE", aiEnabled: false },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "human.handoff_claimed",
    entityType: "HumanHandoff",
    entityId: handoff.id,
  });
  return db.humanHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
}

/** Release: back to the queue (OPEN), agent unassigned. */
export async function releaseHandoff(db: Db, ctx: ActorContext, handoffId: string) {
  const handoff = await getOwnedHandoff(db, ctx.workspaceId, handoffId);
  if (handoff.status !== "CLAIMED") {
    throw new AppError("Only claimed handoffs can be released", 422, "INVALID_HANDOFF_STATE");
  }
  const updated = await db.humanHandoff.update({
    where: { id: handoff.id },
    data: { status: "OPEN", assignedTo: null, claimedAt: null },
  });
  await db.conversation.update({
    where: { id: handoff.conversationId },
    data: { assignedAgentId: null },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "human.handoff_released",
    entityType: "HumanHandoff",
    entityId: handoff.id,
  });
  return updated;
}

/** Resolve. AI stays paused until an explicit release-to-AI (existing endpoint). */
export async function resolveHandoff(db: Db, ctx: ActorContext, handoffId: string) {
  const handoff = await getOwnedHandoff(db, ctx.workspaceId, handoffId);
  if (handoff.status === "RESOLVED" || handoff.status === "CANCELLED") {
    throw new AppError("Handoff already closed", 422, "INVALID_HANDOFF_STATE");
  }
  const updated = await db.humanHandoff.update({
    where: { id: handoff.id },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "human.handoff_resolved",
    entityType: "HumanHandoff",
    entityId: handoff.id,
  });
  await eventBus.publish(
    makeEvent("ConversationUpdated", ctx.workspaceId, { type: "HumanHandoffResolved", handoffId: handoff.id })
  );
  return updated;
}

/** Deterministic routing: ROUND_ROBIN or LEAST_LOADED among active agents. */
export async function routeHandoff(
  db: Db,
  workspaceId: string,
  handoffId: string,
  strategy: "ROUND_ROBIN" | "LEAST_LOADED" = "LEAST_LOADED"
) {
  const handoff = await getOwnedHandoff(db, workspaceId, handoffId);
  if (handoff.status !== "OPEN") throw new AppError("Handoff not open", 422, "INVALID_HANDOFF_STATE");

  const members = await db.workspaceMember.findMany({
    where: { workspaceId, status: "ACTIVE", role: { in: ["OWNER", "ADMIN", "MANAGER", "SALES_AGENT", "SUPPORT_AGENT"] } },
    include: { user: { select: { id: true, availability: true } } },
  });
  const candidates = members.filter((m) => m.user.availability !== "OFFLINE");
  if (candidates.length === 0) throw new AppError("No available agents", 422, "NO_AGENTS");

  let chosen: string;
  if (strategy === "LEAST_LOADED") {
    const openCounts = await db.conversation.groupBy({
      by: ["assignedAgentId"],
      where: { workspaceId, assignedAgentId: { not: null }, status: "OPEN" },
      _count: { assignedAgentId: true },
    });
    const countMap = new Map(openCounts.map((c) => [c.assignedAgentId, c._count.assignedAgentId]));
    chosen = candidates
      .map((m) => m.user.id)
      .sort((a, b) => (countMap.get(a) ?? 0) - (countMap.get(b) ?? 0))[0];
  } else {
    // ROUND_ROBIN: stable rotation by lexicographic claim history length.
    const claimedCounts = await db.humanHandoff.groupBy({
      by: ["assignedTo"],
      where: { workspaceId, assignedTo: { not: null } },
      _count: { assignedTo: true },
    });
    const map = new Map(claimedCounts.map((c) => [c.assignedTo, c._count.assignedTo]));
    chosen = candidates.map((m) => m.user.id).sort((a, b) => (map.get(a) ?? 0) - (map.get(b) ?? 0))[0];
  }

  const res = await db.humanHandoff.updateMany({
    where: { id: handoff.id, status: "OPEN" },
    data: { status: "CLAIMED", assignedTo: chosen, claimedAt: new Date() },
  });
  if (res.count === 0) throw new AppError("Handoff already claimed", 409, "ALREADY_CLAIMED");
  await db.conversation.update({
    where: { id: handoff.conversationId },
    data: { assignedAgentId: chosen, aiState: "HUMAN_ACTIVE", aiEnabled: false },
  });
  await recordAudit(db, {
    workspaceId,
    action: "human.handoff_routed",
    entityType: "HumanHandoff",
    entityId: handoffId,
    metadata: { strategy, agentId: chosen },
  });
  return db.humanHandoff.findUniqueOrThrow({ where: { id: handoffId } });
}


