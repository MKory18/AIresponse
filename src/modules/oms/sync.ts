import { AppError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { OMS_PRODUCTS_PAGE_LIMIT, type OmsProduct } from "./client";
import { buildOmsClient, noteOmsError, noteOmsOk } from "./connection";
import { sameProductName } from "@/modules/products/name-match";

/**
 * منتجات الردود = منتجات الـ OMS (قرار المالك 2026-11-12).
 *
 * لكل منتج فعّال بالـ OMS:
 *   1. منتج عندنا بنفس الرمز (sku = code) ← بيتحدّث بمكانه.
 *   2. وإلا منتج عندنا بنفس الاسم ← بياخد رمز الـ OMS ويتحدّث بمكانه —
 *      بيضل معه صوره وأسئلته الجاهزة وربطه بالصفحات (ولا شي بينكسر).
 *   3. وإلا منتج جديد ← بينضاف لكل كتالوجات الصفحات (قرار المالك).
 * وكل منتج فعّال عندنا مش بالـ OMS ← **بيتوقف** (`isActive=false`) — مش
 * بينحذف: الطلبات القديمة وصوره بتضل، وبيرجع من صفحة المنتج.
 *
 * من الـ OMS: الاسم · السعر · العملة · حالة المخزون · العروض · المكمّلات.
 * عندنا بس (ما بينلمس): الوصف · الفوائد · الاستعمال · التحذيرات · الاعتراضات ·
 * ملاحظات البيع · الصور.
 *
 * ⚠️ أمان المزامنة: رد فاضي أو شكل غلط = ولا إيقاف (انقطاع ما بيمسح الكتالوج).
 * صفحة ممتلئة (500 = حد الباب) = ولا إيقاف كمان: ممكن في منتجات بعدها.
 */

export interface ProductSyncResult {
  received: number;
  updated: number;
  created: number;
  failed: number;
  deactivated: number;
  /** ليش ما توقف ولا منتج (null = الإيقاف اشتغل). */
  deactivationSkipped: "EMPTY" | "PAGE_FULL" | "ALL_FAILED" | null;
  errors: string[];
}

type LocalProduct = { id: string; sku: string; name: string; isActive: boolean; isArchived?: boolean };

/** نفس الاسم = نفس الكلمات بعد التطبيع العربي (أ/إ/آ · ة · ى · تشكيل · مسافات). */
// ط§ظ„طھط·ط¨ظٹط¹ ظˆط§ظ„ظ…ظ‚ط§ط±ظ†ط© طµط§ط±ظˆط§ ط¨ظ…ظƒط§ظ† ظˆط§ط­ط¯ ظ…ط´طھط±ظƒ ظ…ط¹ ظ…ط³ط§ط± ط§ظ„ط±ط¯.
export { sameProductName };


function problemOf(p: OmsProduct): string | null {
  if (!p.code || p.code.length > 64) return "رمز منتج ناقص";
  if (!p.name || p.name.length > 200) return `اسم ناقص للمنتج ${p.code}`;
  if (!Number.isFinite(p.price) || p.price < 0) return `سعر غير صالح للمنتج ${p.code}`;
  if (!p.currency || p.currency.length > 8) return `عملة غير صالحة للمنتج ${p.code}`;
  return null;
}

function stockFor(p: OmsProduct): "IN_STOCK" | "OUT_OF_STOCK" | undefined {
  if (p.stockStatus === "OUT_OF_STOCK") return "OUT_OF_STOCK";
  if (p.stockStatus === "IN_STOCK" || p.stockStatus === "LOW_STOCK") return "IN_STOCK";
  return undefined;
}

/** الحقول اللي مصدرها الـ OMS. */
function omsFields(p: OmsProduct): Record<string, unknown> {
  const stock = stockFor(p);
  return {
    name: p.name,
    sku: p.code,
    price: p.price,
    // الـ OMS ما عنده «سعر قبل الخصم»: سعر قديم عندنا كان رح يخلّي الذكاء
    // يحكي عن خصم مش موجود بالـ OMS.
    compareAtPrice: null,
    currency: p.currency,
    offers: p.offers,
    complementarySkus: p.complements.filter((s) => s && s !== p.code).slice(0, 20),
    syncedFromOms: true,
    isActive: true,
    isArchived: false,
    ...(stock ? { stockStatus: stock } : {}),
  };
}

async function addToEveryCatalog(db: Db, workspaceId: string, productId: string): Promise<number> {
  const catalogs = (await db.catalog.findMany({ where: { workspaceId, isActive: true }, select: { id: true } })) as Array<{ id: string }>;
  let n = 0;
  for (const c of catalogs) {
    const last = (await db.catalogProduct.findFirst({
      where: { catalogId: c.id },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    })) as { sortOrder: number } | null;
    try {
      await db.catalogProduct.create({ data: { catalogId: c.id, productId, sortOrder: (last?.sortOrder ?? -1) + 1 } });
      n += 1;
    } catch {
      // موجود أصلًا بالكتالوج — تمام.
    }
  }
  return n;
}

export async function syncProductsFromOms(db: Db, ctx: ActorContext): Promise<ProductSyncResult> {
  const client = await buildOmsClient(db, ctx.workspaceId);
  let products: OmsProduct[] | null;
  try {
    products = await client.getProducts(OMS_PRODUCTS_PAGE_LIMIT);
  } catch (err) {
    await noteOmsError(db, ctx.workspaceId, `sync: ${err instanceof AppError ? err.code : "ERROR"}`);
    throw err;
  }
  if (!products) {
    await noteOmsError(db, ctx.workspaceId, "sync: OMS_BAD_RESPONSE");
    throw new AppError("الـ OMS رجّع قائمة منتجات بشكل غلط — ما تغيّر شي", 502, "OMS_BAD_RESPONSE");
  }

  const result: ProductSyncResult = {
    received: products.length,
    updated: 0,
    created: 0,
    failed: 0,
    deactivated: 0,
    deactivationSkipped: null,
    errors: [],
  };

  const local = (await db.product.findMany({
    where: { workspaceId: ctx.workspaceId },
    select: { id: true, sku: true, name: true, isActive: true, isArchived: true },
  })) as LocalProduct[];
  const bySku = new Map(local.map((p) => [p.sku, p]));
  const omsCodes = new Set(products.map((p) => p.code).filter(Boolean));
  const kept = new Set<string>();

  for (const p of products) {
    const problem = problemOf(p);
    if (problem) {
      result.failed += 1;
      if (result.errors.length < 10) result.errors.push(problem);
      continue;
    }
    try {
      let match = bySku.get(p.code) ?? null;
      if (!match) {
        // بالاسم بس لمنتج رمزه مش رمز منتج تاني بالـ OMS وما انربط بغيره.
        match =
          local.find((l) => !kept.has(l.id) && !omsCodes.has(l.sku) && sameProductName(l.name, p.name)) ?? null;
      }
      if (match) {
        await db.product.update({ where: { id: match.id }, data: omsFields(p) as never });
        bySku.delete(match.sku);
        bySku.set(p.code, { ...match, sku: p.code });
        kept.add(match.id);
        result.updated += 1;
      } else {
        const created = (await db.product.create({
          data: { workspaceId: ctx.workspaceId, ...omsFields(p), stockStatus: stockFor(p) ?? "IN_STOCK" } as never,
        })) as { id: string };
        kept.add(created.id);
        bySku.set(p.code, { id: created.id, sku: p.code, name: p.name, isActive: true });
        await addToEveryCatalog(db, ctx.workspaceId, created.id);
        result.created += 1;
      }
    } catch (err) {
      result.failed += 1;
      if (result.errors.length < 10) result.errors.push(`المنتج ${p.code}: ما انحفظ`);
      void err;
    }
  }

  if (products.length === 0) result.deactivationSkipped = "EMPTY";
  else if (products.length >= OMS_PRODUCTS_PAGE_LIMIT) result.deactivationSkipped = "PAGE_FULL";
  else if (kept.size === 0) result.deactivationSkipped = "ALL_FAILED";
  else {
    for (const row of local) {
      if (!row.isActive || kept.has(row.id)) continue;
      // منتج رمزه موجود بالـ OMS بس صفّه فشل هالمرة: ما بنوقفه على غلطة مؤقتة.
      if (omsCodes.has(row.sku)) continue;
      await db.product.update({ where: { id: row.id }, data: { isActive: false } });
      result.deactivated += 1;
    }
  }

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "oms.products_synced",
    entityType: "Product",
    entityId: "bulk",
    metadata: {
      received: result.received,
      updated: result.updated,
      created: result.created,
      failed: result.failed,
      deactivated: result.deactivated,
      deactivationSkipped: result.deactivationSkipped,
    },
  });
  await (db as unknown as { omsConnection: { update: (a: unknown) => Promise<unknown> } }).omsConnection
    .update({ where: { workspaceId: ctx.workspaceId }, data: { lastProductSyncAt: new Date() } })
    .catch(() => undefined);
  await noteOmsOk(db, ctx.workspaceId);
  return result;
}
