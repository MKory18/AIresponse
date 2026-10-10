import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getOwnedWorkflow } from "@/modules/automation/workflow-service";
import { evaluateConditionDetailed, evaluateConditionGroup } from "@/modules/automation/workflow-conditions";
import { validateTemplate } from "@/modules/automation/template";
import type { ConditionGroup, WorkflowDefinition, WorkflowStep } from "@/modules/automation/workflow-schemas";

type Params = { id: string };

/**
 * P7 — POST preview: DRY-RUN trace. Evaluates the workflow definition against
 * a SYNTHETIC sample context (operator-supplied, never real customer rows)
 * and returns a per-step plan with outcomes — WITHOUT executing anything:
 * no sends, no writes, no follow-ups, no order mutations, no AI calls.
 *
 * Distinguishable from real execution by construction: this route performs
 * zero writes (a test asserts it) and its output carries mode: "PREVIEW".
 */
const previewSchema = z.object({
  sample: z.object({
    conversationStatus: z.enum(["OPEN", "PENDING", "RESOLVED", "CLOSED"]).default("OPEN"),
    conversationAiState: z.enum(["AI_ACTIVE", "AI_PAUSED", "HUMAN_ACTIVE"]).default("AI_ACTIVE"),
    channelType: z.string().max(20).default("FACEBOOK"),
    tags: z.array(z.string().max(50)).max(20).default([]),
    isBlacklisted: z.boolean().default(false),
    customerStatus: z.string().max(30).default("NEW_LEAD"),
    orderStatus: z.string().max(30).optional(),
    orderTotal: z.number().optional(),
    minutesSinceLastCustomerMessage: z.number().optional(),
  }).default({}),
}).strict();

function buildSampleCtx(sample: z.infer<typeof previewSchema>["sample"]): Record<string, unknown> {
  return {
    conversation: {
      status: sample.conversationStatus,
      aiState: sample.conversationAiState,
      channelType: sample.channelType,
    },
    customer: { status: sample.customerStatus, isBlacklisted: sample.isBlacklisted, tags: sample.tags, tagList: sample.tags },
    order: sample.orderStatus !== undefined || sample.orderTotal !== undefined
      ? { status: sample.orderStatus ?? null, total: sample.orderTotal ?? null }
      : undefined,
    event: {
      minutesSinceLastCustomerMessage: sample.minutesSinceLastCustomerMessage ?? null,
      minutesSinceLastInbound: sample.minutesSinceLastCustomerMessage ?? null,
    },
  };
}

interface PreviewStep {
  stepId: string;
  type: string;
  outcome: "WOULD_RUN" | "WOULD_SKIP" | "WOULD_WAIT" | "BRANCH_TAKEN" | "BRANCH_SKIPPED" | "STOP";
  reason?: string;
}

function traceSteps(steps: WorkflowStep[], ctx: Record<string, unknown>, depth = 0): PreviewStep[] {
  const out: PreviewStep[] = [];
  for (const step of steps) {
    const a = step.action;
    if (out.length >= 25 || depth > 3) return out;
    switch (a.type) {
      case "BRANCH": {
        const taken = evaluateConditionDetailed(a.when, ctx);
        out.push({ stepId: step.id, type: a.type, outcome: taken.ok ? "BRANCH_TAKEN" : "BRANCH_SKIPPED", reason: taken.reason ?? "OK" });
        const list = (taken.ok ? a.then : a.else) ?? [];
        if (list.length) out.push(...traceSteps(list, ctx, depth + 1));
        break;
      }
      case "WAIT":
        out.push({ stepId: step.id, type: a.type, outcome: "WOULD_WAIT", reason: `minutes=${a.minutes}` });
        break;
      case "STOP_WORKFLOW":
        out.push({ stepId: step.id, type: a.type, outcome: "STOP" });
        return out;
      case "SEND_MESSAGE":
      case "CREATE_FOLLOW_UP": {
        const tpl = a.type === "SEND_MESSAGE" ? a.template : a.template;
        const v = validateTemplate(tpl);
        out.push({
          stepId: step.id, type: a.type,
          outcome: v.ok ? "WOULD_RUN" : "WOULD_SKIP",
          reason: v.ok ? undefined : v.error,
        });
        break;
      }
      default:
        out.push({ stepId: step.id, type: a.type, outcome: "WOULD_RUN" });
    }
  }
  return out;
}

export const POST = createHandler(
  { body: previewSchema, permission: "automation.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const wf = await getOwnedWorkflow(prisma, auth!.workspaceId, id);
    const def = {
      trigger: wf.trigger,
      conditions: wf.conditions,
      steps: wf.actions,
    } as unknown as WorkflowDefinition;
    const ctx = buildSampleCtx(body.sample);
    const gateOk = evaluateConditionGroup(def.conditions as ConditionGroup | undefined, ctx);
    const fail = gateOk ? undefined : evaluateConditionDetailed(def.conditions as ConditionGroup, ctx).reason;
    const steps = gateOk ? traceSteps(def.steps, ctx) : [];
    return ok({
      mode: "PREVIEW",
      note: "محاكاة فقط — لم يُنفَّذ أي إجراء حقيقي",
      workflow: { id: wf.id, name: wf.name, version: wf.version, status: wf.status },
      trigger: def.trigger,
      conditionsMet: gateOk,
      conditionsFailReason: fail,
      steps,
    });
  }
);
