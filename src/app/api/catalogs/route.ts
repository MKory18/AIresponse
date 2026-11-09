import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { catalogListQuerySchema } from "@/modules/catalog/schemas";
import { createCatalog, listCatalogs } from "@/modules/catalog/service";

const createBody = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
});

export const GET = createHandler(
  { query: catalogListQuerySchema, permission: "catalogs.read" },
  async ({ auth, query }) => {
    const catalogs = await listCatalogs(prisma, auth!.workspaceId, query);
    return ok({ catalogs });
  }
);

export const POST = createHandler(
  { body: createBody, permission: "catalogs.write" },
  async ({ auth, body }) => {
    const catalog = await createCatalog(prisma, auth!.workspaceId, body);
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "catalog.created",
      entityType: "Catalog",
      entityId: catalog.id,
      metadata: { name: catalog.name },
    });
    return ok(catalog, 201);
  }
);
