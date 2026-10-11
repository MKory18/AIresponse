import type { Prisma, ChannelType, MessageType, ConversationStatus } from "@prisma/client";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import { resolveCustomerByChannelIdentity, type Db } from "@/modules/customers/service";
import { childLogger } from "@/core/logger";

// ---- Incoming pipeline (AI hooks in Phase 4 at the documented point) ----

export interface IncomingMessageInput {
  workspaceId: string;
  channelType: ChannelType;
  /** Exact channel (page) the message arrived on — from webhook routing. */
  channelId?: string;
  externalUserId: string;
  externalUserName?: string | null;
  externalAvatarUrl?: string | null;
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
 * processIncomingMessage — single entry point of the message pipeline:
 *
 * Normalize (caller/adapter) → resolve customer (ChannelIdentity) →
 * ensure conversation → idempotency check → persist message →
 * update conversation state (unread, timestamps, reopen) → emit events.
 *
 * AI processing is deliberately NOT here: Phase 4 subscribes to
 * `MessageReceived` / enqueues a job — no redesign of this function needed.
 *
 * P1: moved verbatim from service.ts (no logic change).
 */
export async function processIncomingMessage(db: Db, input: IncomingMessageInput): Promise<ProcessedIncoming> {
  // P12: الإحالة تُقرأ من الخام مرة وحدة، وكل ما يُخزَّن (هوية القناة ونص
  // الرسالة) بلا ctwa_clid — رمز النقرة يُحفظ مشفّرًا بلمسة الإسناد فقط.
  const { parseReferral, safeReferralForStorage } = await import("@/modules/integrations/inbound-hooks");
  const referral = parseReferral(input.metadata);
  const storedMetadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
  if ("referral" in storedMetadata) {
    const safe = safeReferralForStorage(storedMetadata.referral);
    if (safe) storedMetadata.referral = safe;
    else delete storedMetadata.referral;
  }

  const { customerId, created: customerCreated } = await resolveCustomerByChannelIdentity(db, {
    workspaceId: input.workspaceId,
    channelType: input.channelType,
    externalUserId: input.externalUserId,
    displayName: input.externalUserName,
    avatarUrl: input.externalAvatarUrl,
    metadata: input.metadata ? storedMetadata : input.metadata,
  });

  // P8 — مصدر الإعلان: يُلتقط مرة واحدة فقط من إحالة موثوقة صريحة قادمة
  // مع الرسالة (metadata.adRef)؛ غيابها = غير معروف، ولا يُستبدل المصدر
  // الأصلي أبدًا (حماية من إعادة إرسال الـ Webhook). الفشل لا يوقف المسار.
  if (input.metadata && typeof input.metadata.adRef === "string" && input.metadata.adRef) {
    const { recordAdSource } = await import("@/modules/sales/ad-source");
    await recordAdSource(db, { workspaceId: input.workspaceId, customerId, source: input.metadata.adRef }).catch(() => {});
  }

  let conversation = await db.conversation.findUnique({
    where: {
      workspaceId_channelConversationId: {
        workspaceId: input.workspaceId,
        channelConversationId: input.externalConversationId,
      },
    },
  });

  let conversationCreated = false;
  // A soft-deleted thread never resurfaces via polling — but a brand-new
  // inbound message from the same customer reopens it (history preserved).
  if (conversation && (conversation as { deletedAt?: Date | null }).deletedAt) {
    conversation = await db.conversation.update({
      where: { id: conversation.id },
      data: { deletedAt: null, deletedBy: null, status: "OPEN" as ConversationStatus, unreadCount: 0 },
    });
    await recordAudit(db, {
      workspaceId: input.workspaceId,
      userId: null,
      action: "conversation.restored",
      entityType: "Conversation",
      entityId: conversation.id,
    });
  }
  // Heal stale page mapping: conversations created before per-page routing
  // (or via the generic fallback) are re-attached to the exact channel the
  // webhook resolved — so replies use the right page token and the UI badge
  // shows the right page. Audited, workspace-scoped.
  if (conversation && input.channelId && conversation.channelId !== input.channelId) {
    const target = await db.channel.findFirst({
      where: { id: input.channelId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (target) {
      conversation = await db.conversation.update({
        where: { id: conversation.id },
        data: { channelId: target.id },
      });
      await recordAudit(db, {
        workspaceId: input.workspaceId,
        userId: null,
        action: "conversation.channel_healed",
        entityType: "Conversation",
        entityId: conversation.id,
        metadata: { channelId: target.id },
      });
    }
  }
  if (!conversation) {
    try {
      conversation = await db.conversation.create({
        data: {
          workspaceId: input.workspaceId,
          customerId,
          // Prefer the exact channel (page) resolved by webhook routing, so the
          // reply later uses the right page token and the UI shows the right page.
          // Fallback keeps single-page workspaces working unchanged.
          channelId: input.channelId ?? (await ensureChannelId(db, input.workspaceId, input.channelType)),
          channelConversationId: input.externalConversationId,
        },
      });
      conversationCreated = true;
    } catch (err) {
      // Concurrent first-message race: two deliveries both saw findUnique=null
      // and both tried create — the unique(workspaceId, channelConversationId)
      // winner owns the thread; re-read and continue on it (never 500).
      if ((err as { code?: string }).code !== "P2002") throw err;
      const winner = await db.conversation.findUnique({
        where: {
          workspaceId_channelConversationId: {
            workspaceId: input.workspaceId,
            channelConversationId: input.externalConversationId,
          },
        },
      });
      if (!winner) throw err;
      conversation = winner;
    }
    if (conversationCreated) {
      await eventBus.publish(
        makeEvent("ConversationCreated", input.workspaceId, {
          conversationId: conversation.id,
          customerId,
          channelType: input.channelType,
        })
      );
    }
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
        metadata: storedMetadata as Prisma.InputJsonValue,
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

  // P12 — الإسناد (إعلان/رمز) وإلغاء الاشتراك بكلمة صريحة — بعد الحفظ،
  // ولا يوقف الرسالة أبدًا (الفشل يُسجّل فقط).
  try {
    const { onInboundCustomerMessage } = await import("@/modules/integrations/inbound-hooks");
    await onInboundCustomerMessage(db, {
      workspaceId: input.workspaceId,
      customerId,
      conversationId: conversation.id,
      channelType: input.channelType,
      messageId: message.id,
      externalEventId: input.externalEventId,
      externalUserId: input.externalUserId,
      text: input.text ?? null,
      referral,
      occurredAt: now,
    });
  } catch (err) {
    childLogger("pipeline").error({ err }, "integration_inbound_hook_failed");
  }

  const payload = {
    conversationId: conversation.id,
    messageId: message.id,
    customerId,
    channelType: input.channelType,
  } as Record<string, unknown>;
  // P7: deterministic trigger id — workflow/automation bridges key idempotency
  // on it, so webhook redelivery can never double-fire a workflow.
  payload.eventId = `MessageReceived:${message.id}`;
  // Durability anchor: every accepted inbound is logged with ids only, so an
  // operator can always answer "where is this message right now".
  childLogger("pipeline").info(
    {
      conversationId: conversation.id,
      messageId: message.id,
      customerId,
      channelType: input.channelType,
      duplicate: false,
    },
    "inbound_message_received"
  );
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
        // Deterministic active-job idempotency (partial unique index):
        // webhook redelivery or a sweeper race can never create two ACTIVE
        // AI jobs for the same inbound message.
        idempotencyKey: `ai:${message.id}`,
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
  try {
    const created = await db.channel.create({
      data: { workspaceId, type: channelType, displayName: `${channelType} (auto)`, status: "CONNECTED" },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    // Concurrent first-contact race (P5 gate): the partial unique index on
    // (workspaceId, type) WHERE externalId IS NULL makes the loser fail with
    // P2002 — re-read the winner instead of 500ing the webhook.
    if ((err as { code?: string }).code !== "P2002") throw err;
    const winner = await db.channel.findFirst({
      where: { workspaceId, type: channelType },
      select: { id: true },
    });
    if (!winner) throw err;
    return winner.id;
  }
}
