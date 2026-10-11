import type { Prisma, MediaCategory, MediaType } from "@prisma/client";
import { AppError, NotFoundError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db, Paginated } from "@/modules/customers/service";
import { getStorage, generateStorageKey, validateUpload, assertMagicBytes } from "./storage";
export { validateUpload } from "./storage";

/**
 * وسيط الزبون الوارد (واتساب) مربوط برسالته بس. ممنوع يطلع بأي مكان مشترك:
 * المكتبة · منتجات · سياق الذكاء · الحملات والقوالب · الروابط العامة.
 * بلا هالاستثناء، رسالة صورة بلا نص كانت ترجّع «أحدث 3 وسائط» بالمساحة —
 * يعني وسائط زباين **تانيين** بعنوانها ورابطها جوّا برومبت الموديل.
 */
export const CUSTOMER_INBOUND: MediaCategory = "CUSTOMER_INBOUND";

/** شرط الاستثناء — بينضاف لكل استعلام مشترك. */
export function excludeCustomerInbound(): Prisma.MediaAssetWhereInput {
  return { category: { not: CUSTOMER_INBOUND } };
}
import { signPayload } from "@/core/crypto";
import { getEnv } from "@/core/env";

const log = childLogger("media");

export interface UploadMediaInput {
  filename: string;
  mimeType: string;
  size: number;
  data: Buffer;
  category?: MediaCategory;
  productId?: string | null;
  title?: string | null;
  description?: string | null;
  tags?: string[];
}

export async function uploadMedia(db: Db, ctx: ActorContext, input: UploadMediaInput) {
  const started = Date.now();
  log.info({ workspaceId: ctx.workspaceId, filenameLength: input.filename?.length ?? 0, size: input.size }, "media_upload_started");
  const { mediaType, safeName } = validateUpload({
    mimeType: input.mimeType,
    filename: input.filename,
    size: input.size,
  });
  // Don't trust MIME/extension alone: verify fixed-header magic bytes where
  // the format allows it (corrupt/renamed files fail fast, before storage).
  assertMagicBytes(input.mimeType, input.data);

  if (input.productId) {
    const product = await db.product.findUnique({ where: { id: input.productId }, select: { workspaceId: true } });
    if (!product || product.workspaceId !== ctx.workspaceId) throw new NotFoundError("Product");
  }

  const storageKey = generateStorageKey(ctx.workspaceId, safeName);
  let stored;
  try {
    stored = await getStorage().put(storageKey, input.data, input.mimeType);
  } catch (err) {
    // Storage failures (EACCES/ENOENT/volume not mounted) must NEVER surface
    // as a bare INTERNAL_ERROR — that is what made the real upload failure
    // invisible ("فشل الرفع" with no cause). Fail with an explicit code +
    // safe structured log (size/claimed-MIME/extension/duration, no contents).
    const fsCode = (err as { code?: string }).code ?? "STORAGE_ERROR";
    log.error(
      {
        workspaceId: ctx.workspaceId,
        size: input.size,
        claimedMime: input.mimeType,
        fsCode,
        durationMs: Date.now() - started,
      },
      "media_upload_failed"
    );
    throw new AppError(`Storage write failed (${fsCode}) — check storage volume permissions/mount`, 500, "STORAGE_WRITE_FAILED");
  }

  let asset;
  try {
    asset = await db.mediaAsset.create({
      data: {
        workspaceId: ctx.workspaceId,
        url: stored.url,
        storageKey,
        mimeType: input.mimeType,
        size: input.size,
        title: input.title ?? safeName,
        type: mediaType,
        category: input.category ?? (input.productId ? "PRODUCT" : "OTHER"),
        productId: input.productId ?? null,
        tags: input.tags ?? [],
        description: input.description ?? null,
      },
    });
  } catch (err) {
    // No orphan files: storage write succeeded but DB failed.
    await getStorage().delete(storageKey).catch(() => {});
    log.warn({ workspaceId: ctx.workspaceId, storageKey, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started }, "media_upload_failed");
    throw err;
  }

  // Single source of truth going forward is the ProductMedia join table.
  // Keep the legacy direct FK in sync AND create the join row atomically.
  if (input.productId) {
    try {
      await db.productMedia.upsert({
        where: { productId_mediaAssetId: { productId: input.productId, mediaAssetId: asset.id } },
        create: { productId: input.productId, mediaAssetId: asset.id, workspaceId: ctx.workspaceId },
        update: {},
      });
    } catch {
      // Join sync is best-effort; direct FK already preserves the link.
    }
  }

  await eventBus.publish(makeEvent("MediaCreated", ctx.workspaceId, { mediaId: asset.id, type: mediaType }));
  log.info({ workspaceId: ctx.workspaceId, mediaId: asset.id, type: mediaType, durationMs: Date.now() - started }, "media_upload_completed");
  return asset;
}

export async function getOwnedMedia(db: Db, workspaceId: string, mediaId: string) {
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!asset || asset.workspaceId !== workspaceId) throw new NotFoundError("Media");
  return asset;
}

export async function listMedia(
  db: Db,
  params: {
    workspaceId: string;
    category?: MediaCategory;
    type?: MediaType;
    productId?: string;
    q?: string;
    cursor?: string;
    limit?: number;
  }
): Promise<Paginated<Prisma.MediaAssetGetPayload<Record<string, never>>>> {
  const limit = Math.min(params.limit ?? 30, 100);
  // المكتبة وكل المنتقيات (حملات · منتجات · قوالب) بتمر من هون.
  if (params.category === CUSTOMER_INBOUND) return { items: [], nextCursor: null };
  const where: Prisma.MediaAssetWhereInput = {
    workspaceId: params.workspaceId,
    ...excludeCustomerInbound(),
  };
  if (params.category) where.category = params.category;
  if (params.type) where.type = params.type;
  const andClauses: Prisma.MediaAssetWhereInput[] = [];
  if (params.productId) {
    // Canonical links live in ProductMedia (attach API writes join-only rows),
    // while legacy rows carry the direct FK — cover both so the filter is complete.
    const links = await db.productMedia.findMany({
      where: { productId: params.productId, workspaceId: params.workspaceId },
      select: { mediaAssetId: true },
      take: 500,
    });
    const linkedIds = links.map((l) => l.mediaAssetId);
    andClauses.push({ OR: [{ productId: params.productId }, ...(linkedIds.length ? [{ id: { in: linkedIds } }] : [])] });
  }
  if (params.q) {
    andClauses.push({
      OR: [
        { title: { contains: params.q, mode: "insensitive" } },
        { description: { contains: params.q, mode: "insensitive" } },
        { tags: { has: params.q } },
      ],
    });
  }
  if (andClauses.length) where.AND = andClauses;
  const assets = await db.mediaAsset.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });
  const hasMore = assets.length > limit;
  const items = hasMore ? assets.slice(0, limit) : assets;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

export async function updateMedia(
  db: Db,
  ctx: ActorContext,
  mediaId: string,
  data: { title?: string | null; description?: string | null; tags?: string[]; category?: MediaCategory; productId?: string | null }
) {
  const asset = await getOwnedMedia(db, ctx.workspaceId, mediaId);
  if (data.productId) {
    const product = await db.product.findUnique({ where: { id: data.productId }, select: { workspaceId: true } });
    if (!product || product.workspaceId !== ctx.workspaceId) throw new NotFoundError("Product");
  }
  const updated = await db.mediaAsset.update({
    where: { id: asset.id },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.tags !== undefined ? { tags: data.tags } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.productId !== undefined ? { productId: data.productId } : {}),
    },
  });
  // Keep the canonical ProductMedia join table in sync with the legacy FK:
  // re-pointing (or clearing) productId here must move (or drop) the join
  // row, otherwise product pages and AI context diverge from the library.
  if (data.productId !== undefined && data.productId !== asset.productId) {
    await db.productMedia.deleteMany({ where: { mediaAssetId: asset.id } });
    if (data.productId) {
      await db.productMedia.upsert({
        where: { productId_mediaAssetId: { productId: data.productId, mediaAssetId: asset.id } },
        create: { productId: data.productId, mediaAssetId: asset.id, workspaceId: ctx.workspaceId },
        update: {},
      });
    }
  }
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "media.updated",
    entityType: "MediaAsset",
    entityId: mediaId,
  });
  return updated;
}

export async function deleteMedia(db: Db, ctx: ActorContext, mediaId: string) {
  const asset = await getOwnedMedia(db, ctx.workspaceId, mediaId);
  // DB first, then file: a failed DB delete must not leave a dead URL row.
  // ProductMedia links cascade via FK; detaching beforehand is unnecessary.
  await db.mediaAsset.delete({ where: { id: asset.id } });
  await getStorage().delete(asset.storageKey).catch(() => {});
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "media.deleted",
    entityType: "MediaAsset",
    entityId: mediaId,
  });
  await eventBus.publish(makeEvent("MediaDeleted", ctx.workspaceId, { mediaId }));
}

// ── Media retrieval (metadata/tags based — no vision AI per search) ─────────

export async function findProductMedia(db: Db, workspaceId: string, productId: string, limit = 5) {
  // Dual-source read during migration: legacy direct FK + canonical join table.
  const [direct, links] = await Promise.all([
    db.mediaAsset.findMany({
      where: { workspaceId, productId, type: "IMAGE", ...excludeCustomerInbound() },
      orderBy: [{ createdAt: "desc" }],
      take: limit,
    }),
    db.productMedia.findMany({
      where: { productId, workspaceId },
      include: { mediaAsset: true },
      orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }],
      take: limit,
    }),
  ]);
  const seen = new Set<string>();
  const merged: typeof direct = [];
  for (const l of links) {
    const a = (l as { mediaAsset?: (typeof direct)[number] }).mediaAsset;
    if (a && a.workspaceId === workspaceId && a.category !== CUSTOMER_INBOUND && !seen.has(a.id)) {
      seen.add(a.id);
      merged.push(a);
    }
  }
  for (const a of direct) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      merged.push(a);
    }
  }
  return merged.slice(0, limit);
}

export async function findFeedbackMedia(db: Db, workspaceId: string, productId: string, limit = 3) {
  const feedbacks = await db.feedback.findMany({
    where: { workspaceId, productId, isApproved: true, isArchived: false, mediaId: { not: null } },
    include: { media: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return feedbacks
    .map((f) => f.media)
    .filter((m): m is NonNullable<typeof m> => Boolean(m) && m!.category !== CUSTOMER_INBOUND);
}

export async function findRelevantMedia(
  db: Db,
  params: { workspaceId: string; query?: string; productId?: string; category?: MediaCategory; type?: MediaType; limit?: number }
) {
  // وسيط الزبون الوارد مستثنى دايمًا — حتى لو انطلب تصنيفه صريح.
  if (params.category === CUSTOMER_INBOUND) return [];
  const where: Prisma.MediaAssetWhereInput = {
    workspaceId: params.workspaceId,
    ...excludeCustomerInbound(),
  };
  if (params.productId) where.productId = params.productId;
  if (params.category) where.category = params.category;
  if (params.type) where.type = params.type;
  if (params.query) {
    where.OR = [
      { title: { contains: params.query, mode: "insensitive" } },
      { description: { contains: params.query, mode: "insensitive" } },
      { tags: { has: params.query } },
    ];
  }
  return db.mediaAsset.findMany({ where, orderBy: { createdAt: "desc" }, take: params.limit ?? 5 });
}

/** Generates a short-lived signed public URL for outbound delivery (e.g., Facebook Graph API). */
export async function generatePublicMediaUrl(
  db: Db,
  workspaceId: string,
  mediaId: string,
  ttlMinutes = 60
): Promise<string> {
  const asset = await getOwnedMedia(db, workspaceId, mediaId);
  // وسيط الزبون الوارد ما بينشر برابط عام أبدًا (ولا للإرسال لميتا).
  if (asset.category === CUSTOMER_INBOUND) {
    throw new AppError(
      "Customer inbound media is never published through a public URL",
      403,
      "CUSTOMER_INBOUND_NOT_PUBLISHABLE"
    );
  }
  const env = getEnv();
  const baseUrl = (env.APP_URL ?? "").replace(/\/+$/, "");
  // A relative or non-public base URL makes Meta's fetcher fail with an
  // opaque Graph error and the customer never receives the image. Fail fast
  // with an explicit reason in production; allow any value in dev/test.
  if (env.NODE_ENV === "production") {
    if (!baseUrl) {
      throw new AppError("APP_URL is not configured — public media URLs cannot be generated", 500, "APP_URL_MISSING");
    }
    if (!baseUrl.startsWith("https://")) {
      throw new AppError("APP_URL must be an HTTPS public URL for outbound media delivery", 500, "APP_URL_NOT_HTTPS");
    }
  }
  const exp = Math.floor(Date.now() / 1000) + ttlMinutes * 60;
  const token = signPayload({ mediaId: asset.id, workspaceId, exp });
  return `${baseUrl}/api/media/public/${token}`;
}
