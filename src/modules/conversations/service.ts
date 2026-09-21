import type { Prisma, ChannelType, MessageType, ConversationStatus, MediaType } from "@prisma/client";
import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import { resolveCustomerByChannelIdentity, type Db, type ActorContext, type Paginated } from "@/modules/customers/service";
import { childLogger } from "@/core/logger";

// â”€â”€ Incoming pipeline (AI hooks in Phase 4 at the documented point) â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface IncomingMessageInput {
  workspaceId: string;
  channelType: ChannelType;
  externalUserId: string;
  externalUserName?: string | null;
  externalConversationId: string;
  externalMessageId: string;
  externalEventId: string;
  provider: string;
  type: MessageType;
  text?: string | null;
  mediaUrl?: string | null;
  metadata?: Record<string, unknown>;
  sentAt?: Date;
}

export interface ProcessedIncoming {
  conversationId: string;
  messageId: string;
  customerId: string;
  customerCreated: boolean;
  conversationCreated: boolean;
  duplicate: boolean;
}

/**
 * processIncomingMessage â€” single entry point of the message pipeline:
 *
 * Normalize (caller/adapter) â†’ resolve customer (ChannelIdentity) â†’
 * ensure conversation â†’ idempotency check â†’ persist message â†’
 * update conversation state (unread, timestamps, reopen) â†’ emit events.
 *
 * AI processing is deliberately NOT here: Phase 4 subscribes to
 * `MessageReceived` / enqueues a job â€” no redesign of this function needed.
 */
export async function processIncomingMessage(db: Db, input: IncomingMessageInput): Promise<ProcessedIncoming> {
  const { customerId, created: customerCreated } = await resolveCustomerByChannelIdentity(db, {
    workspaceId: input.workspaceId,
    channelType: input.channelType,
    externalUserId: input.externalUserId,
    displayName: input.externalUserName,
    metadata: input.metadata,
  });

  let conversation = await db.conversation.findUnique({
    where: {
      workspaceId_channelConversationId: {
        workspaceId: input.workspaceId,
        channelConversationId: input.externalConversationId,
      },
    },
  });

  let conversationCreated = false;
  if (!conversation) {
    conversation = await db.conversation.create({
      data: {
        workspaceId: input.workspaceId,
        customerId,
        // Channel rows are managed by the channels module; pipeline requires
        // a channel record per conversation for provider policy checks.
        channelId: await ensureChannelId(db, input.workspaceId, input.channelType),
        channelConversationId: input.externalConversationId,
      },
    });
    conversationCreated = true;
    await eventBus.publish(
      makeEvent("ConversationCreated", input.workspaceId, {
        conversationId: conversation.id,
        customerId,
        channelType: input.channelType,
      })
    );
  }

  // Idempotency: externalEventId (delivery retries) then externalMessageId.
  if (input.externalEventId) {
    const dupe = await db.message.findUnique({
      where: {
        conversationId_externalEventId: {
          conversationId: conversation.id,
          externalEventId: input.externalEventId,
        },
      },
      select: { id: true },
    });
    if (dupe) {
      return {
        conversationId: conversation.id,
        messageId: dupe.id,
        customerId,
        customerCreated,
        conversationCreated,
        duplicate: true,
      };
    }
  }
  if (input.externalMessageId) {
    const dupe = await db.message.findFirst({
      where: { conversationId: conversation.id, externalMessageId: input.externalMessageId },
      select: { id: true },
    });
    if (dupe) {
      return {
        conversationId: conversation.id,
        messageId: dupe.id,
        customerId,
        customerCreated,
        conversationCreated,
        duplicate: true,
      };
    }
  }

  const now = input.sentAt ?? new Date();
  let message;
  try {
    message = await db.message.create({
      data: {
        conversationId: conversation.id,
        workspaceId: input.workspaceId,
        senderType: "CUSTOMER",
        direction: "INBOUND",
        type: input.type,
        text: input.text ?? null,
        mediaUrl: input.mediaUrl ?? null,
        externalMessageId: input.externalMessageId || null,
        externalEventId: input.externalEventId || null,
        provider: input.provider,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      deliveryStatus: "DELIVERED",
      createdAt: now,
      },
    });
  } catch (err) {
    // Concurrent duplicate delivery: the unique constraint won — treat as
    // duplicate and return the winning message (race-safe idempotency).
    const code = (err as { code?: string }).code;
    if (code !== "P2002") throw err;
    const winner = await db.message.findFirst({
      where: { conversationId: conversation.id, externalMessageId: input.externalMessageId || null },
      select: { id: true },
    });
    if (!winner) throw err;
    return {
      conversationId: conversation.id,
      messageId: winner.id,
      customerId,
      customerCreated,
      conversationCreated,
      duplicate: true,
    };
  }

  await db.conversation.update({
    where: { id: conversation.id },
    data: {
      lastCustomerMessageAt: now,
      unreadCount: { increment: 1 },
      ...(conversation.status === "RESOLVED" || conversation.status === "CLOSED"
        ? { status: "OPEN" as ConversationStatus }
        : {}),
    },
  });

  await db.customer.update({
    where: { id: customerId },
    data: { lastContactAt: now },
  });

  const payload = {
    conversationId: conversation.id,
    messageId: message.id,
    customerId,
    channelType: input.channelType,
  };
  await eventBus.publish(makeEvent("MessageReceived", input.workspaceId, payload));
  await eventBus.publish(makeEvent("MessageCreated", input.workspaceId, { ...payload, direction: "INBOUND" }));

  // Enqueue AI processing (Phase 4) — the webhook never waits for the AI.
  // Gating: conversation must be AI_ACTIVE; a failed enqueue never loses the
  // message (persisted above and retryable via /api/jobs/run scanning).
  if (conversation.aiState === "AI_ACTIVE" && conversation.aiEnabled) {
    try {
      const { enqueueJob } = await import("@/modules/jobs/service");
      await enqueueJob(db, {
        workspaceId: input.workspaceId,
        type: "process_ai_message",
        payload: { conversationId: conversation.id, messageId: message.id },
      });
    } catch (err) {
      childLogger("pipeline").error({ err }, "ai_job_enqueue_failed");
    }
  }

  return {
    conversationId: conversation.id,
    messageId: message.id,
    customerId,
    customerCreated,
    conversationCreated,
    duplicate: false,
  };
}

async function ensureChannelId(db: Db, workspaceId: string, channelType: ChannelType): Promise<string> {
  const channel = await db.channel.findFirst({
    where: { workspaceId, type: channelType },
    select: { id: true },
  });
  if (channel) return channel.id;
  const created = await db.channel.create({
    data: { workspaceId, type: channelType, displayName: `${channelType} (auto)`, status: "CONNECTED" },
    select: { id: true },
  });
  return created.id;
}

// â”€â”€ Guards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function getOwnedConversation(db: Db, workspaceId: string, conversationId: string) {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    include: { customer: { select: { id: true, name: true, phone: true } } },
  });
  if (!conversation || conversation.workspaceId !== workspaceId) {
    throw new NotFoundError("Conversation");
  }
  return conversation;
}

// â”€â”€ Listing / pagination / search (server-side) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  }
): Promise<
  Paginated<
    Prisma.ConversationGetPayload<{
      include: {
        customer: { select: { id: true; name: true; phone: true; status: true } };
        channel: { select: { type: true } };
        assignedAgent: { select: { id: true; name: true } };
      };
    }>
  >
> {
  const limit = Math.min(params.limit ?? 30, 100);
  const where: Prisma.ConversationWhereInput = { workspaceId: params.workspaceId };
  if (params.status) where.status = params.status;
  if (params.aiState) where.aiState = params.aiState;
  if (params.unreadOnly) where.unreadCount = { gt: 0 };

  if (params.q) {
    const matchingCustomers = await db.customer.findMany({
      where: {
        workspaceId: params.workspaceId,
        OR: [
          { name: { contains: params.q, mode: "insensitive" } },
          { phone: { contains: params.q } },
        ],
      },
      select: { id: true },
      take: 200,
    });
    where.OR = [
      { customerId: { in: matchingCustomers.map((c) => c.id) } },
      { messages: { some: { text: { contains: params.q, mode: "insensitive" } } } },
    ];
  }

  const conversations = await db.conversation.findMany({
    where,
    include: {
      customer: { select: { id: true, name: true, phone: true, status: true } },
      channel: { select: { type: true } },
      assignedAgent: { select: { id: true, name: true } },
    },
    orderBy: [{ lastCustomerMessageAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });

  const hasMore = conversations.length > limit;
  const items = hasMore ? conversations.slice(0, limit) : conversations;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

export async function getConversationDetail(db: Db, ctx: ActorContext, conversationId: string) {
  const conversation = await getOwnedConversation(db, ctx.workspaceId, conversationId);
  const orders = await db.order.findMany({
    where: { workspaceId: ctx.workspaceId, customerId: conversation.customerId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, orderNumber: true, status: true, total: true, currency: true, createdAt: true },
  });
  return { ...conversation, orders, aiSummary: conversation.summary ?? null };
}

export async function listMessages(
  db: Db,
  ctx: ActorContext,
  conversationId: string,
  params: { cursor?: string; limit?: number; before?: boolean }
) {
  await getOwnedConversation(db, ctx.workspaceId, conversationId);
  const limit = Math.min(params.limit ?? 50, 200);
  const messages = await db.message.findMany({
    where: { conversationId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });
  const hasMore = messages.length > limit;
  const items = hasMore ? messages.slice(0, limit) : messages;
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
}

// â”€â”€ Outbound (human replies; AI responses route through the same function) â”€â”€

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
      // unchanged â€” explicit takeover is the source of truth for AI gating.
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

// â”€â”€ Unread management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    data: { unreadCount: 1 },
  });
  return updated;
}

// â”€â”€ Assignment / takeover / release / status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  await getOwnedConversation(db, ctx.workspaceId, conversationId);

  const assignedAgentId = await defaultAssignToSelf(db, ctx, conversationId);
  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: {
      aiState: "HUMAN_ACTIVE",
      aiEnabled: false,
      assignedAgentId,
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
    data: { aiState: "AI_ACTIVE", aiEnabled: true },
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
