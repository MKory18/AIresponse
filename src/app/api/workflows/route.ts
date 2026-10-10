import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { workflowCreateSchema } from "@/modules/automation/workflow-schemas";
import { recordAudit } from "@/modules/audit/service";

export const GET = createHandler(
  { query: z.object({ status: z.enum(["DRAFT", "PUBLISHED", "PAUSED"]).optional() }).passthrough(), permission: "automation.read" },
  async ({ auth, query }) => {
    const where: Record<string, unknown> = { workspaceId: auth!.workspaceId };
    if (query.status) where.status = query.status;
    const items = await prisma.automation.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      include: {
        executions: { orderBy: { startedAt: "desc" }, take: 1 },
        _count: { select: { executions: true } },
      },
    });
    return ok({ items });
  }
);

/** Create a DRAFT workflow (never fires until published). */
export const POST = createHandler(
  { body: workflowCreateSchema, permission: "automation.write" },
  async ({ auth, body }) => {
    const wf = await prisma.automation.create({
      data: {
        workspaceId: auth!.workspaceId,
        name: body.name,
        description: body.description,
        trigger: body.definition.trigger,
        conditions: (body.definition.conditions ?? {}) as never,
        actions: body.definition.steps as never,
        priority: body.priority,
        isEnabled: false,
        status: "DRAFT",
        version: 1,
        createdBy: auth!.userId,
      } as never,
    });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "workflow.created",
      entityType: "Automation",
      entityId: wf.id,
      metadata: { trigger: body.definition.trigger },
    });
    return ok(wf, 201);
  }
);
