import type { Prisma } from "@prisma/client";

type Db = Prisma.TransactionClient;

/**
 * P24 test helper — every test page must have an explicit catalog now.
 * Assigns one active catalog containing exactly the given products.
 */
export async function assignPageCatalog(
  db: Db,
  workspaceId: string,
  channelId: string,
  productIds?: string[]
) {
  const ids =
    productIds ??
    ((await db.product.findMany({ where: { workspaceId }, select: { id: true } })) as { id: string }[]).map(
      (p) => p.id
    );
  const catalog = (await db.catalog.create({
    data: { workspaceId, name: `catalog-${channelId}`, isActive: true },
  } as never)) as { id: string };
  for (const productId of ids) {
    await db.catalogProduct.create({ data: { catalogId: catalog.id, productId } } as never);
  }
  await db.catalogPageAssignment.create({
    data: { workspaceId, catalogId: catalog.id, channelId },
  } as never);
  return catalog.id;
}
