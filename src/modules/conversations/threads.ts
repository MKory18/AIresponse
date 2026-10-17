import type { Prisma, MessageType, ConversationStatus } from "@prisma/client";
import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import { type Db, type ActorContext, type Paginated } from "@/modules/customers/service";

// ---- Guards ----
// P1: moved verbatim from service.ts (no logic change).

export async function getOwnedConversation(db: Db, workspaceId: string, conversationId: string) {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    include: { customer: { select: { id: true, name: true, phone: true, avatarUrl: true } } },
  });
  if (!conversation || conversation.workspaceId !== workspaceId) {
    throw new NotFoundError("Conversation");
  }
  if ((conversation as { deletedAt?: Date | null }).deletedAt) {
    throw new NotFoundError("Conversation");
  }
  return conversation;
}

// ---- Listing / pagination / search (server-side) ----

export interface ConversationListRow {
  id: string;
  status: ConversationStatus;
  aiState: "AI_ACTIVE" | "AI_PAUSED" | "HUMAN_ACTIVE";
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  tags: string[];
  unreadCount: number;
  summary: string | null;
  lastCustomerMessageAt: Date | null;
  lastAgentMessageAt: Date | null;
  assignedAgentId: string | null;
  customer: {
    id: string;
    name: string | null;
    phone: string | null;
    status: string;
    avatarUrl: string | null;
    identities: { displayName: string | null; avatarUrl: string | null; channelType: string }[];
  };
  channel: {
    type: string;
    displayName: string | null;
    externalId: string | null;
    account: { pageName: string | null } | null;
  };
  assignedAgent: { id: string; name: string } | null;
  lastMessage?: { text: string | null; createdAt: string } | null;
  /** Independent review flag: OPEN HumanHandoff exists (ownership unchanged). */
  hasOpenHandoff: boolean;
  /** Page-resolved persona (channel assignment → workspace default). */
  aiPersona: { id: string; name: string; source: "channel" | "workspace" } | null;
}

export async function listConversations(
  db: Db,
  params: {
    workspaceId: string;
    status?: ConversationStatus;
    aiState?: "AI_ACTIVE" | "AI_PAUSED" | "HUMAN_ACTIVE";
    unreadOnly?: boolean;
    q?: string;
    cursor?: string;
    limit?: number;
    /** P4 server-side filters: priority, assignee, channel, activity range. */
    priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
    /** "me" | "none" | agent cuid (resolved against actorUserId for "me"). */
    assignee?: string;
    actorUserId?: string;
    channelType?: "FACEBOOK" | "INSTAGRAM" | "WHATSAPP" | "TELEGRAM" | "WEB";
    /** Filter by a specific connected page/channel (overrides channelType). */
    channelId?: string;
    /** ISO dates bounding conversation activity (updatedAt). */
    dateFrom?: string;
    dateTo?: string;
  }
): Promise<Paginated<ConversationListRow>> {
  const limit = Math.min(params.limit ?? 30, 100);
  const where: Prisma.ConversationWhereInput = {
    workspaceId: params.workspaceId,
    deletedAt: null,
  };
  if (params.status) where.status = params.status;
  if (params.aiState) where.aiState = params.aiState;
  if (params.unreadOnly) where.unreadCount = { gt: 0 };
  if (params.priority) where.priority = params.priority;
  if (params.assignee && params.assignee !== "all") {
    if (params.assignee === "none") {
      where.assignedAgentId = null;
    } else if (params.assignee === "me" && params.actorUserId) {
      where.assignedAgentId = params.actorUserId;
    } else if (params.assignee !== "me") {
      where.assignedAgentId = params.assignee;
    }
  }
  if (params.channelId) {
    // Specific connected page/channel — scoped to this workspace for safety.
    where.channelId = params.channelId;
  } else if (params.channelType) {
    // Two-step (no relation join): identical on Postgres and the test double.
    const channels = await db.channel.findMany({
      where: { workspaceId: params.workspaceId, type: params.channelType },
      select: { id: true },
    });
    where.channelId = { in: channels.map((c) => c.id) };
  }
  const from = params.dateFrom ? new Date(params.dateFrom) : null;
  const to = params.dateTo ? new Date(params.dateTo) : null;
  if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to))) {
    where.updatedAt = {
      ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}),
      ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}),
    };
  }

  if (params.q) {
    const matchingCustomers = await db.customer.findMany({
      where: {
        workspaceId: params.workspaceId,
        OR: [
          { name: { contains: params.q, mode: "insensitive" } },
          { phone: { contains: params.q } },
          { identities: { some: { channelExternalId: { contains: params.q } } } },
        ],
      },
      select: { id: true },
      take: 200,
    });
    const matchingChannels = await db.channel.findMany({
      where: {
        workspaceId: params.workspaceId,
        OR: [
          { displayName: { contains: params.q, mode: "insensitive" } },
          { externalId: { contains: params.q } },
        ],
      },
      select: { id: true },
      take: 50,
    });
    where.OR = [
      { customerId: { in: matchingCustomers.map((c) => c.id) } },
      { channelId: { in: matchingChannels.map((c) => c.id) } },
      { messages: { some: { text: { contains: params.q, mode: "insensitive" } } } },
    ];
  }

  const conversations = await db.conversation.findMany({
    where,
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          phone: true,
          status: true,
          avatarUrl: true,
          identities: { select: { displayName: true, avatarUrl: true, channelType: true } },
        },
      },
      channel: {
        select: {
          type: true,
          displayName: true,
          externalId: true,
          aiPersonaId: true,
          account: { select: { pageName: true } },
        },
      },
      assignedAgent: { select: { id: true, name: true } },
    },
    orderBy: [{ lastCustomerMessageAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });

  const hasMore = conversations.length > limit;
  const items = hasMore ? conversations.slice(0, limit) : conversations;

  // Two extra queries total (no N+1): review flags + resolved page personas.
  const openHandoffs = await (db as unknown as {
    humanHandoff: { findMany: (args: unknown) => Promise<{ conversationId: string }[]> };
  }).humanHandoff.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: "OPEN",
      conversationId: { in: items.map((c) => c.id) },
    },
    select: { conversationId: true },
  }).catch(() => []);
  const needsReview = new Set(openHandoffs.map((h) => h.conversationId));
  const defaultPersona = await (db as unknown as {
    persona: { findFirst: (args: unknown) => Promise<{ id: string; name: string } | null> };
  }).persona.findFirst({
    where: { workspaceId: params.workspaceId, isActive: true },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true },
  }).catch(() => null);
  const assignedIds = [
    ...new Set(
      items.map((c) => (c.channel as { aiPersonaId?: string | null }).aiPersonaId).filter(Boolean)
    ),
  ] as string[];
  const personaNames = new Map<string, string>();
  if (assignedIds.length > 0) {
    const assigned = await (db as unknown as {
      persona: { findMany: (args: unknown) => Promise<{ id: string; name: string }[]> };
    }).persona.findMany({
      where: { workspaceId: params.workspaceId, id: { in: assignedIds } },
      select: { id: true, name: true },
    }).catch(() => []);
    for (const p of assigned) personaNames.set(p.id, p.name);
  }
  const enriched = items.map((c) => {
    const channelPersonaId = (c.channel as { aiPersonaId?: string | null }).aiPersonaId ?? null;
    return {
      ...c,
      hasOpenHandoff: needsReview.has(c.id),
      aiPersona:
        channelPersonaId && personaNames.has(channelPersonaId)
          ? { id: channelPersonaId, name: personaNames.get(channelPersonaId) as string, source: "channel" as const }
          : defaultPersona
            ? { id: defaultPersona.id, name: defaultPersona.name, source: "workspace" as const }
            : null,
    };
  });
  // Latest message preview per listed conversation — one bounded query.
  const previews = await (db as unknown as {
    message: {
      findMany: (args: unknown) => Promise<{ conversationId: string; text: string | null; createdAt: Date }[]>;
    };
  }).message.findMany({
    // P4: previews stay customer/channel-facing (notes don't reorder threads).
    where: { conversationId: { in: enriched.map((c) => c.id) }, deletedAt: null, isNote: false },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: enriched.length * 3,
    select: { conversationId: true, text: true, createdAt: true },
  }).catch(() => []);
  const previewByConv = new Map<string, { text: string | null; createdAt: string }>();
  for (const p of previews) {
    if (!previewByConv.has(p.conversationId)) {
      previewByConv.set(p.conversationId, {
        text: p.text,
        createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt),
      });
    }
  }
  const withPreview = enriched.map((c) => ({ ...c, lastMessage: previewByConv.get(c.id) ?? null }));
  return { items: withPreview as unknown as ConversationListRow[], nextCursor: hasMore ? items[items.length - 1].id : null };
}

export async function getConversationDetail(db: Db, ctx: ActorContext, conversationId: string) {
  const conversation = await getOwnedConversation(db, ctx.workspaceId, conversationId);
  // Page identity for the header badge — same source as the list.
  const channel = await db.channel.findUnique({
    where: { id: conversation.channelId },
    select: {
      type: true,
      displayName: true,
      externalId: true,
      aiPersonaId: true,
      account: { select: { pageName: true } },
    },
  });
  const identities = await db.channelIdentity.findMany({
    where: { workspaceId: ctx.workspaceId, customerId: conversation.customerId },
    select: { displayName: true, avatarUrl: true, channelType: true },
  });
  const { resolveChannelPersona } = await import("@/modules/ai/channel-persona");
  const persona = await resolveChannelPersona(db, {
    workspaceId: ctx.workspaceId,
    channelId: conversation.channelId,
  });
  const orders = await db.order.findMany({
    where: { workspaceId: ctx.workspaceId, customerId: conversation.customerId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, orderNumber: true, status: true, total: true, currency: true, createdAt: true },
  });
  // Open handoff (if any) for the thread banner — same workspace scope.
  const openHandoff = await (db as unknown as {
    humanHandoff: { findFirst: (args: unknown) => Promise<Record<string, unknown> | null> };
  }).humanHandoff.findFirst({
    where: { workspaceId: ctx.workspaceId, conversationId, status: { in: ["OPEN", "CLAIMED"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, reason: true, status: true, priority: true, createdAt: true },
  }).catch(() => null);
  // Assignment/team activity for the thread (audited actions only, bounded).
  const activity = await (db as unknown as {
    auditLog: { findMany: (args: unknown) => Promise<Array<Record<string, unknown>>> };
  }).auditLog.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      entityType: "Conversation",
      entityId: conversationId,
      action: {
        in: [
          "conversation.assigned",
          "conversation.unassigned",
          "conversation.takeover",
          "conversation.released_to_ai",
          "conversation.review_requested",
          "conversation.ai_failed",
          "note.created",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, action: true, userId: true, createdAt: true, metadata: true },
  }).catch(() => []);
  const actorIds = [...new Set(activity.map((a) => a.userId).filter((u): u is string => typeof u === "string"))];
  const actors = actorIds.length
    ? await db.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true },
      }).catch(() => [])
    : [];
  const names = new Map((actors as { id: string; name: string }[]).map((u) => [u.id, u.name]));
  return {
    ...conversation,
    channel: channel ?? { type: "FACEBOOK", displayName: null, externalId: null, account: null },
    customer: { ...conversation.customer, identities },
    aiPersona: persona.id ? { id: persona.id, name: persona.name, source: persona.source } : null,
    orders,
    aiSummary: conversation.summary ?? null,
    openHandoff,
    assignmentHistory: activity.map((a) => ({
      id: a.id,
      action: a.action,
      actorName: typeof a.userId === "string" ? (names.get(a.userId) ?? null) : null,
      createdAt: a.createdAt,
      metadata: a.metadata ?? null,
    })),
  };
}

// ---- Internal notes (team-only; never sent to the customer) ----

/**
 * Posts an internal note on a thread. Notes are Message rows flagged
 * `isNote` (senderType HUMAN, direction INBOUND):
 * - They render in the thread (labeled) but NEVER enter ChannelSender:
 *   dispatchOutbound/recovery/retry only touch OUTBOUND rows they created,
 *   and the retry endpoint requires OUTBOUND + idempotency key (notes 404).
 * - They are excluded from AI history, analytics volumes, and latest
 *   previews (see the `isNote: false` filters) so metrics stay honest.
 * - deliveryStatus is meaningless for notes (default PENDING is kept as-is
 *   and ignored by every reader — isNote is checked first).
 */
export async function postNote(
  db: Db,
  ctx: ActorContext,
  conversationId: string,
  text: string
) {
  await getOwnedConversation(db, ctx.workspaceId, conversationId);
  const clean = text.trim();
  if (!clean) {
    throw new AppError("Note must not be empty", 422, "VALIDATION_ERROR");
  }
  if (clean.length > 4000) {
    throw new AppError("Note is too long (max 4000 chars)", 422, "VALIDATION_ERROR");
  }
  const note = await db.message.create({
    data: {
      conversationId,
      workspaceId: ctx.workspaceId,
      senderType: "HUMAN",
      senderId: ctx.userId,
      direction: "INBOUND",
      type: "TEXT",
      text: clean,
      isNote: true,
      metadata: {},
    },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "note.created",
    entityType: "Conversation",
    entityId: conversationId,
    ip: ctx.ip,
    metadata: { messageId: (note as { id: string }).id },
  });
  return note;
}

export async function listMessages(
  db: Db,
  ctx: ActorContext,
  conversationId: string,
  params: { cursor?: string; limit?: number; before?: boolean }
) {
  await getOwnedConversation(db, ctx.workspaceId, conversationId);
  const limit = Math.min(params.limit ?? 50, 200);
  // Pagination over a bounded window (500) in JS: avoids createdAt-tie
  // issues (same-ms inserts) and keeps mock + Postgres behavior identical.
  // Default (no cursor): latest `limit` in asc order so new messages show.
  // With cursor (oldest visible id): the previous `limit` older messages.
  const window = await db.message.findMany({
    where: { conversationId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 500,
  });
  if (!params.cursor) {
    const page = window.slice(-limit);
    const hasMore = window.length > limit;
    return {
      items: page,
      nextCursor: hasMore && page.length ? page[0].id : null,
    };
  }
  const idx = window.findIndex((m) => m.id === params.cursor);
  if (idx === -1) {
    const messages = await db.message.findMany({
      where: { conversationId, deletedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      cursor: { id: params.cursor },
      skip: 1,
    });
    const hasMore = messages.length > limit;
    const items = hasMore ? messages.slice(0, limit) : messages;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }
  const older = window.slice(0, idx);
  const page = older.slice(-limit);
  const hasMore = older.length > limit;
  return {
    items: page,
    nextCursor: hasMore && page.length ? page[0].id : null,
  };
}

// ---- Outbound (human replies; AI responses route through the same function) ----

export async function postOutboundMessage(
  db: Db,
  ctx: ActorContext,
  conversationId: string,
  input: { type?: MessageType; text?: string; mediaUrl?: string; metadata?: Record<string, unknown> },
  senderType: "HUMAN" | "AI" = "HUMAN"
) {
  if (!input.text?.trim() && !input.mediaUrl) {
    throw new AppError("Message must have text or media", 422, "VALIDATION_ERROR");
  }
  const conversation = await getOwnedConversation(db, ctx.workspaceId, conversationId);

  const message = await db.message.create({
    data: {
      conversationId,
      workspaceId: ctx.workspaceId,
      senderType,
      senderId: ctx.userId,
      direction: "OUTBOUND",
      type: input.type ?? "TEXT",
      text: input.text ?? null,
      mediaUrl: input.mediaUrl ?? null,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      provider: "dashboard",
      deliveryStatus: "SENT",
    },
  });

  const now = new Date();
  await db.conversation.update({
    where: { id: conversationId },
    data: {
      lastAgentMessageAt: now,
      // A human reply while AI is active implies human engagement; keep aiState
      // unchanged — explicit takeover is the source of truth for AI gating.
    },
  });

  await eventBus.publish(
    makeEvent("MessageCreated", ctx.workspaceId, {
      conversationId,
      messageId: message.id,
      direction: "OUTBOUND",
      senderType: "HUMAN",
    })
  );

  return message;
}

// ---- Unread management ----

export async function markConversationRead(db: Db, ctx: ActorContext, conversationId: string) {
  await getOwnedConversation(db, ctx.workspaceId, conversationId);
  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: { unreadCount: 0 },
  });
  await eventBus.publish(makeEvent("MessageRead", ctx.workspaceId, { conversationId, unreadCount: 0 }));
  return updated;
}

export async function markConversationUnread(db: Db, ctx: ActorContext, conversationId: string) {
  await getOwnedConversation(db, ctx.workspaceId, conversationId);
  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: { unreadCount: { increment: 1 } },
  });
  return updated;
}

// ---- Soft delete (hide from inbox, preserve Customer/Orders/history) ----

/**
 * Soft-deletes a conversation: sets deletedAt/deletedBy so it disappears from
 * the inbox list, detail, and polling — while Customer, Orders, Messages,
 * usage logs, and audit history are fully preserved (nothing is hard-deleted).
 * Open follow-ups/handoffs for the thread are cancelled so no future send
 * targets a hidden conversation. Workspace-isolated + audited.
 */
export async function deleteConversation(db: Db, ctx: ActorContext, conversationId: string) {
  const conversation = await getOwnedConversation(db, ctx.workspaceId, conversationId);

  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: { deletedAt: new Date(), deletedBy: ctx.userId, unreadCount: 0 },
  });

  // Cancel pending automation for the hidden thread (best-effort).
  try {
    await (db as unknown as {
      followUp: { updateMany: (args: unknown) => Promise<unknown> };
    }).followUp.updateMany({
      where: { workspaceId: ctx.workspaceId, conversationId, status: "SCHEDULED" },
      data: { status: "CANCELLED" },
    });
  } catch { /* never break deletion */ }
  try {
    await (db as unknown as {
      humanHandoff: { updateMany: (args: unknown) => Promise<unknown> };
    }).humanHandoff.updateMany({
      where: { workspaceId: ctx.workspaceId, conversationId, status: { in: ["OPEN", "CLAIMED"] } },
      data: { status: "CANCELLED", resolvedAt: new Date() },
    });
  } catch { /* never break deletion */ }

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "conversation.deleted",
    entityType: "Conversation",
    entityId: conversationId,
    ip: ctx.ip,
    metadata: { customerId: conversation.customerId },
  });

  await eventBus.publish(
    makeEvent("ConversationUpdated", ctx.workspaceId, { conversationId, type: "ConversationDeleted" })
  );
  return updated;
}

// ---- Assignment / takeover / release / status ----

async function assertWorkspaceMember(db: Db, workspaceId: string, userId: string) {
  const member = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { status: true },
  });
  if (!member || member.status !== "ACTIVE") {
    throw new AppError("Target agent is not an active workspace member", 422, "INVALID_AGENT");
  }
}

export async function assignConversation(
  db: Db,
  ctx: ActorContext,
  conversationId: string,
  agentId: string | null
) {
  await getOwnedConversation(db, ctx.workspaceId, conversationId);
  if (agentId) await assertWorkspaceMember(db, ctx.workspaceId, agentId);

  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: { assignedAgentId: agentId },
  });

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: agentId ? "conversation.assigned" : "conversation.unassigned",
    entityType: "Conversation",
    entityId: conversationId,
    ip: ctx.ip,
    metadata: { agentId },
  });

  await eventBus.publish(
    makeEvent("ConversationAssigned", ctx.workspaceId, { conversationId, agentId })
  );
  return updated;
}

/** Human takeover: stops all automatic AI sending for this conversation. */
export async function takeoverConversation(db: Db, ctx: ActorContext, conversationId: string) {
  const conversation = await getOwnedConversation(db, ctx.workspaceId, conversationId);

  // Takeover always assigns to the acting agent (explicit human ownership).
  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: {
      aiState: "HUMAN_ACTIVE",
      aiEnabled: false,
      assignedAgentId: ctx.userId,
    },
  });

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "conversation.takeover",
    entityType: "Conversation",
    entityId: conversationId,
    ip: ctx.ip,
  });

  await eventBus.publish(
    makeEvent("ConversationUpdated", ctx.workspaceId, { conversationId, aiState: "HUMAN_ACTIVE" })
  );
  return updated;
}

async function defaultAssignToSelf(db: Db, ctx: ActorContext, conversationId: string): Promise<string | undefined> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { assignedAgentId: true },
  });
  return conversation?.assignedAgentId ?? ctx.userId;
}

/** Release back to the AI. */
export async function releaseConversationToAI(db: Db, ctx: ActorContext, conversationId: string) {
  await getOwnedConversation(db, ctx.workspaceId, conversationId);

  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: { aiState: "AI_ACTIVE", aiEnabled: true, handoffReason: null },
  });

  // Drain open handoffs so the human queue does not retain released threads.
  await db.humanHandoff.updateMany({
    where: { workspaceId: ctx.workspaceId, conversationId, status: { in: ["OPEN", "CLAIMED"] } },
    data: { status: "CANCELLED", resolvedAt: new Date() },
  });

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "conversation.released_to_ai",
    entityType: "Conversation",
    entityId: conversationId,
    ip: ctx.ip,
  });

  await eventBus.publish(
    makeEvent("ConversationUpdated", ctx.workspaceId, { conversationId, aiState: "AI_ACTIVE" })
  );
  return updated;
}

export async function updateConversation(
  db: Db,
  ctx: ActorContext,
  conversationId: string,
  data: { status?: ConversationStatus; priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT"; tags?: string[] }
) {
  await getOwnedConversation(db, ctx.workspaceId, conversationId);

  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: {
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.priority !== undefined ? { priority: data.priority } : {}),
      ...(data.tags !== undefined ? { tags: data.tags } : {}),
    },
  });

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "conversation.updated",
    entityType: "Conversation",
    entityId: conversationId,
    ip: ctx.ip,
    metadata: { fields: Object.keys(data) },
  });

  if (data.status === "RESOLVED") {
    await eventBus.publish(makeEvent("ConversationResolved", ctx.workspaceId, { conversationId }));
  }
  await eventBus.publish(makeEvent("ConversationUpdated", ctx.workspaceId, { conversationId }));
  return updated;
}
