import type { Db } from "@/modules/customers/service";
import { AppError, ConflictError, NotFoundError } from "@/core/errors";
import { CUSTOMER_INBOUND } from "@/modules/media/service";

/**
 * PAGE CATALOGS — WHICH PRODUCTS EACH PAGE MAY ANSWER WITH.
 *
 * A catalog is a named set of this workspace's products. A page-channel
 * carries exactly ONE active catalog (CatalogPageAssignment.channelId is
 * unique), resolved ONLY through the trusted channel id from the message
 * path — never through the page name, never through every product in the
 * database.
 *
 * Money rules: prices, offers and stock stay on Product. The catalog
 * never copies them, so it can never disagree with them.
 */

export interface CatalogRow {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

async function ownCatalog(db: Db, workspaceId: string, catalogId: string) {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, workspaceId } });
  if (!catalog) throw new NotFoundError("الكتالوج");
  return catalog as CatalogRow;
}

async function ownChannel(db: Db, workspaceId: string, channelId: string) {
  const channel = await db.channel.findFirst({ where: { id: channelId, workspaceId } });
  if (!channel) throw new NotFoundError("القناة");
  return channel as { id: string; type: string; status: string; displayName: string; externalId: string | null };
}

export async function listCatalogs(
  db: Db,
  workspaceId: string,
  opts: { q?: string; isActive?: boolean; channelId?: string; sort?: "name" | "updated" } = {}
) {
  const where: Record<string, unknown> = { workspaceId };
  if (opts.isActive !== undefined) where.isActive = opts.isActive;
  if (opts.q) where.name = { contains: opts.q, mode: "insensitive" };
  if (opts.channelId) {
    const link = await db.catalogPageAssignment.findUnique({ where: { channelId: opts.channelId } });
    if (!link || (link as { workspaceId: string }).workspaceId !== workspaceId) return [];
    where.id = (link as { catalogId: string }).catalogId;
  }
  const rows = (await db.catalog.findMany({
    where,
    orderBy: opts.sort === "name" ? { name: "asc" } : { updatedAt: "desc" },
    take: 100,
  })) as CatalogRow[];
  return Promise.all(
    rows.map(async (c) => {
      const [products, pages] = await Promise.all([
        db.catalogProduct.count({ where: { catalogId: c.id } }),
        db.catalogPageAssignment.count({ where: { catalogId: c.id } }),
      ]);
      return { ...c, products, pages };
    })
  );
}

export async function createCatalog(
  db: Db,
  workspaceId: string,
  input: { name: string; description?: string | null; isActive?: boolean }
) {
  try {
    return (await db.catalog.create({
      data: {
        workspaceId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        isActive: input.isActive ?? true,
      },
    })) as CatalogRow;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "P2002") throw new ConflictError("اسم الكتالوج مستخدم بالفعل");
    throw e;
  }
}

export async function updateCatalog(
  db: Db,
  workspaceId: string,
  catalogId: string,
  input: { name?: string; description?: string | null; isActive?: boolean }
) {
  await ownCatalog(db, workspaceId, catalogId);
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.description !== undefined) data.description = input.description?.trim() || null;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  try {
    return (await db.catalog.update({ where: { id: catalogId }, data })) as CatalogRow;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "P2002") throw new ConflictError("اسم الكتالوج مستخدم بالفعل");
    throw e;
  }
}

/**
 * Delete removes the catalog and its links — never the products. Nothing
 * else in the schema points at catalogs (orders point at products), so no
 * historical row loses its meaning; the audit row records who did it.
 */
export async function deleteCatalog(db: Db, workspaceId: string, catalogId: string) {
  await ownCatalog(db, workspaceId, catalogId);
  // Links first, then the catalog: explicit on every database (the schema
  // also cascades, as a second guarantee). Products are never touched.
  await db.catalogProduct.deleteMany({ where: { catalogId } });
  await db.catalogPageAssignment.deleteMany({ where: { catalogId } });
  await db.catalog.delete({ where: { id: catalogId } });
}

export async function addCatalogProducts(
  db: Db,
  workspaceId: string,
  catalogId: string,
  productIds: string[]
): Promise<{ added: number; skipped: number }> {
  await ownCatalog(db, workspaceId, catalogId);
  const clean = [...new Set(productIds)];
  if (!clean.length) return { added: 0, skipped: 0 };
  // Same workspace only — a foreign id matches nothing and is skipped.
  const owned = (await db.product.findMany({
    where: { id: { in: clean }, workspaceId },
    select: { id: true },
  })) as { id: string }[];
  const ownedIds = new Set(owned.map((p) => p.id));
  const skipped = clean.length - ownedIds.size;
  if (!ownedIds.size) return { added: 0, skipped };
  const res = (await db.catalogProduct.createMany({
    data: [...ownedIds].map((productId) => ({ catalogId, productId })),
    skipDuplicates: true,
  })) as { count: number };
  return { added: res.count, skipped: skipped + (ownedIds.size - res.count) };
}

/** Unlink only — the product itself is never touched. */
export async function removeCatalogProduct(db: Db, workspaceId: string, catalogId: string, productId: string) {
  await ownCatalog(db, workspaceId, catalogId);
  await db.catalogProduct.deleteMany({ where: { catalogId, productId } });
}

export async function getCatalogDetail(db: Db, workspaceId: string, catalogId: string) {
  const catalog = await ownCatalog(db, workspaceId, catalogId);
  // Two reads instead of nested includes: the link rows first, then the
  // products and channels by id — one shape on every database.
  const [links, assignments] = await Promise.all([
    db.catalogProduct.findMany({
      where: { catalogId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { productId: true },
    }),
    db.catalogPageAssignment.findMany({ where: { catalogId } }),
  ]);
  const linkIds = (links as { productId: string }[]).map((l) => l.productId);
  const channelIds = (assignments as { channelId: string }[]).map((a) => a.channelId);
  const [products, channels] = await Promise.all([
    linkIds.length
      ? db.product.findMany({
          where: { id: { in: linkIds }, workspaceId },
          select: {
            id: true, name: true, sku: true, price: true, currency: true, stockStatus: true,
            stockQty: true, isActive: true, isArchived: true, offers: true,
          },
        })
      : [],
    channelIds.length
      ? db.channel.findMany({
          where: { id: { in: channelIds }, workspaceId },
          select: { id: true, type: true, displayName: true, externalId: true, status: true },
        })
      : [],
  ]);
  const productById = new Map((products as { id: string }[]).map((p) => [p.id, p]));
  const channelById = new Map((channels as { id: string }[]).map((c) => [c.id, c]));
  return {
    catalog,
    products: linkIds.map((id) => ({ productId: id, product: productById.get(id) ?? null })),
    pages: (assignments as { id: string; channelId: string }[]).map((a) => ({
      ...a,
      channel: channelById.get(a.channelId) ?? null,
    })),
  };
}

/**
 * Attach a page-channel to a catalog. Messenger only — the feature does
 * not cover Instagram, WhatsApp or Telegram. The channel must belong to
 * this workspace and be CONNECTED; anything else is refused out loud,
 * with its state shown, rather than stored as a dead link.
 */
export async function assignCatalogPage(
  db: Db,
  workspaceId: string,
  input: { catalogId: string; channelId: string; assignedBy?: string }
) {
  const catalog = await ownCatalog(db, workspaceId, input.catalogId);
  if (!catalog.isActive) throw new AppError("الكتالوج متوقف — فعّله قبل الربط", 422, "CATALOG_INACTIVE");
  const channel = await ownChannel(db, workspaceId, input.channelId);
  if (channel.type !== "FACEBOOK") throw new AppError("ربط الكتالوجات متاح لقنوات ماسنجر فقط", 422, "CHANNEL_NOT_MESSENGER");
  if (channel.status !== "CONNECTED") throw new AppError("الصفحة غير متصلة — اربطها أولاً ثم أسند الكتالوج", 422, "CHANNEL_NOT_CONNECTED");
  // One row per channel: a switch replaces it atomically, so a partial
  // failure can never leave the page with no valid setting.
  return (await db.catalogPageAssignment.upsert({
    where: { channelId: input.channelId },
    create: {
      workspaceId,
      catalogId: input.catalogId,
      channelId: input.channelId,
      assignedBy: input.assignedBy ?? null,
    },
    update: { catalogId: input.catalogId, workspaceId, assignedBy: input.assignedBy ?? null, assignedAt: new Date() },
  })) as { id: string; catalogId: string; channelId: string };
}

/** Detach only — the catalog and its products stay exactly as they were. */
export async function unassignCatalogPage(db: Db, workspaceId: string, channelId: string) {
  const link = (await db.catalogPageAssignment.findUnique({ where: { channelId } })) as {
    id: string;
    workspaceId: string;
  } | null;
  if (!link || link.workspaceId !== workspaceId) throw new NotFoundError("الربط");
  // By id, not by channel: the fake and the database agree on ids, and the
  // row was just read — no blind unique-key delete.
  await db.catalogPageAssignment.delete({ where: { id: link.id } });
}

export type CatalogResolution =
  | { status: "ok"; catalog: CatalogRow }
  | { status: "no_assignment" | "catalog_inactive" | "no_catalogs"; catalog: null };

/**
 * THE ONE TRUSTED PLACE THAT RESOLVES A PAGE'S CATALOG.
 *
 * Nothing else in the codebase may decide which catalog a page answers
 * with. Callers pass the channel id from the message path (conversation
 * → channel), never a page name. Reasons are safe to log: no secrets,
 * no customer data.
 */
export async function resolveCatalogForChannel(
  db: Db,
  workspaceId: string,
  channelId: string
): Promise<CatalogResolution> {
  if (!(await workspaceHasCatalogs(db, workspaceId))) return { status: "no_catalogs", catalog: null };
  const link = (await db.catalogPageAssignment.findUnique({ where: { channelId } })) as {
    workspaceId: string;
    catalogId: string;
  } | null;
  if (!link || link.workspaceId !== workspaceId) return { status: "no_assignment", catalog: null };
  const catalog = (await db.catalog.findFirst({ where: { id: link.catalogId, workspaceId } })) as CatalogRow | null;
  if (!catalog) return { status: "no_assignment", catalog: null };
  if (!catalog.isActive) return { status: "catalog_inactive", catalog: null };
  return { status: "ok", catalog };
}

export async function workspaceHasCatalogs(db: Db, workspaceId: string): Promise<boolean> {
  const n = await db.catalog.count({ where: { workspaceId } });
  return n > 0;
}

/** Product ids of an active catalog, oldest-link first. Empty when none. */
export async function catalogProductIds(db: Db, workspaceId: string, catalogId: string): Promise<string[]> {
  const catalog = await ownCatalog(db, workspaceId, catalogId);
  if (!catalog.isActive) return [];
  const rows = (await db.catalogProduct.findMany({
    where: { catalogId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { productId: true },
  })) as { productId: string }[];
  return rows.map((r) => r.productId);
}

/**
 * WHAT THE AI MAY USE FOR THIS PAGE — PREVIEW AND CONTEXT ALIKE.
 *
 * The same function feeds the dashboard preview and (through the
 * resolution above) the reply path, so a preview that shows a product
 * the reply cannot use is impossible. Prices, images, offers and stock
 * are read from Product at call time — never copied here.
 */
export async function buildPageProductContext(db: Db, workspaceId: string, channelId: string) {
  const resolved = await resolveCatalogForChannel(db, workspaceId, channelId);
  if (resolved.status !== "ok" || !resolved.catalog) {
    return { catalog: null, status: resolved.status, products: [] as unknown[] };
  }
  const ids = await catalogProductIds(db, workspaceId, resolved.catalog.id);
  if (!ids.length) return { catalog: resolved.catalog, status: "ok" as const, products: [] as unknown[] };
  const products = (await db.product.findMany({
    where: { id: { in: ids }, workspaceId, isActive: true, isArchived: false },
    select: {
      id: true, name: true, sku: true, description: true, shortDescription: true,
      price: true, compareAtPrice: true, currency: true,
      stockStatus: true, stockQty: true, category: true,
      offers: true, usage: true,
    },
  })) as Record<string, unknown>[];
  const order = new Map(ids.map((id, i) => [id, i]));
  products.sort((a, b) => (order.get(a.id as string) ?? 0) - (order.get(b.id as string) ?? 0));
  const media = (await db.mediaAsset.findMany({
    where: { workspaceId, productId: { in: ids }, type: "IMAGE" },
    select: { id: true, url: true, productId: true, category: true },
    take: 60,
  })) as { id: string; url: string; productId: string | null; category: string }[];

  const imagesByProduct = new Map<string, string[]>();
  // Join-table links alongside the legacy FK — same cover-both rule as
  // the media library, so a linked photo is never missing here.
  const joins = (await db.productMedia.findMany({
    where: { productId: { in: ids }, workspaceId },
    include: { mediaAsset: true },
    take: 200,
  })) as {
    productId: string;
    mediaAsset: { id: string; url: string; type: string; category: string } | null;
  }[];
  for (const j of joins) {
    if (j.mediaAsset?.type !== "IMAGE") continue;
    if (j.mediaAsset.category === CUSTOMER_INBOUND) continue;
    const arr = imagesByProduct.get(j.productId) ?? [];
    if (arr.length < 3 && !arr.includes(j.mediaAsset.url)) arr.push(j.mediaAsset.url);
    imagesByProduct.set(j.productId, arr);
  }
  for (const m of media) {
    if (!m.productId) continue;
    if (m.category === CUSTOMER_INBOUND) continue;
    const arr = imagesByProduct.get(m.productId) ?? [];
    if (arr.length < 3) arr.push(m.url);
    imagesByProduct.set(m.productId, arr);
  }
  return {
    catalog: resolved.catalog,
    status: "ok" as const,
    products: products.map((p) => ({ ...p, images: imagesByProduct.get(p.id as string) ?? [] })),
  };
}
