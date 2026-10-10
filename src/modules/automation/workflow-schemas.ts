import { z } from "zod";

/**
 * P7 — Workflow definition schemas (strict, closed-set, no arbitrary code).
 *
 * Every trigger/condition field/action type is an enum of registered,
 * implemented capabilities. Unknown fields are rejected by `.strict()` —
 * a stored payload can never smuggle unregistered behavior. No eval, no
 * stored JS: execution is a typed interpreter over these shapes only.
 */

export const WORKFLOW_TRIGGERS = [
  "MESSAGE_RECEIVED",
  "CONVERSATION_CREATED",
  "CONVERSATION_STATUS_CHANGED",
  "CONVERSATION_ASSIGNED",
  "HANDOFF_CREATED",
  "CUSTOMER_TAGGED",
  "ORDER_CONFIRMED",
  "ORDER_STATUS_CHANGED_FROM_OMS",
  "FOLLOW_UP_DUE",
  "CUSTOMER_CREATED",
  "ORDER_CREATED",
  "ORDER_CANCELLED",
] as const;

export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

/** Closed allowlist of trusted condition fields (never arbitrary DB paths). */
export const CONDITION_FIELDS = [
  "conversation.status",
  "conversation.aiState",
  "conversation.channelType",
  "conversation.priority",
  "conversation.assignedAgentId",
  "conversation.unreadCount",
  "customer.tags",
  "customer.status",
  "customer.isBlacklisted",
  "customer.leadScore",
  "order.status",
  "order.total",
  "order.omsStatus",
  "event.minutesSinceLastCustomerMessage",
  "event.minutesSinceLastInbound",
] as const;

export type ConditionField = (typeof CONDITION_FIELDS)[number];

const operatorSchema = z.enum([
  "EQ", "NEQ", "GT", "GTE", "LT", "LTE",
  "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN",
  "EXISTS", "NOT_EXISTS",
]);

export interface Condition {
  field: ConditionField;
  operator: z.infer<typeof operatorSchema>;
  value?: string | number | boolean | null;
  and?: Condition[];
  or?: Condition[];
}

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z
    .object({
      field: z.enum(CONDITION_FIELDS),
      operator: operatorSchema,
      value: z.union([z.string().max(200), z.number(), z.boolean()]).nullish(),
      and: z.array(conditionSchema).max(5).optional(),
      or: z.array(conditionSchema).max(5).optional(),
    })
    .strict()
);

export interface ConditionGroup {
  all?: Condition[];
  any?: Condition[];
}

export const conditionGroupSchema: z.ZodType<ConditionGroup> = z
  .object({
    all: z.array(conditionSchema).max(10).optional(),
    any: z.array(conditionSchema).max(10).optional(),
  })
  .strict();

// ── Actions (registered, closed set) ──────────────────────────────────────

export interface SendAction { type: "SEND_MESSAGE"; template: string }
export interface FollowUpAction { type: "CREATE_FOLLOW_UP"; template: string; delayHours: number; followUpType: string }
export interface CancelFollowUpsAction { type: "CANCEL_FOLLOW_UPS"; followUpType?: string }
export interface TagAction { type: "ADD_TAG" | "REMOVE_TAG"; tag: string }
export interface AssignAction { type: "ASSIGN_CONVERSATION"; agentId: string }
export interface SuggestAction { type: "REQUEST_AI_SUGGESTION"; instructions: string }
export interface NoteAction { type: "CREATE_NOTE"; text: string }
export interface AiStateAction { type: "CHANGE_AI_STATE"; aiState: "AI_ACTIVE" | "AI_PAUSED" }
export interface WaitAction { type: "WAIT"; minutes: number }
export interface BranchAction { type: "BRANCH"; when: ConditionGroup; then?: WorkflowStep[]; else?: WorkflowStep[] }
export interface StopAction { type: "STOP_WORKFLOW" }

export type WorkflowAction =
  | SendAction | FollowUpAction | CancelFollowUpsAction | TagAction | AssignAction
  | SuggestAction | NoteAction | AiStateAction | WaitAction | BranchAction | StopAction;

export interface WorkflowStep {
  id: string;
  action: WorkflowAction;
}

// Runtime parser — declared in dependency-safe order (steps recurse only
// through BRANCH bodies, which z.lazy handles without TS circularity).
interface StepInput { id: string; action: unknown }

const branchStepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.object({
    id: z.string().trim().min(1).max(40),
    action: z.object({
      type: z.literal("BRANCH"),
      when: conditionGroupSchema,
      then: z.array(baseStepSchema).max(10).optional(),
      else: z.array(baseStepSchema).max(10).optional(),
    }).strict(),
  })
);

const baseStepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.object({
    id: z.string().trim().min(1).max(40),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("SEND_MESSAGE"), template: z.string().min(1).max(1000) }).strict(),
      z.object({
        type: z.literal("CREATE_FOLLOW_UP"),
        template: z.string().min(1).max(1000),
        delayHours: z.number().min(0.01).max(24 * 30),
        followUpType: z.string().trim().max(50).default("GENERIC"),
      }).strict(),
      z.object({ type: z.literal("CANCEL_FOLLOW_UPS"), followUpType: z.string().trim().max(50).optional() }).strict(),
      z.object({ type: z.literal("ADD_TAG"), tag: z.string().trim().min(1).max(50) }).strict(),
      z.object({ type: z.literal("REMOVE_TAG"), tag: z.string().trim().min(1).max(50) }).strict(),
  z.object({ type: z.literal("ASSIGN_CONVERSATION"), agentId: z.string().trim().min(1).max(40) }).strict(),
  z.object({ type: z.literal("REQUEST_AI_SUGGESTION"), instructions: z.string().max(500) }).strict(),
  z.object({ type: z.literal("CREATE_NOTE"), text: z.string().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("CHANGE_AI_STATE"), aiState: z.enum(["AI_ACTIVE", "AI_PAUSED"]) }).strict(),
  z.object({ type: z.literal("WAIT"), minutes: z.number().int().min(1).max(60 * 24 * 30) }).strict(),
  z.object({
    type: z.literal("BRANCH"),
    when: conditionGroupSchema,
    then: z.array(baseStepSchema).max(10).optional(),
    else: z.array(baseStepSchema).max(10).optional(),
  }).strict(),
  z.object({ type: z.literal("STOP_WORKFLOW") }).strict(),
    ]),
  }).strict()
) as unknown as z.ZodType<WorkflowStep>;

void branchStepSchema;

export const stepSchema = baseStepSchema;

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SEND_MESSAGE"), template: z.string().min(1).max(1000) }).strict(),
  z.object({
    type: z.literal("CREATE_FOLLOW_UP"),
    template: z.string().min(1).max(1000),
    delayHours: z.number().min(0.01).max(24 * 30),
    followUpType: z.string().trim().max(50).default("GENERIC"),
  }).strict(),
  z.object({ type: z.literal("CANCEL_FOLLOW_UPS"), followUpType: z.string().trim().max(50).optional() }).strict(),
  z.object({ type: z.literal("ADD_TAG"), tag: z.string().trim().min(1).max(50) }).strict(),
  z.object({ type: z.literal("REMOVE_TAG"), tag: z.string().trim().min(1).max(50) }).strict(),
  z.object({ type: z.literal("ASSIGN_CONVERSATION"), agentId: z.string().trim().min(1).max(40) }).strict(),
  z.object({ type: z.literal("REQUEST_AI_SUGGESTION"), instructions: z.string().max(500) }).strict(),
  z.object({ type: z.literal("CREATE_NOTE"), text: z.string().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("CHANGE_AI_STATE"), aiState: z.enum(["AI_ACTIVE", "AI_PAUSED"]) }).strict(),
  z.object({ type: z.literal("WAIT"), minutes: z.number().int().min(1).max(60 * 24 * 30) }).strict(),
  z.object({
    type: z.literal("BRANCH"),
    when: conditionGroupSchema,
    then: z.array(stepSchema).max(10).optional(),
    else: z.array(stepSchema).max(10).optional(),
  }).strict(),
  z.object({ type: z.literal("STOP_WORKFLOW") }).strict(),
]);

export const workflowDefinitionSchema: z.ZodType<
  { trigger: WorkflowTrigger; conditions?: ConditionGroup; steps: WorkflowStep[] },
  z.ZodTypeDef,
  unknown
> = z
  .object({
    trigger: z.enum(WORKFLOW_TRIGGERS),
    conditions: conditionGroupSchema.optional(),
    steps: z.array(baseStepSchema).min(1).max(20),
  })
  .strict() as never;

export type WorkflowDefinition = { trigger: WorkflowTrigger; conditions?: ConditionGroup; steps: WorkflowStep[] };

export const workflowCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).optional(),
    definition: workflowDefinitionSchema,
    priority: z.number().int().min(0).max(100).default(0),
  })
  .strict();

export const workflowUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    definition: workflowDefinitionSchema.optional(),
    priority: z.number().int().min(0).max(100).optional(),
  })
  .strict();

/** Failure classes — transient retries with backoff; permanent fail fast. */
export type WorkflowErrorCategory = "TRANSIENT" | "PERMANENT" | "CANCELLED";

export function classifyWorkflowError(err: unknown): WorkflowErrorCategory {
  const msg = err instanceof Error ? err.message : String(err);
  if (/^WORKFLOW_POLICY:/.test(msg)) return "PERMANENT";
  if (/^WORKFLOW_CANCELLED:/.test(msg)) return "CANCELLED";
  return "TRANSIENT";
}

/** Safe reason for step logs — ids and policy codes only. */
export function policyReason(reason: string): string {
  return `WORKFLOW_POLICY:${reason}`;
}

export function cancelledReason(reason: string): string {
  return `WORKFLOW_CANCELLED:${reason}`;
}

// Local input typing used by the runtime parser plumbing above.
declare module "./workflow-schemas" {}
export type { StepInput };
