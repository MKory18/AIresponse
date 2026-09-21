import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { automationUpdateSchema } from "@/modules/automation/schemas";
import { recordAudit } from "@/modules/audit/service";
import { NotFoundError } from "@/core/errors";

type Params = { id: string };

async function getOwned(id: string, workspaceId: string) {
  const automation = await prisma.automation.findUnique({ where: { id } });
  if (!automation || automation.workspaceId !== workspaceId) throw new NotFoundError("Automation");
  return automation;
}

export const GET = createHandler(
  { permission: "automation.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const automation = await getOwned(id, auth!.workspaceId);
    const executions = await prisma.automationExecution.findMany({
      where: { automationId: id },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
    return ok({ ...automation, executions });
  }
);

export const PATCH = createHandler(
  { body: automationUpdateSchema, permission: "automation.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    await getOwned(id, auth!.workspaceId);
    const updated = await prisma.automation.update({ where: { id }, data: body as never });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "automation.updated",
      entityType: "Automation",
      entityId: id,
    });
    return ok(updated);
  }
);

export const DELETE = createHandler(
  { permission: "automation.write" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    await getOwned(id, auth!.workspaceId);
    await prisma.automation.delete({ where: { id } });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "automation.deleted",
      entityType: "Automation",
      entityId: id,
    });
    return ok({ ok: true });
  }
);

/** enable/disable/duplicate via POST */
export const POST = createHandler(
  {
    body: z.object({ action: z.enum(["enable", "disable", "duplicate"]) }),
    permission: "automation.write",
  },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const automation = await getOwned(id, auth!.workspaceId);
    if (body.action === "duplicate") {
      const copy = await prisma.automation.create({
        data: {
          workspaceId: auth!.workspaceId,
          name: `${automation.name} (نسخة)`,
          description: automation.description,
          trigger: automation.trigger,
          conditions: automation.conditions,
          actions: automation.actions,
          priority: automation.priority,
          isEnabled: false,
          createdBy: auth!.userId,
        } as never,
      });
      return ok(copy, 201);
    }
    const updated = await prisma.automation.update({
      where: { id },
      data: { isEnabled: body.action === "enable" },
    });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: body.action === "enable" ? "automation.enabled" : "automation.disabled",
      entityType: "Automation",
      entityId: id,
    });
    return ok(updated);
  }
);
