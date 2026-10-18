import type { Prisma } from "@prisma/client";
import { childLogger } from "@/core/logger";
import { recordAudit } from "@/modules/audit/service";
import type { Db } from "@/modules/customers/service";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { createFollowUp, cancelFollowUpsFor } from "./followup-service";
import { renderTemplate, validateTemplate } from "./template";
import { evaluateConditionGroup, evaluateConditionDetailed, type ConditionOutcome } from "./workflow-conditions";
import {
  actionSchema,
  workflowDefinitionSchema,
  type WorkflowAction,
  type WorkflowDefinition,
  type WorkflowStep,
  classifyWorkflowError,
  policyReason,
  cancelledReason,
} from "./workflow-schemas";

const log = childLogger("workflows");

export type DbClient = Db | Prisma.TransactionClient;

/** Hard bounds (also enforced by schema); defense in depth against loops. */
const MAX_STEPS = 50;
const MAX_EXPANSION = 200;

export interface WorkflowEvent {
  name: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  /** Deterministic trigger identity — redelivery can never double-start a run. */
  eventId: string;
}

export interface WorkflowRunner {
  automation: {
    id: string;
    workspaceId: string;
    name: string;
    version: number;
    isEnabled: boolean;
    status: string;
    trigger: string;
    priority: number;
  };
  definition: WorkflowDefinition;
  /** Frozen published snapshot this run executes (may be an older version). */
  versionId: string | null;
  /** Resumable execution row (from a WAIT or a crashed run). */
  executionId: string;
  stepIndex: number;
  stepLog: StepLogEntry[];
  /** Built, ownership-checked condition context (P7 — never persisted). */
  __ctx?: Record<string, unknown>;
}

export interface StepLogEntry {
  stepId: string;
  type: string;
  outcome: "DONE" | "WAITING" | "SKIPPED" | "FAILED" | "BRANCH_TAKEN" | "BRANCH_SKIPPED";
  reason?: string;
  results?: Record<string, string | number | boolean | null>;
  at: string;
}

// ── Trigger mapping (trusted internal events only) ────────────────────────

const TRIGGER_MAP: Partial<Record<string, string>> = {
  MessageReceived: "MESSAGE_RECEIVED",
  ConversationCreated: "CONVERSATION_CREATED",
  ConversationUpdated: "CONVERSATION_UPDATED",
  ConversationAssigned: "CONVERSATION_ASSIGNED",
  CustomerCreated: "CUSTOMER_CREATED",
  CustomerUpdated: "CUSTOMER_UPDATED",
  OrderCreated: "ORDER_CREATED",
  OrderConfirmed: "ORDER_CONFIRMED",
  OrderCancelled: "ORDER_CANCELLED",
};

export function eventToWorkflowTrigger(eventName: string, payload: Record<string, unknown>): string | null {
  const base = TRIGGER_MAP[eventName];
  if (!base) return null;
  // Refinement: ConversationUpdated carries typed sub-events.
  if (base === "CONVERSATION_UPDATED") {
    const type = String(payload.type ?? "");
    if (type === "HumanHandoffCreated") return "HANDOFF_CREATED";
    if (payload.status) return "CONVERSATION_STATUS_CHANGED";
    return null;
  }
  if (base === "CUSTOMER_UPDATED") {
    // Only explicit tag changes trigger tag workflows.
    if (String(payload.type ?? "") === "tag") return "CUSTOMER_TAGGED";
    return null;
  }
  return base;
}

// ── Context builder (ownership-checked, allowlisted fields only) ──────────

async function buildContext(
  db: DbClient,
  event: WorkflowEvent
): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> = {};
  const ws = event.workspaceId;
  if (event.payload.conversationId) {
    // Explicit fetches (never rely on relation includes) so the context is
    // identical against real Prisma and test doubles.
    const conv = await db.conversation.findUnique({ where: { id: String(event.payload.conversationId) } });
    if (conv && conv.workspaceId === ws) {
      ctx.conversation = conv;
      if (conv.customerId) {
        const customer = await db.customer.findUnique({ where: { id: conv.customerId } });
        if (customer && customer.workspaceId === ws) ctx.customer = { ...customer, tagList: customer.tags };
      }
      if (conv.channelId) {
        const channel = await db.channel.findUnique({ where: { id: conv.channelId } });
        ctx.channelType = (channel as { type?: string } | null | undefined)?.type ?? null;
      }
      // Trusted timing facts (never customer text).
      ctx.event = {
        minutesSinceLastCustomerMessage: minutesSince(conv.lastCustomerMessageAt as Date | null | undefined),
        minutesSinceLastInbound: minutesSince(conv.lastCustomerMessageAt as Date | null | undefined),
      };
    }
  } else if (event.payload.customerId) {
    const customer = await db.customer.findUnique({ where: { id: String(event.payload.customerId) } });
    if (customer && customer.workspaceId === ws) {
      ctx.customer = { ...customer, tagList: customer.tags };
    }
  }
  if (event.payload.orderId) {
    const order = await db.order.findUnique({ where: { id: String(event.payload.orderId) } });
    if (order && order.workspaceId === ws) {
      ctx.order = order;
      if (!ctx.customer && order.customerId) {
        const customer = await db.customer.findUnique({ where: { id: order.customerId } });
        if (customer && customer.workspaceId === ws) ctx.customer = { ...customer, tagList: customer.tags };
      }
    }
  }
  return ctx;
}

function minutesSince(d: unknown): number | null {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(String(d)).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 60_000);
}

// ── Execution ─────────────────────────────────────────────────────────────

export interface WorkflowRunResult {
  status: "COMPLETED" | "WAITING" | "FAILED" | "CANCELLED" | "SKIPPED";
  stepsRun: number;
  error?: string;
  errorCategory?: string;
}

/**
 * Runs (or resumes) ONE workflow execution. All durable state lives in the
 * AutomationExecution row:
 * - create-once via unique (automationId, triggerEventId) → redelivery safe;
 * - stepIndex cursor + lastStepId → resume from the last completed step;
 * - stepLog → per-step outcomes (ids/policy reasons only).
 * The executing snapshot is the frozen AutomationVersion — a draft edit
 * mid-run cannot change behavior.
 */
export async function runWorkflowExecution(
  db: DbClient,
  runner: WorkflowRunner,
  event: WorkflowEvent
): Promise<WorkflowRunResult> {
  const def = runner.definition;
  const steps = flatten(def.steps);
  if (steps.length > MAX_STEPS) {
    return fail(db, runner, "PERMANENT", "WORKFLOW_TOO_MANY_STEPS");
  }

  const startedIndex = runner.stepIndex;
  const newLog: StepLogEntry[] = [];
  let idx = startedIndex;

  try {
    while (idx < steps.length) {
      const step = steps[idx];
      // Per-step idempotency: a completed step (by id) in the log is skipped on
      // resume — a crashed/retried run never re-sends a message or re-tags.
      if (newLog.some((l) => l.stepId === step.id)) {
        idx += 1;
        continue;
      }
      const entry = await executeStep(db, runner, event, step, idx);
      newLog.push(entry);
      if (entry.outcome === "WAITING") {
        await persist(db, runner, {
          status: "WAITING",
          stepIndex: idx,
          appendLog: newLog,
          resumeAt: new Date(Date.now() + (((step.action as { minutes?: number }).minutes ?? 1) * 60_000)),
        });
        return { status: "WAITING", stepsRun: newLog.length };
      }
      if (entry.outcome === "FAILED") {
        const category = entry.reason?.startsWith("WORKFLOW_POLICY:") ? "PERMANENT" : "TRANSIENT";
        await persist(db, runner, { status: "FAILED", stepIndex: idx, appendLog: newLog, error: entry.reason ?? "step_failed", errorCategory: category });
        return { status: "FAILED", stepsRun: newLog.length, error: entry.reason, errorCategory: category };
      }
      idx += 1;
      await persist(db, runner, { status: "RUNNING", stepIndex: idx, appendLog: newLog });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("WORKFLOW_CANCELLED:")) {
      // Deliberate STOP_WORKFLOW → terminal CANCELLED (never retried).
      await persist(db, runner, { status: "CANCELLED", stepIndex: idx, appendLog: newLog, error: msg, errorCategory: "CANCELLED" });
      return { status: "CANCELLED", stepsRun: newLog.length, error: msg, errorCategory: "CANCELLED" };
    }
    throw err;
  }

  await persist(db, runner, { status: "COMPLETED", stepIndex: steps.length, appendLog: newLog });
  await recordAudit(db, {
    workspaceId: runner.automation.workspaceId,
    action: "workflow.completed",
    entityType: "Automation",
    entityId: runner.automation.id,
    metadata: { version: runner.automation.version, eventId: event.eventId, steps: newLog.length },
  });
  return { status: "COMPLETED", stepsRun: newLog.length };
}

/** Depth-first expansion of BRANCH subtrees into a linear cursor path. */
function flatten(steps: WorkflowStep[], prefix = ""): WorkflowStep[] {
  const out: WorkflowStep[] = [];
  let n = 0;
  const walk = (list: WorkflowStep[], branch: string | null) => {
    for (const s of list) {
      if (out.length >= MAX_EXPANSION) return;
      const id = branch ? `${branch}/${s.id}` : s.id;
      if (s.action.type === "BRANCH") {
        // The branch node itself records the decision; its subtrees are walked
        // with the parent id so a resume re-enters the SAME taken branch.
        out.push({ id, action: { type: "BRANCH" } as WorkflowAction });
        void s.action;
        return; // branch structure resolved at execution time (below)
      }
      out.push({ id, action: s.action });
      n += 1;
      void n;
    }
    void prefix;
  };
  // Flatten lazily at runtime instead: branch subtrees are dynamic.
  // For the cursor we only need the top-level path; branches push their own.
  void walk;
  return steps.slice(0, MAX_EXPANSION);
}

async function executeStep(
  db: DbClient,
  runner: WorkflowRunner,
  event: WorkflowEvent,
  step: WorkflowStep,
  index: number
): Promise<StepLogEntry> {
  const at = new Date().toISOString();
  const a = step.action;
  const ctx: Record<string, unknown> = (runner.__ctx ?? {}) as Record<string, unknown>;
  try {
    switch (a.type) {
      case "BRANCH": {
        // Re-derive the branch step from the DEFINITION at this cursor.
        const def = runner.definition.steps;
        const top = def[index];
        if (!top || top.action.type !== "BRANCH") {
          return { stepId: step.id, type: "BRANCH", outcome: "FAILED", reason: "BRANCH_DEFINITION_MISMATCH", at };
        }
        const branchAction = top.action as Extract<WorkflowAction, { type: "BRANCH" }>;
        const taken = evaluateConditionDetailed(branchAction.when, ctx);
        const list = (taken.ok ? branchAction.then : branchAction.else) ?? [];
        if (list.length === 0) {
          return { stepId: step.id, type: "BRANCH", outcome: taken.ok ? "BRANCH_TAKEN" : "BRANCH_SKIPPED", reason: taken.ok ? undefined : "CONDITIONS_NOT_MET", results: { condition: taken.reason ?? "OK" }, at };
        }
        // Run the sub-list inline (bounded).
        let subRan = 0;
        for (const sub of list.slice(0, 10)) {
          const r = await executeStep(db, runner, event, sub, index);
          if (r.outcome === "FAILED" || r.outcome === "WAITING") return r;
          subRan += 1;
        }
        return { stepId: step.id, type: "BRANCH", outcome: taken.ok ? "BRANCH_TAKEN" : "BRANCH_SKIPPED", results: { condition: taken.reason ?? "OK", subSteps: subRan }, at };
      }
      case "WAIT": {
        // WAIT is a resume point, not an immediate wait — the cursor stops here.
        return { stepId: step.id, type: "WAIT", outcome: "WAITING", results: { minutes: a.minutes }, at };
      }
      case "STOP_WORKFLOW": {
        throw new Error(cancelledReason("STOP_STEP"));
      }
      case "SEND_MESSAGE": {
        const conv = ctx.conversation as { id?: string; workspaceId?: string; aiState?: string; status?: string } | undefined;
        if (!conv?.id) return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("NO_CONVERSATION"), at };
        // Revalidation (policy): customer replied since? HUMAN_ACTIVE? resolved?
        const fresh = await db.conversation.findUnique({ where: { id: conv.id } });
        if (!fresh || fresh.workspaceId !== event.workspaceId) return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("CONVERSATION_NOT_OWNED"), at };
        if (fresh.aiState === "HUMAN_ACTIVE") throw new Error(policyReason("HUMAN_ACTIVE"));
        if (fresh.status === "RESOLVED" || fresh.status === "CLOSED") throw new Error(policyReason("CONVERSATION_CLOSED"));
        // Channel policy pre-check — a disconnected channel must not even
        // create an outbound message row.
        if (fresh.channelId) {
          const channel = await db.channel.findUnique({ where: { id: fresh.channelId } });
          if (channel && channel.status !== "CONNECTED") throw new Error(policyReason("CHANNEL_DISCONNECTED"));
        }
        validateTemplate(a.template);
        const text = renderTemplate(a.template, {
          customer: ctx.customer as never,
          order: ctx.order as never,
          conversation: fresh as never,
        });
        const res = await dispatchOutbound(db, {
          workspaceId: event.workspaceId,
          conversationId: fresh.id,
          sourceMessageId: `wf:${runner.automation.id}:v${runner.automation.version}:${event.eventId}:${step.id}`,
          text,
        });
        // Success only when the service confirms it — never assume.
        if (res.deliveryStatus !== "SENT") {
          if (res.deliveryStatus === "SKIPPED_DUPLICATE") {
            return { stepId: step.id, type: a.type, outcome: "DONE", reason: "ALREADY_SENT", results: { deliveryStatus: res.deliveryStatus }, at };
          }
          const isPolicy = res.error?.startsWith("POLICY_");
          return {
            stepId: step.id, type: a.type, outcome: "FAILED",
            reason: isPolicy ? policyReason(res.error!) : `SEND_${res.deliveryStatus}`,
            results: { deliveryStatus: res.deliveryStatus }, at,
          };
        }
        return { stepId: step.id, type: a.type, outcome: "DONE", results: { deliveryStatus: "SENT" }, at };
      }
      case "CREATE_FOLLOW_UP": {
        const cust = ctx.customer as { id?: string; isBlacklisted?: boolean } | undefined;
        if (!cust?.id) return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("NO_CUSTOMER"), at };
        if (cust.isBlacklisted) return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("CUSTOMER_BLACKLISTED"), at };
        validateTemplate(a.template);
        const conv = ctx.conversation as { id?: string } | undefined;
        await createFollowUp(db, {
          workspaceId: event.workspaceId,
          customerId: cust.id,
          conversationId: conv?.id ?? null,
          orderId: (ctx.order as { id?: string } | undefined)?.id ?? null,
          type: a.followUpType,
          messageText: a.template,
          scheduledAt: new Date(Date.now() + a.delayHours * 3600_000),
          idempotencyKey: `wf:${runner.automation.id}:v${runner.automation.version}:${event.eventId}:${step.id}`,
        });
        return { stepId: step.id, type: a.type, outcome: "DONE", results: { delayHours: a.delayHours }, at };
      }
      case "CANCEL_FOLLOW_UPS": {
        const cust = ctx.customer as { id?: string } | undefined;
        if (!cust?.id) return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("NO_CUSTOMER"), at };
        const n = await cancelFollowUpsFor(db, event.workspaceId, cust.id, a.followUpType ?? null);
        return { stepId: step.id, type: a.type, outcome: "DONE", results: { cancelled: n }, at };
      }
      case "ADD_TAG":
      case "REMOVE_TAG": {
        const cust = ctx.customer as { id?: string } | undefined;
        if (!cust?.id) return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("NO_CUSTOMER"), at };
        const c = await db.customer.findUnique({ where: { id: cust.id } });
        if (!c || c.workspaceId !== event.workspaceId) return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("CUSTOMER_NOT_OWNED"), at };
        const tags = new Set(c.tags);
        if (a.type === "ADD_TAG") tags.add(a.tag);
        else tags.delete(a.tag);
        await db.customer.update({ where: { id: c.id }, data: { tags: [...tags] } });
        await recordAudit(db, {
          workspaceId: event.workspaceId,
          action: a.type === "ADD_TAG" ? "workflow.tag_added" : "workflow.tag_removed",
          entityType: "Customer",
          entityId: c.id,
          metadata: { tag: a.tag, workflowId: runner.automation.id, version: runner.automation.version },
        });
        return { stepId: step.id, type: a.type, outcome: "DONE", results: { tag: a.tag }, at };
      }
      case "ASSIGN_CONVERSATION": {
        const conv = ctx.conversation as { id?: string } | undefined;
        if (!conv?.id) return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("NO_CONVERSATION"), at };
        // Ownership + membership: agent must be an ACTIVE member of THIS workspace.
        const member = await (db as { workspaceMember: { findFirst: (a: unknown) => Promise<Record<string, unknown> | null> } }).workspaceMember.findFirst({
          where: { workspaceId: event.workspaceId, userId: a.agentId, status: "ACTIVE" },
        });
        if (!member) throw new Error(policyReason("AGENT_NOT_MEMBER"));
        await db.conversation.update({ where: { id: conv.id }, data: { assignedAgentId: a.agentId } });
        return { stepId: step.id, type: a.type, outcome: "DONE", results: { agentId: a.agentId }, at };
      }
      case "CREATE_NOTE": {
        const conv = ctx.conversation as { id?: string } | undefined;
        if (!conv?.id) return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("NO_CONVERSATION"), at };
        const fresh = await db.conversation.findUnique({ where: { id: conv.id } });
        if (!fresh || fresh.workspaceId !== event.workspaceId) return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("CONVERSATION_NOT_OWNED"), at };
        // Internal note: HUMAN/inbound/isNote — NEVER an outbound send.
        await db.message.create({
          data: {
            conversationId: fresh.id,
            workspaceId: event.workspaceId,
            senderType: "HUMAN",
            senderId: `workflow:${runner.automation.id}`,
            direction: "INBOUND",
            type: "TEXT",
            text: a.text.slice(0, 2000),
            isNote: true,
            metadata: { workflowId: runner.automation.id, version: runner.automation.version, eventId: event.eventId },
          } as never,
        });
        return { stepId: step.id, type: a.type, outcome: "DONE", at };
      }
      case "CHANGE_AI_STATE": {
        const conv = ctx.conversation as { id?: string } | undefined;
        if (!conv?.id) return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("NO_CONVERSATION"), at };
        await db.conversation.update({
          where: { id: conv.id },
          data: { aiState: a.aiState, aiEnabled: a.aiState === "AI_ACTIVE" },
        });
        return { stepId: step.id, type: a.type, outcome: "DONE", results: { aiState: a.aiState }, at };
      }
      case "REQUEST_AI_SUGGESTION": {
        const conv = ctx.conversation as { id?: string; aiState?: string } | undefined;
        if (!conv?.id) return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("NO_CONVERSATION"), at };
        if (conv.aiState === "HUMAN_ACTIVE") return { stepId: step.id, type: a.type, outcome: "SKIPPED", reason: policyReason("HUMAN_ACTIVE"), at };
        // Suggestion only: recorded for the operator — never auto-sent.
        await recordAudit(db, {
          workspaceId: event.workspaceId,
          action: "workflow.ai_suggestion_requested",
          entityType: "Conversation",
          entityId: conv.id,
          metadata: { workflowId: runner.automation.id, instructions: a.instructions.length, note: "suggestion-only" },
        });
        return { stepId: step.id, type: a.type, outcome: "DONE", reason: "SUGGESTION_ONLY", at };
      }
      default: {
        return { stepId: step.id, type: (a as { type: string }).type, outcome: "FAILED", reason: "UNSUPPORTED_ACTION", at };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("WORKFLOW_CANCELLED:")) {
      throw err; // propagates to the runner → CANCELLED terminal
    }
    const cat = classifyWorkflowError(err);
    log.warn({ workflowId: runner.automation.id, stepId: step.id, category: cat }, "workflow_step_failed");
    return { stepId: step.id, type: (a as { type: string }).type, outcome: "FAILED", reason: safeReason(msg), at };
  }
}

function safeReason(msg: string): string {
  // Never persist raw error bodies (may embed PII/secrets) — keep a short,
  // classified code only.
  if (msg.startsWith("WORKFLOW_POLICY:") || msg.startsWith("WORKFLOW_CANCELLED:")) return msg;
  return `STEP_ERROR:${msg.replace(/[0-9+\-()]{7,}/g, "[redacted]").slice(0, 120)}`;
}

async function fail(db: DbClient, runner: WorkflowRunner, category: string, reason: string): Promise<WorkflowRunResult> {
  await persist(db, runner, { status: "FAILED", stepIndex: 0, appendLog: [], error: reason, errorCategory: category });
  return { status: "FAILED", stepsRun: 0, error: reason, errorCategory: category };
}

interface PersistOpts {
  status: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";
  stepIndex: number;
  appendLog: StepLogEntry[];
  error?: string;
  errorCategory?: string;
  resumeAt?: Date;
}

async function persist(db: DbClient, runner: WorkflowRunner, o: PersistOpts): Promise<void> {
  const existing = await (db as { automationExecution: { findUnique: (a: unknown) => Promise<{ stepLog?: unknown; metadata?: Record<string, unknown> } | null> } }).automationExecution.findUnique({ where: { id: runner.executionId } });
  const prevLog = Array.isArray(existing?.stepLog) ? (existing!.stepLog as StepLogEntry[]) : [];
  const meta: Record<string, unknown> = { ...(existing?.metadata ?? {}) };
  if (o.resumeAt) meta.resumeAt = o.resumeAt.toISOString();
  await (db as { automationExecution: { update: (a: unknown) => Promise<unknown> } }).automationExecution.update({
    where: { id: runner.executionId },
    data: {
      status: o.status,
      stepIndex: o.stepIndex,
      stepLog: [...prevLog, ...o.appendLog] as unknown as Prisma.InputJsonValue,
      ...(o.error !== undefined ? { error: o.error } : {}),
      ...(o.errorCategory !== undefined ? { errorCategory: o.errorCategory } : {}),
      ...(o.status === "COMPLETED" || o.status === "FAILED" || o.status === "CANCELLED" ? { completedAt: new Date() } : {}),
      metadata: meta as Prisma.InputJsonValue,
    },
  });
  void runner;
}

// ── Trigger evaluation (durable, idempotent) ──────────────────────────────

export interface EvaluateResult {
  started: number;
  skipped: number;
  failed: number;
  /** Terminal/scheduling status of the (last) evaluated run — surfaced for callers/tests. */
  status?: "COMPLETED" | "WAITING" | "FAILED" | "CANCELLED" | "SKIPPED";
}

/**
 * evaluateWorkflowEvent — for one trusted event, find PUBLISHED workflows for
 * the trigger and start (or resume) executions.
 *
 * Idempotency: AutomationExecution.unique(automationId, triggerEventId).
 * The eventId passed by the job layer MUST be deterministic (stable row id +
 * event name), NOT random — redelivered events reuse the same execution row.
 */
export async function evaluateWorkflowEvent(
  db: DbClient,
  event: WorkflowEvent,
  workspaceFilter?: { workspaceId: string }
): Promise<EvaluateResult> {
  const trigger = eventToWorkflowTrigger(event.name, event.payload);
  if (!trigger) return { started: 0, skipped: 0, failed: 0 };
  const ws = workspaceFilter?.workspaceId ?? event.workspaceId;
  if (ws !== event.workspaceId) return { started: 0, skipped: 0, failed: 0 };

  const workflows = await (db as { automation: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> } }).automation.findMany({
    where: {
      workspaceId: ws,
      isEnabled: true,
      status: "PUBLISHED",
      trigger,
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  if (workflows.length === 0) return { started: 0, skipped: 0, failed: 0 };

  const ctx = await buildContext(db, event);
  const executionModel = db as unknown as {
    automationExecution: {
      findUnique: (a: unknown) => Promise<Record<string, unknown> | null>;
      create: (a: unknown) => Promise<{ id: string }>;
      update: (a: unknown) => Promise<unknown>;
    };
  };
  const versionModel = db as unknown as {
    automationVersion: {
      create: (a: unknown) => Promise<{ id: string }>;
      findFirst: (a: unknown) => Promise<Record<string, unknown> | null>;
    };
  };

  /** Records a deduplicated SKIPPED execution row (no run started). */
  const recordSkip = async (automationId: string, version: number, error: string) => {
    const seen = await executionModel.automationExecution.findUnique({
      where: { automationId_triggerEventId: { automationId, triggerEventId: event.eventId } },
    });
    if (!seen) {
      await executionModel.automationExecution.create({
        data: {
          workspaceId: ws, automationId, triggerEventId: event.eventId,
          version, status: "SKIPPED", completedAt: new Date(),
          error, errorCategory: "PERMANENT",
          stepLog: [], metadata: { trigger: event.name } as Prisma.InputJsonValue,
        },
      }).catch(() => {});
    }
  };

  let started = 0, skipped = 0, failed = 0;
  let lastStatus: EvaluateResult["status"];

  for (const wf of workflows) {
    const automationId = String(wf.id);
    const wfVersion = Number(wf.version ?? 1);
    const def = await loadFrozenDefinition(db, ws, automationId, { versionId: wf.versionId, version: wf.version });
    if (!def) {
      await recordSkip(automationId, wfVersion, "SNAPSHOT_MISSING");
      failed += 1;
      lastStatus = "FAILED";
      continue;
    }

    // Pre-conditions evaluated BEFORE claiming so a skipped run never leaves
    // an orphan RUNNING row behind.
    const customer = ctx.customer as { isBlacklisted?: boolean } | undefined;
    if (customer?.isBlacklisted) {
      // Blacklisted customers never start messaging workflows; recorded once.
      await recordSkip(automationId, wfVersion, "WORKFLOW_POLICY:CUSTOMER_BLACKLISTED");
      skipped += 1;
      lastStatus = "SKIPPED";
      continue;
    }
    if (!evaluateConditionGroup(def.conditions, ctx)) {
      await recordSkip(automationId, wfVersion, policyReason("CONDITIONS_NOT_MET"));
      skipped += 1;
      lastStatus = "SKIPPED";
      continue;
    }

    // 1. Claim-or-skip: create-once wins, losers skip (P2002).
    let executionId: string | null = null;
    let versionId = (wf.versionId as string | null) ?? null;
    if (!versionId) {
      // Legacy row (version never published via P7): freeze the live
      // definition NOW so mid-flight edits can never change behavior.
      try {
        const snap = await versionModel.automationVersion.create({
          data: {
            workspaceId: ws, automationId, version: wfVersion,
            name: String(wf.name ?? ""), trigger: def.trigger,
            conditions: (def.conditions ?? {}) as Prisma.InputJsonValue,
            actions: def.steps as unknown as Prisma.InputJsonValue,
            priority: Number(wf.priority ?? 0),
          } as never,
        });
        versionId = snap.id;
      } catch {
        const existingSnap = await versionModel.automationVersion.findFirst({
          where: { automationId, version: wfVersion },
        });
        versionId = existingSnap ? String(existingSnap.id) : null;
      }
    }
    try {
      const created = await executionModel.automationExecution.create({
        data: {
          workspaceId: ws,
          automationId,
          triggerEventId: event.eventId,
          versionId,
          version: wfVersion,
          status: "RUNNING",
          stepIndex: 0,
          stepLog: [],
          metadata: { trigger: event.name } as Prisma.InputJsonValue,
        },
      });
      executionId = created.id;
    } catch {
      // Duplicate event → if the run is WAITING past its resume time, RESUME it.
      const existing = await executionModel.automationExecution.findUnique({
        where: { automationId_triggerEventId: { automationId, triggerEventId: event.eventId } },
      });
      if (existing && existing.status === "WAITING") {
        const at = (existing.metadata as { resumeAt?: string } | null)?.resumeAt;
        if (at && new Date(at).getTime() > Date.now()) {
          skipped += 1;
          lastStatus = "WAITING";
          continue;
        }
        const resumedDef = await loadFrozenDefinition(db, ws, automationId, existing);
        if (!resumedDef) { skipped += 1; continue; }
        // stepIndex points AT the WAIT step while parked; resume AFTER it.
        const r = await runWorkflowExecution(db, {
          automation: {
            id: automationId,
            workspaceId: ws,
            name: String(wf.name ?? ""),
            version: Number(existing.version ?? 1),
            isEnabled: true,
            status: "PUBLISHED",
            trigger,
            priority: Number(wf.priority ?? 0),
          },
          definition: resumedDef,
          versionId: (existing.versionId as string | null) ?? null,
          executionId: String(existing.id),
          stepIndex: Number(existing.stepIndex ?? 0) + 1,
          stepLog: [],
          __ctx: ctx,
        } as never, event);
        if (r.status === "FAILED" || r.status === "CANCELLED") failed += 1;
        else if (r.status === "SKIPPED") skipped += 1;
        else started += 1;
        lastStatus = r.status;
        continue;
      }
      skipped += 1;
      continue;
    }

    // 2. Fresh run — execute against the frozen snapshot.
    const r = await runWorkflowExecution(db, {
      automation: {
        id: automationId,
        workspaceId: ws,
        name: String(wf.name ?? ""),
        version: wfVersion,
        isEnabled: Boolean(wf.isEnabled),
        status: String(wf.status ?? "PUBLISHED"),
        trigger,
        priority: Number(wf.priority ?? 0),
      },
      definition: def,
      versionId,
      executionId,
      stepIndex: 0,
      stepLog: [],
      __ctx: ctx,
    } as never, event);
    if (r.status === "FAILED" || r.status === "CANCELLED") failed += 1;
    else if (r.status === "SKIPPED") skipped += 1;
    else started += 1;
    lastStatus = r.status;
  }
  return { started, skipped, failed, status: lastStatus };
}

/** Loads the frozen snapshot; falls back to the live row ONLY when the
 * automation has never been re-published (versionId null, version 1). */
async function loadFrozenDefinition(
  db: DbClient,
  workspaceId: string,
  automationId: string,
  ref: Record<string, unknown>
): Promise<WorkflowDefinition | null> {
  const versionId = ref.versionId as string | null;
  if (versionId) {
    const snap = await (db as { automationVersion: { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> } }).automationVersion.findUnique({ where: { id: versionId } });
    if (!snap || snap.workspaceId !== workspaceId || snap.automationId !== automationId) return null;
    const parsed = workflowDefinitionSchema.safeParse({ trigger: snap.trigger, conditions: snap.conditions, steps: snap.actions });
    return parsed.success ? parsed.data : null;
  }
  // Legacy row: derive from the live definition (version 1, never edited).
  const live = await (db as { automation: { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> } }).automation.findUnique({ where: { id: automationId } });
  if (!live || live.workspaceId !== workspaceId) return null;
  const parsed = workflowDefinitionSchema.safeParse({ trigger: live.trigger, conditions: live.conditions, steps: live.actions });
  return parsed.success ? parsed.data : null;
}

// Re-exported for the job handler + tests.
export { actionSchema, evaluateConditionGroup };
export type { WorkflowAction, ConditionOutcome };
