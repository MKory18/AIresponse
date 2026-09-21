import { z } from "zod";

// ── Triggers (closed set — no arbitrary code execution) ────────────────────

export const AUTOMATION_TRIGGERS = [
  "ORDER_CREATED",
  "ORDER_CONFIRMED",
  "ORDER_CANCELLED",
  "ORDER_DELIVERED",
  "ORDER_RETURNED",
  "ORDER_FAILED",
  "CONVERSATION_CREATED",
  "CONVERSATION_IDLE",
  "HUMAN_TAKEOVER",
  "AI_HANDOFF",
  "CUSTOMER_CREATED",
  "CUSTOMER_UPDATED",
] as const;

export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];



// ── Conditions (typed evaluator — never eval) ──────────────────────────────

export const conditionOperatorSchema = z.enum([
  "EQ", "NEQ", "GT", "GTE", "LT", "LTE",
  "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "EXISTS", "NOT_EXISTS",
]);

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.object({
    field: z.string().trim().min(1).max(100),
    operator: conditionOperatorSchema,
    value: z.union([z.string().max(200), z.number(), z.boolean()]).nullish(),
    and: z.array(conditionSchema).max(10).optional(),
    or: z.array(conditionSchema).max(10).optional(),
  })
);

export interface Condition {
  field: string;
  operator: z.infer<typeof conditionOperatorSchema>;
  value?: string | number | boolean | null;
  and?: Condition[];
  or?: Condition[];
}

export const conditionGroupSchema = z.object({
  all: z.array(conditionSchema).max(10).optional(),
  any: z.array(conditionSchema).max(10).optional(),
});
export type ConditionGroup = z.infer<typeof conditionGroupSchema>;

// ── Actions ────────────────────────────────────────────────────────────────

export const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("SEND_MESSAGE"),
    template: z.string().min(1).max(1000),
  }),
  z.object({
    type: z.literal("CREATE_FOLLOW_UP"),
    template: z.string().min(1).max(1000),
    delayHours: z.number().min(0).max(24 * 30),
    followUpType: z.string().trim().max(50).default("GENERIC"),
  }),
  z.object({
    type: z.literal("ADD_TAG"),
    tag: z.string().trim().min(1).max(50),
  }),
  z.object({
    type: z.literal("REMOVE_TAG"),
    tag: z.string().trim().min(1).max(50),
  }),
  z.object({
    type: z.literal("ASSIGN_CONVERSATION"),
    agentId: z.string().cuid(),
  }),
  z.object({
    type: z.literal("CREATE_TASK"),
    title: z.string().trim().min(1).max(200),
  }),
  z.object({
    type: z.literal("CHANGE_AI_STATE"),
    aiState: z.enum(["AI_ACTIVE", "AI_PAUSED", "HUMAN_ACTIVE"]),
  }),
]);
export type AutomationAction = z.infer<typeof actionSchema>;

export const automationCreateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  conditions: conditionGroupSchema.optional(),
  actions: z.array(actionSchema).min(1).max(10),
  priority: z.number().int().min(0).max(100).default(0),
  isEnabled: z.boolean().default(true),
});

export const automationUpdateSchema = automationCreateSchema.partial();
