import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { addCatalogProducts, removeCatalogProduct } from "@/modules/catalog/service";

const addBody = z.object({
  productIds: z.array(z.string().cuid()).min(1).max(100),
});

const removeBody = z.object({
  productId: z.string().cuid(),
});

export const POST = createHandler(
  { body: addBody, permission: "catalogs.write" },
  async ({ auth, body, params }) => {
    const { id } = params as { id: string };
    const result = await addCatalogProducts(prisma, auth!.workspaceId, id, body.productIds);
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "catalog.products_added",
      entityType: "Catalog",
      entityId: id,
      metadata: { added: result.added, skipped: result.skipped },
    });
    return ok(result, 201);
  }
);

export const DELETE = createHandler(
  { body: removeBody, permission: "catalogs.write" },
  async ({ auth, body, params }) => {
    const { id } = params as { id: string };
    await removeCatalogProduct(prisma, auth!.workspaceId, id, body.productId);
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "catalog.product_removed",
      entityType: "Catalog",
      entityId: id,
      metadata: { productId: body.productId },
    });
    return ok({ success: true });
  }
);
