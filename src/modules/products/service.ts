import type { Prisma, StockStatus } from "@prisma/client";
import { AppError, ConflictError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db, Paginated } from "@/modules/customers/service";
import { CUSTOMER_INBOUND } from "@/modules/media/service";

export interface ProductInput {
  name: string;
  sku: string;
  description?: string | null;
  shortDescription?: string | null;
  price: number | string;
  compareAtPrice?: number | string | null;
  currency?: string;
  stockStatus?: StockStatus;
  stockQty?: number;
  category?: string | null;
  tags?: string[];
  benefits?: string[];
  ingredients?: string | null;
  usage?: string | null;
  warnings?: string | null;
  objections?: string[];
  salesNotes?: string | null;
  isActive?: boolean;
}

export async function createProduct(db: Db, ctx: ActorContext, input: ProductInput) {
  const clash = await db.product.findFirst({
    where: { workspaceId: ctx.workspaceId, sku: input.sku },
    select: { id: true },
  });
  if (clash) throw new ConflictError("A product with this SKU already exists");

  const product = await db.product.create({
    data: { ...input, workspaceId: ctx.workspaceId } as Prisma.ProductUncheckedCreateInput,
  });

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "product.created",
    entityType: "Product",
    entityId: product.id,
  });
  await eventBus.publish(makeEvent("ProductCreated", ctx.workspaceId, { productId: product.id }));
  return product;
}

export async function getOwnedProduct(db: Db, workspaceId: string, productId: string) {
  const product = await db.product.findUnique({
    where: { id: productId },
    include: {
      variants: true,
      mediaLinks: { include: { mediaAsset: true }, orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }] },
      faqs: { where: { isActive: true } },
    },
  });
  if (!product || product.workspaceId !== workspaceId) throw new NotFoundError("Product");
  return product;
}

export async function listProducts(
  db: Db,
  params: {
    workspaceId: string;
    q?: string;
    category?: string;
    status?: "active" | "inactive" | "archived" | "all";
    cursor?: string;
    limit?: number;
  }
): Promise<Paginated<Prisma.ProductGetPayload<{ include: { mediaLinks: { include: { mediaAsset: true } } } }>>> {
  const limit = Math.min(params.limit ?? 25, 100);
  const where: Prisma.ProductWhereInput = { workspaceId: params.workspaceId };
  if (params.q) {
    where.OR = [
      { name: { contains: params.q, mode: "insensitive" } },
      { sku: { contains: params.q, mode: "insensitive" } },
      { tags: { has: params.q } },
    ];
  }
  if (params.category) where.category = params.category;
  if (params.status === "active") where.isActive = true;
  if (params.status === "inactive") where.isActive = false;
  if (params.status === "archived") where.isArchived = true;
  else if (params.status !== "all") where.isArchived = false;

  const products = await db.product.findMany({
    where,
    include: { mediaLinks: { include: { mediaAsset: true }, orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }], take: 1 } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });
  const hasMore = products.length > limit;
  const items = hasMore ? products.slice(0, limit) : products;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

export async function updateProduct(
  db: Db,
  ctx: ActorContext,
  productId: string,
  data: Partial<ProductInput> & { isArchived?: boolean }
) {
  const existing = await getOwnedProduct(db, ctx.workspaceId, productId);

  if (data.sku && data.sku !== existing.sku) {
    const clash = await db.product.findFirst({
      where: { workspaceId: ctx.workspaceId, sku: data.sku, id: { not: productId } },
      select: { id: true },
    });
    if (clash) throw new ConflictError("A product with this SKU already exists");
  }

  const updated = await db.product.update({
    where: { id: productId },
    data: data as Prisma.ProductUncheckedUpdateInput,
  });

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "product.updated",
    entityType: "Product",
    entityId: productId,
    metadata: { fields: Object.keys(data) },
  });
  return updated;
}

// â”€â”€ Product â†” Media â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function attachProductMedia(
  db: Db,
  ctx: ActorContext,
  productId: string,
  mediaAssetId: string,
  opts?: { isPrimary?: boolean; sortOrder?: number }
) {
  await getOwnedProduct(db, ctx.workspaceId, productId);
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaAssetId } });
  if (!asset || asset.workspaceId !== ctx.workspaceId) throw new NotFoundError("Media");
  // وسيط الزبون الوارد مربوط برسالته بس — ما بيتلحق بمنتج ولا بيتصعد
  // لِ ميديا المنتج/الكاتولج/سياق الذكاء (شرح media/service.ts).
  if ((asset as { category?: string }).category === CUSTOMER_INBOUND) {
    throw new AppError("Inbound customer media cannot be attached to products", 422, "INBOUND_MEDIA_NOT_ATTACHABLE");
  }

  const existing = await db.productMedia.findUnique({
    where: { productId_mediaAssetId: { productId, mediaAssetId } },
  });
  // Idempotent re-attach: update flags instead of 409 so UI retries and
  // upload-then-attach flows (upload auto-links) never break.
  if (existing) {
    if (opts?.isPrimary) {
      await db.productMedia.updateMany({ where: { productId }, data: { isPrimary: false } });
    }
    return db.productMedia.update({
      where: { id: existing.id },
      data: {
        ...(opts?.isPrimary !== undefined ? { isPrimary: opts.isPrimary } : {}),
        ...(opts?.sortOrder !== undefined ? { sortOrder: opts.sortOrder } : {}),
      },
    });
  }

  if (opts?.isPrimary) {
    // Best-effort atomic flip via interactive transaction when available.
    const anyDb = db as unknown as {
      $transaction?: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
    };
    if (typeof anyDb.$transaction === "function") {
      return anyDb.$transaction((tx) =>
        (async () => {
          await tx.productMedia.updateMany({ where: { productId }, data: { isPrimary: false } });
          return tx.productMedia.create({
            data: {
              productId,
              mediaAssetId,
              workspaceId: ctx.workspaceId,
              sortOrder: opts?.sortOrder ?? 0,
              isPrimary: true,
            },
          });
        })()
      );
    }
    await db.productMedia.updateMany({ where: { productId }, data: { isPrimary: false } });
    return db.productMedia.create({
      data: {
        productId,
        mediaAssetId,
        workspaceId: ctx.workspaceId,
        sortOrder: opts?.sortOrder ?? 0,
        isPrimary: true,
      },
    });
  }
  const link = await db.productMedia.create({
    data: {
      productId,
      mediaAssetId,
      workspaceId: ctx.workspaceId,
      sortOrder: opts?.sortOrder ?? 0,
      isPrimary: opts?.isPrimary ?? false,
    },
  });
  return link;
}

export async function setPrimaryProductMedia(db: Db, ctx: ActorContext, productId: string, mediaAssetId: string) {
  await getOwnedProduct(db, ctx.workspaceId, productId);
  const link = await db.productMedia.findUnique({
    where: { productId_mediaAssetId: { productId, mediaAssetId } },
  });
  if (!link) throw new NotFoundError("Product media link");
  await db.productMedia.updateMany({ where: { productId }, data: { isPrimary: false } });
  await db.productMedia.update({ where: { id: link.id }, data: { isPrimary: true } });
}

export async function detachProductMedia(db: Db, ctx: ActorContext, productId: string, mediaAssetId: string) {
  await getOwnedProduct(db, ctx.workspaceId, productId);
  const link = await db.productMedia.findUnique({
    where: { productId_mediaAssetId: { productId, mediaAssetId } },
  });
  if (link) await db.productMedia.delete({ where: { id: link.id } });
  // Clear the legacy direct FK too: findProductMedia reads both sources, so a
  // stale productId would keep surfacing the image for this product (and its AI).
  // The asset itself is preserved — only the association is removed.
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaAssetId } });
  if (asset && asset.workspaceId === ctx.workspaceId && asset.productId === productId) {
    await db.mediaAsset.update({ where: { id: mediaAssetId }, data: { productId: null } });
  }
}

export async function reorderProductMedia(
  db: Db,
  ctx: ActorContext,
  productId: string,
  orderedMediaIds: string[]
) {
  await getOwnedProduct(db, ctx.workspaceId, productId);
  for (let i = 0; i < orderedMediaIds.length; i++) {
    const link = await db.productMedia.findUnique({
      where: { productId_mediaAssetId: { productId, mediaAssetId: orderedMediaIds[i] } },
    });
    if (link) await db.productMedia.update({ where: { id: link.id }, data: { sortOrder: i } });
  }
}
