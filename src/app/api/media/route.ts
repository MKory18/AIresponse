import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listMedia } from "@/modules/media/service";

// Dedicated query schema: category is validated against the Prisma
// MediaCategory enum so invalid values are rejected with 422 instead of
// reaching Prisma and failing with a 500.
const mediaListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.enum(["PRODUCT", "FEEDBACK", "TESTIMONIAL", "BRAND", "EDUCATIONAL", "OTHER"]).optional(),
  type: z.enum(["IMAGE", "VIDEO", "AUDIO", "DOCUMENT"]).optional(),
  productId: z.string().cuid().optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const GET = createHandler(
  { query: mediaListQuerySchema, permission: "media.read" },
  async ({ auth, query }) => {
    const result = await listMedia(prisma, {
      workspaceId: auth!.workspaceId,
      category: query.category,
      type: query.type,
      productId: query.productId,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
    // Product associations per asset (one batched lookup, no N+1).
    const ids = result.items.map((a) => a.id);
    const links =
      ids.length > 0
        ? await prisma.productMedia.findMany({
            where: { mediaAssetId: { in: ids }, workspaceId: auth!.workspaceId },
            select: { mediaAssetId: true, productId: true, isPrimary: true },
          })
        : [];
    const productIds = [...new Set(links.map((l) => l.productId))];
    const products =
      productIds.length > 0
        ? await prisma.product.findMany({
            where: { id: { in: productIds }, workspaceId: auth!.workspaceId },
            select: { id: true, name: true },
          })
        : [];
    const nameById = new Map(products.map((p) => [p.id, p.name]));
    const linksByAsset = new Map<string, { id: string; name: string; isPrimary: boolean }[]>();
    for (const l of links) {
      const arr = linksByAsset.get(l.mediaAssetId) ?? [];
      arr.push({ id: l.productId, name: nameById.get(l.productId) ?? l.productId, isPrimary: l.isPrimary });
      linksByAsset.set(l.mediaAssetId, arr);
    }
    return ok({
      ...result,
      items: result.items.map((a) => ({ ...a, products: linksByAsset.get(a.id) ?? [] })),
    });
  }
);
