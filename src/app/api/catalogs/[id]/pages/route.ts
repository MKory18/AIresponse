import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { assignCatalogPage, unassignCatalogPage } from "@/modules/catalog/service";

const assignBody = z.object({
  channelId: z.string().cuid(),
});

const unassignBody = z.object({
  channelId: z.string().cuid(),
});

export const POST = createHandler(
  { body: assignBody, permission: "catalogs.assign" },
  async ({ auth, body, params }) => {
    const { id } = params as { id: string };
    const assignment = await assignCatalogPage(prisma, auth!.workspaceId, {
      catalogId: id,
      channelId: body.channelId,
      assignedBy: auth!.userId,
    });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "catalog.page_assigned",
      entityType: "Catalog",
      entityId: id,
      metadata: { channelId: body.channelId },
    });
    return ok(assignment, 201);
  }
);

export const DELETE = createHandler(
  { body: unassignBody, permission: "catalogs.assign" },
  async ({ auth, body }) => {
    await unassignCatalogPage(prisma, auth!.workspaceId, body.channelId);
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "catalog.page_unassigned",
      entityType: "Catalog",
      metadata: { channelId: body.channelId },
    });
    return ok({ success: true });
  }
);
