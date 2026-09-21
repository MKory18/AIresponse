import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { automationCreateSchema } from "@/modules/automation/schemas";
import { recordAudit } from "@/modules/audit/service";

export const GET = createHandler(
  { query: z.object({}).passthrough(), permission: "automation.read" },
  async ({ auth }) => {
    const automations = await prisma.automation.findMany({
      where: { workspaceId: auth!.workspaceId },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      include: { executions: { orderBy: { startedAt: "desc" }, take: 1 } },
    });
    return ok({ items: automations });
  }
);

export const POST = createHandler(
  { body: automationCreateSchema, permission: "automation.write" },
  async ({ auth, body }) => {
    const automation = await prisma.automation.create({
      data: { ...body, workspaceId: auth!.workspaceId, createdBy: auth!.userId } as never,
    });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "automation.created",
      entityType: "Automation",
      entityId: automation.id,
    });
    return ok(automation, 201);
  }
);
