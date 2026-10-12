import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { deleteCatalog, getCatalogDetail, updateCatalog } from "@/modules/catalog/service";

const updateBody = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
});

export const GET = createHandler(
  { permission: "catalogs.read" },
  async ({ auth, params }) => {
    const { id } = params as { id: string };
    return ok(await getCatalogDetail(prisma, auth!.workspaceId, id));
  }
);

export const PATCH = createHandler(
  { body: updateBody, permission: "catalogs.write" },
  async ({ auth, body, params }) => {
    const { id } = params as { id: string };
    const catalog = await updateCatalog(prisma, auth!.workspaceId, id, body);
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "catalog.updated",
      entityType: "Catalog",
      entityId: id,
      metadata: { fields: Object.keys(body) },
    });
    return ok(catalog);
  }
);

export const DELETE = createHandler(
  { permission: "catalogs.write" },
  async ({ auth, params }) => {
    const { id } = params as { id: string };
    await deleteCatalog(prisma, auth!.workspaceId, id);
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "catalog.deleted",
      entityType: "Catalog",
      entityId: id,
    });
    return ok({ success: true });
  }
);
