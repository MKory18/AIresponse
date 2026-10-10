import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { workflowUpdateSchema } from "@/modules/automation/workflow-schemas";
import { getOwnedWorkflow, publishWorkflow, pauseWorkflow, stopWorkflow, rollbackWorkflow } from "@/modules/automation/workflow-service";
import { recordAudit } from "@/modules/audit/service";

type Params = { id: string };

export const GET = createHandler(
  { permission: "automation.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const wf = await getOwnedWorkflow(prisma, auth!.workspaceId, id);
    const executions = await prisma.automationExecution.findMany({
      where: { automationId: id },
      orderBy: { startedAt: "desc" },
      take: 20,
      select: {
        id: true, triggerEventId: true, version: true, status: true,
        startedAt: true, completedAt: true, error: true, errorCategory: true,
        attempts: true, stepIndex: true, stepLog: true,
      },
    });
    return ok({ ...wf, executions });
  }
);

/** PATCH: draft edits (definition/name/description/priority). */
export const PATCH = createHandler(
  { body: workflowUpdateSchema, permission: "automation.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const wf = await getOwnedWorkflow(prisma, auth!.workspaceId, id);
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) data.description = body.description;
    if (body.priority !== undefined) data.priority = body.priority;
    if (body.definition !== undefined) {
      data.trigger = body.definition.trigger;
      data.conditions = (body.definition.conditions ?? {}) as never;
      data.actions = body.definition.steps as never;
    }
    const updated = await prisma.automation.update({ where: { id: wf.id }, data: data as never });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "workflow.updated",
      entityType: "Automation",
      entityId: id,
      metadata: { fields: Object.keys(body) },
    });
    return ok(updated);
  }
);

/** POST actions: publish / pause / stop / rollback. */
export const POST = createHandler(
  {
    body: z.object({
      action: z.enum(["publish", "pause", "stop", "rollback"]),
      definition: z.unknown().optional(),
      version: z.number().int().positive().optional(),
    }),
    permission: "automation.write",
  },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    switch (body.action) {
      case "publish":
        return ok(await publishWorkflow(prisma, auth!, id, body.definition as never));
      case "pause":
        return ok(await pauseWorkflow(prisma, auth!, id));
      case "stop":
        return ok(await stopWorkflow(prisma, auth!, id));
      case "rollback": {
        if (!body.version) {
          const { AppError } = await import("@/core/errors");
          throw new AppError("رقم الإصدار مطلوب للرجوع", 422, "VALIDATION_ERROR");
        }
        return ok(await rollbackWorkflow(prisma, auth!, id, body.version));
      }
    }
  }
);

export const DELETE = createHandler(
  { permission: "automation.write" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const wf = await getOwnedWorkflow(prisma, auth!.workspaceId, id);
    if (wf.status === "PUBLISHED" && wf.isEnabled) {
      const { AppError } = await import("@/core/errors");
      throw new AppError("أوقف سير العمل قبل حذفه", 422, "WORKFLOW_ACTIVE");
    }
    await prisma.automation.delete({ where: { id: wf.id } });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "workflow.deleted",
      entityType: "Automation",
      entityId: id,
    });
    return ok({ ok: true });
  }
);
