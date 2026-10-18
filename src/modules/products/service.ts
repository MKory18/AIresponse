import type { Prisma, StockStatus } from "@prisma/client";
import { AppError, ConflictError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db, Paginated } from "@/modules/customers/service";
import { CUSTOMER_INBOUND } from "@/modules/media/service";

export interface ProductPriceTierInput {
  label: string;
  price: number | string;
}

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
  priceTiers?: ProductPriceTierInput[];
  isActive?: boolean;
}

/** تسميات الأسعار المنظمة: بلا فراغات، فريدة، وسعر رقمي ≥ 0 — وبحد أعلى 10. */
function normalizeTiers(
  tiers: ProductPriceTierInput[] | undefined,
  db: Db,
  productId?: string
): { label: string; price: string }[] {
  if (!tiers || tiers.length === 0) return [];
  if (tiers.length > 10) {
    throw new AppError("الأسعار الإضافية بحد أقصى 10 أسعار للمنتج", 422, "TOO_MANY_PRICE_TIERS");
  }
  const seen = new Set<string>();
  const out: { label: string; price: string }[] = [];
  for (const t of tiers) {
    const label = String(t.label ?? "").trim();
    const amount = parsePriceAmount(t.price);
    if (!label || amount === null) {
      throw new AppError("كل سعر إضافي يحتاج تسمية وسعرًا رقميًا صحيحًا", 422, "INVALID_PRICE_TIER");
    }
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, price: amount });
  }
  void db; void productId; // دالة صرفة — التوقيع ثابت للاستخدامات الجاية (فحص تعارض)
  return out;
}

/**
 * تحليل قيمة سعر مرنة: رقم أو نص يحوي أرقامًا (كما تأتي من اكسل):
 * «1,250.00» · «١٥٠» · «JD 12.5» → رقم. null = غير مرموز/سالب.
 */
export function parsePriceAmount(v: unknown): string | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) return null;
    return String(v);
  }
  if (typeof v !== "string") return null;
  const arabicFixed = v.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const cleaned = arabicFixed.replace(/[^\d.,-]/g, "").replace(/,(\d{3})/g, "$1").replace(/,/g, ".");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(Math.round(n * 100) / 100);
}

/** استبدال كامل لأشعار السعر: بلا صفوف = حذف الكل (على رؤية الأخير دائمًا). */
async function applyPriceTiers(db: Db, productId: string, tiers: { label: string; price: string }[]) {
  const anyDb = db as unknown as { $transaction?: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown> };
  const write = async (tx: Db) => {
    await tx.productPrice.deleteMany({ where: { productId } });
    if (tiers.length > 0) {
      await tx.productPrice.createMany({ data: tiers.map((t) => ({ productId, label: t.label, price: t.price })) });
    }
  };
  if (typeof anyDb.$transaction === "function") return anyDb.$transaction(write);
  return write(db);
}

export async function createProduct(db: Db, ctx: ActorContext, input: ProductInput) {
  const clash = await db.product.findFirst({
    where: { workspaceId: ctx.workspaceId, sku: input.sku },
    select: { id: true },
  });
  if (clash) throw new ConflictError("A product with this SKU already exists");

  // تدقيق الأسعار قبل الإنشاء — رفض صريح ما يخلّي منتج مأكول بلا أسعار سليمة.
  const tiers = normalizeTiers(input.priceTiers, db);

  const product = await db.product.create({
    data: { ...input, priceTiers: undefined, workspaceId: ctx.workspaceId } as Prisma.ProductUncheckedCreateInput,
  });

  if (tiers.length > 0) await db.productPrice.createMany({ data: tiers.map((t) => ({ productId: product.id, label: t.label, price: t.price })) });

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
      priceTiers: true,
      mediaLinks: { include: { mediaAsset: true }, orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }] },
      faqs: { where: { isActive: true } },
    },
  });
  if (!product || product.workspaceId !== workspaceId) throw new NotFoundError("Product");
  return product;
}

/** أسعار المنتج الإضافية بلغة العرض — تُغذّى للذكاء كسنة موثوقة. */
export function priceTierLines(
  tiers: { label: string; price: string | number }[] | undefined | null
): string[] {
  if (!tiers || tiers.length === 0) return [];
  return tiers
    .filter((t) => t.label && t.price !== undefined && t.price !== null && String(t.price) !== "")
    .map((t) => `${String(t.label).trim()}: ${Number(t.price).toLocaleString()}`);
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
    include: {
      mediaLinks: { include: { mediaAsset: true }, orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }], take: 1 },
      priceTiers: true,
    },
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

  // تدقيق الأسعار قبل التحديث — رفض صريح ما يخلّي تحديث جزئي متضارب.
  const tiers =
    data.priceTiers !== undefined ? normalizeTiers(data.priceTiers, db) : null;

  const updated = await db.product.update({
    where: { id: productId },
    data: { ...data, priceTiers: undefined } as Prisma.ProductUncheckedUpdateInput,
  });

  // الأسعار الإضافية: نفس منطق «آخر حالة مرسلة هي الحقيقة» —
  // غياب المفتاح = ما في تغيير؛ وجوده (حتى فارغ) = استبدال كامل.
  if (tiers !== null) {
    await applyPriceTiers(db, productId, tiers);
  }

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
