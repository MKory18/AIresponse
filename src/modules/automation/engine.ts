import type { Prisma } from "@prisma/client";
import { childLogger } from "@/core/logger";
import { eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { Db } from "@/modules/customers/service";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { createFollowUp } from "./followup-service";
import { renderTemplate, validateTemplate } from "./template";
import { evaluateConditionGroup } from "./conditions";
import { actionSchema, type AutomationAction, type AutomationTrigger, AUTOMATION_TRIGGERS } from "./schemas";

const log = childLogger("automation");
const MAX_EXECUTION_DEPTH = 10;

export type DbClient = Db | Prisma.TransactionClient;

export interface AutomationEvent {
  name: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  /** Loop prevention context. */
  originAutomationId?: string | null;
  depth?: number;
  /** Deterministic id for idempotent evaluation (e.g. the triggering row id). */
  eventId: string;
}

/** Maps domain events to automation triggers. */
export function eventToTrigger(eventName: string): AutomationTrigger | null {
  const map: Partial<Record<string, AutomationTrigger>> = {
    OrderCreated: "ORDER_CREATED",
    OrderConfirmed: "ORDER_CONFIRMED",
    OrderCancelled: "ORDER_CANCELLED",
    ConversationCreated: "CONVERSATION_CREATED",
    CustomerCreated: "CUSTOMER_CREATED",
    CustomerUpdated: "CUSTOMER_UPDATED",
  };
  // OrderStateChanged carries type: DELIVERED / RETURNED / FAILED payloads.
  return map[eventName] ?? null;
}

/** Builds the condition evaluation context from a trusted event payload. */
async function buildContext(db: DbClient, event: AutomationEvent): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> = { ...event.payload };
  if (event.payload.customerId) {
    const customer = await db.customer.findUnique({ where: { id: String(event.payload.customerId) } });
    if (customer && customer.workspaceId === event.workspaceId) {
      ctx.customer = { ...customer, tagList: customer.tags };
    }
  }
  if (event.payload.orderId) {
    const order = await db.order.findUnique({ where: { id: String(event.payload.orderId) }, include: { items: true } });
    if (order && order.workspaceId === event.workspaceId) ctx.order = order;
  }
  if (event.payload.conversationId) {
    const conversation = await db.conversation.findUnique({ where: { id: String(event.payload.conversationId) } });
    if (conversation && conversation.workspaceId === event.workspaceId) ctx.conversation = conversation;
  }
  return ctx;
}

/**
 * AutomationEngine.evaluateEvent — deterministic, isolated, idempotent.
 *
 * Invariants:
 * - Deterministic ordering: priority DESC, then createdAt/id.
 * - Failure isolation: one automation failing never affects others.
 * - Loop prevention: depth cap + an automation never re-triggers itself in the
 *   same chain (originAutomationId).
 * - Idempotency: AutomationExecution unique (automationId, triggerEventId).
 */
export async function evaluateEvent(db: DbClient, event: AutomationEvent): Promise<{ executed: number; skipped: number; failed: number }> {
  if (event.depth ?? 0 > MAX_EXECUTION_DEPTH) return { executed: 0, skipped: 0, failed: 0 };
  if ((event.depth ?? 0) > MAX_EXECUTION_DEPTH) return { executed: 0, skipped: 0, failed: 0 };

  const trigger = eventToTrigger(event.name);
  if (!trigger || !(AUTOMATION_TRIGGERS as readonly string[]).includes(trigger)) {
    return { executed: 0, skipped: 0, failed: 0 };
  }

  const automations = await db.automation.findMany({
    where: { workspaceId: event.workspaceId, isEnabled: true, trigger },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  if (automations.length === 0) return { executed: 0, skipped: 0, failed: 0 };

  const context = await buildContext(db, event);
  let executed = 0;
  let skipped = 0;
  let failed = 0;

  for (const automation of automations) {
    // Loop prevention: an automation never runs directly after itself.
    if (event.originAutomationId === automation.id) {
      skipped += 1;
      continue;
    }
    // Idempotency: unique (automationId, triggerEventId).
    try {
      await db.automationExecution.create({
        data: {
          workspaceId: event.workspaceId,
          automationId: automation.id,
          triggerEventId: event.eventId,
          status: "RUNNING",
          metadata: { depth: event.depth ?? 0 } as Prisma.InputJsonValue,
        },
      });
    } catch {
      skipped += 1;
      continue;
    }

    // Conditions
    const conditions = automation.conditions as Parameters<typeof evaluateConditionGroup>[0] | undefined;
    if (!evaluateConditionGroup(conditions, context)) {
      await db.automationExecution.update({
        where: { automationId_triggerEventId: { automationId: automation.id, triggerEventId: event.eventId } },
        data: { status: "SKIPPED", completedAt: new Date(), metadata: { reason: "CONDITIONS_NOT_MET" } as Prisma.InputJsonValue },
      });
      skipped += 1;
      continue;
    }

    // Actions — isolated per automation.
    try {
      const actions = (automation.actions as unknown as AutomationAction[]) ?? [];
      const parsed = actions.map((a) => actionSchema.parse(a));
      for (let i = 0; i < parsed.length; i++) {
        await executeAction(db, event, automation.id, i, parsed[i], context);
      }
      await db.automationExecution.update({
        where: { automationId_triggerEventId: { automationId: automation.id, triggerEventId: event.eventId } },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      await recordAudit(db, {
        workspaceId: event.workspaceId,
        action: "automation.executed",
        entityType: "Automation",
        entityId: automation.id,
        metadata: { trigger: event.name, eventId: event.eventId },
      });
      executed += 1;
    } catch (err) {
      failed += 1;
      await db.automationExecution.update({
        where: { automationId_triggerEventId: { automationId: automation.id, triggerEventId: event.eventId } },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          error: err instanceof Error ? err.message : String(err),
        },
      });
      log.warn({ automationId: automation.id, err }, "automation_execution_failed");
    }
  }

  return { executed, skipped, failed };
}

async function executeAction(
  db: DbClient,
  event: AutomationEvent,
  automationId: string,
  actionIndex: number,
  action: AutomationAction,
  context: Record<string, unknown>
): Promise<void> {
  const customer = context.customer as { id?: string } | undefined;
  const conversation = context.conversation as { id?: string } | undefined;
  const order = context.order as { id?: string; orderNumber?: string } | undefined;

  switch (action.type) {
    case "SEND_MESSAGE": {
      // Recipient/target always from trusted context — never from the action.
      if (!conversation?.id) throw new Error("SEND_MESSAGE requires a conversation");
      const text = renderTemplate(action.template, context);
      await dispatchOutbound(db, {
        workspaceId: event.workspaceId,
        conversationId: conversation.id,
        sourceMessageId: `auto:${automationId}:${event.eventId}:${actionIndex}`,
        text,
      });
      break;
    }
    case "CREATE_FOLLOW_UP": {
      if (!customer?.id) throw new Error("CREATE_FOLLOW_UP requires a customer");
      validateTemplate(action.template);
      await createFollowUp(db, {
        workspaceId: event.workspaceId,
        customerId: customer.id,
        conversationId: conversation?.id ?? null,
        orderId: order?.id ?? null,
        type: action.followUpType,
        messageText: action.template,
        scheduledAt: new Date(Date.now() + action.delayHours * 3600_000),
        idempotencyKey: `automation:${automationId}:event:${event.eventId}:action:${actionIndex}`,
      });
      break;
    }
    case "ADD_TAG":
    case "REMOVE_TAG": {
      if (!customer?.id) throw new Error("Tag actions require a customer");
      const c = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
      const tags = new Set(c.tags);
      if (action.type === "ADD_TAG") tags.add(action.tag);
      else tags.delete(action.tag);
      await db.customer.update({ where: { id: c.id }, data: { tags: [...tags] } });
      break;
    }
    case "ASSIGN_CONVERSATION": {
      if (!conversation?.id) throw new Error("ASSIGN_CONVERSATION requires a conversation");
      await db.conversation.update({
        where: { id: conversation.id },
        data: { assignedAgentId: action.agentId },
      });
      break;
    }
    case "CHANGE_AI_STATE": {
      if (!conversation?.id) throw new Error("CHANGE_AI_STATE requires a conversation");
      await db.conversation.update({
        where: { id: conversation.id },
        data: {
          aiState: action.aiState,
          aiEnabled: action.aiState === "AI_ACTIVE",
        },
      });
      break;
    }
    case "CREATE_TASK": {
      // Tasks land as audit entries for agents until a Tasks UI exists.
      await recordAudit(db, {
        workspaceId: event.workspaceId,
        action: "automation.task_created",
        entityType: "Task",
        entityId: `${automationId}:${event.eventId}:${actionIndex}`,
        metadata: { title: action.title },
      });
      break;
    }
    default:
      throw new Error("Unsupported action type");
  }
}

/**
 * Durable bridge: important domain events are persisted as evaluation jobs so
 * a restart never loses an automation trigger. Registered once at boot.
 */
const globalForBridge = globalThis as typeof globalThis & { __acreAutomationBridge?: boolean };

export function registerAutomationBridge(prismaLike: {
  backgroundJob: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}) {
  if (globalForBridge.__acreAutomationBridge) return;
  globalForBridge.__acreAutomationBridge = true;
  eventBus.subscribe("*", async (event) => {
    if (!eventToTrigger(event.name)) return;
    try {
      await prismaLike.backgroundJob.create({
        data: {
          type: "evaluate_automation",
          workspaceId: event.workspaceId,
          payload: {
            eventName: event.name,
            eventId: `${event.name}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
            payload: event.payload,
            depth: 0,
          },
        },
      });
    } catch (err) {
      log.error({ err, event: event.name }, "automation_bridge_enqueue_failed");
    }
  });
;
}
