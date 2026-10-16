import { checkSystemUrl } from "@/modules/integrations/connections";
import { AppError } from "@/core/errors";
import { decryptSecret } from "@/core/crypto";
import { runPool } from "@/modules/util/pool";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import type { OmsProduct, OmsCustomer } from "./client";
import { createOmsClient } from "./client";
import type { Prisma } from "@prisma/client";

export interface OmsSyncResult {
  productsSynced: number;
  deliveryRulesSynced: number;
  customersUpdated: number;
}

async function getOmsConnection(db: Db, workspaceId: string) {
  const conn = await (db as any).omsConnection?.findUnique?.({ where: { workspaceId } });
  return conn as
    | { id: string; baseUrl: string; tokenEncrypted: string; isActive: boolean; mode?: string; apiVersion?: string }
    | null;
}

/** Builds an OmsClient for a workspace from the stored (encrypted) connection. */
export async function buildOmsClient(db: Db, workspaceId: string) {
  const conn = await getOmsConnection(db, workspaceId);
  if (!conn || !conn.isActive) {
    throw new AppError("OMS connection not configured", 422, "OMS_NOT_CONFIGURED");
  }
  // P12: الوضع اليدوي = لا باب API بالـ OMS — لا نداء بتوكن بديل.
  if (conn.mode === "manual") {
    throw new AppError("OMS sync needs the OMS API door (connection is in manual mode)", 409, "OMS_MANUAL_MODE");
  }
  // P12: نفس فحص روابط الأنظمة عند كل نداء (رابط داخلي · http عام · اسم صار
  // يشير لعنوان محجوب) = رفض قبل ما يطلع التوكن. رابط خاص قديم (نفس السيرفر)
  // بيحتاج INTEGRATIONS_ALLOW_PRIVATE_NETWORK=1 صريح ببيئة الخادم.
  const check = await checkSystemUrl(conn.baseUrl);
  if (!check.ok) {
    if (check.transient) throw new AppError("تعذر الوصول لاسم الـ OMS (DNS)", 503, "OMS_UNREACHABLE");
    throw new AppError(`رابط الـ OMS مرفوض (${check.reason}) — انرفض النداء`, 422, "OMS_URL_REJECTED");
  }
  return createOmsClient({
    baseUrl: conn.baseUrl,
    token: decryptSecret(conn.tokenEncrypted),
    apiVersion: conn.apiVersion === "v1" ? "v1" : "legacy",
  });
}

/**
 * Syncs products from the OMS. OMS owns: price, offers, complements,
 * discount cap, wholesale price. Local sales fields (objections,
 * salesNotes, ingredients) are NEVER overwritten.
 *
 * P2 safety rules:
 * - Every OMS row is validated before any write (corrupt rows are counted
 *   as failed, never persisted — a bad feed cannot poison prices).
 * - Per-row isolation: one bad row never aborts the whole sync.
 * - Deactivation, never deletion: products previously synced from the OMS
 *   but absent from a SUCCESSFUL non-empty response are set inactive
 *   (stale prices must not be quoted). Local-only products are untouched.
 *   An empty OMS response is INCONCLUSIVE (no deactivation) — an outage
 *   must not wipe the catalog.
 * - Oversized payloads are refused before writing (memory safety).
 */
export interface ProductSyncResult {
  synced: number;
  failed: number;
  deactivated: number;
  errors: string[];
}

const MAX_SYNC_PRODUCTS = 5000;

function isValidOmsProduct(p: OmsProduct): string | null {
  if (!p || typeof p.sku !== "string" || p.sku.trim().length === 0 || p.sku.length > 64) {
    return "invalid sku";
  }
  if (typeof p.name !== "string" || p.name.trim().length === 0 || p.name.length > 200) {
    return `invalid name for sku ${p.sku}`;
  }
  if (typeof p.price !== "number" || !Number.isFinite(p.price) || p.price < 0) {
    return `invalid price for sku ${p.sku}`;
  }
  if (typeof p.currency !== "string" || p.currency.trim().length === 0 || p.currency.length > 8) {
    return `invalid currency for sku ${p.sku}`;
  }
  for (const field of ["wholesalePrice", "discountCap"] as const) {
    const v = p[field];
    if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      return `invalid ${field} for sku ${p.sku}`;
    }
  }
  return null;
}

export async function syncProductsFromOms(db: Db, ctx: ActorContext): Promise<ProductSyncResult> {
  const client = await buildOmsClient(db, ctx.workspaceId);
  const { products } = await client.getProducts();
  if (!Array.isArray(products)) {
    throw new AppError("OMS returned a malformed product list", 502, "OMS_BAD_RESPONSE");
  }
  if (products.length > MAX_SYNC_PRODUCTS) {
    throw new AppError(`OMS product list too large (${products.length}) — refusing blind sync`, 502, "OMS_SYNC_TOO_LARGE");
  }
  const result: ProductSyncResult = { synced: 0, failed: 0, deactivated: 0, errors: [] };
  const seenSkus = new Set<string>();
  for (const p of products) {
    const problem = isValidOmsProduct(p);
    if (problem) {
      result.failed += 1;
      if (result.errors.length < 10) result.errors.push(problem);
      continue;
    }
    try {
      const data: Prisma.ProductUncheckedUpdateInput = {
        syncedFromOms: true,
        price: p.price,
        currency: p.currency,
        offers: (Array.isArray(p.offers) ? p.offers : []) as unknown as Prisma.InputJsonValue,
        complementarySkus: Array.isArray(p.complementarySkus) ? p.complementarySkus.filter((s): s is string => typeof s === "string") : [],
        discountCap: p.discountCap ?? null,
        wholesalePrice: p.wholesalePrice ?? null,
        isActive: true,
      };
      const existing = await db.product.findUnique({
        where: { workspaceId_sku: { workspaceId: ctx.workspaceId, sku: p.sku } },
      });
      if (existing) {
        await db.product.update({ where: { id: existing.id }, data });
      } else {
        await db.product.create({
          data: {
            workspaceId: ctx.workspaceId,
            sku: p.sku,
            name: p.name,
            ...data,
          } as Prisma.ProductUncheckedCreateInput,
        });
      }
      seenSkus.add(p.sku);
      result.synced += 1;
    } catch (err) {
      result.failed += 1;
      if (result.errors.length < 10) {
        result.errors.push(`sku ${p.sku}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // Deactivate stale OMS products only on a conclusive (non-empty) sync.
  if (products.length > 0) {
    const stale = await db.product.findMany({
      where: { workspaceId: ctx.workspaceId, syncedFromOms: true, isActive: true },
      select: { id: true, sku: true },
    });
    for (const row of stale) {
      if (!seenSkus.has(row.sku)) {
        await db.product.update({ where: { id: row.id }, data: { isActive: false } });
        result.deactivated += 1;
      }
    }
  }
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "oms.products_synced",
    entityType: "Product",
    entityId: "bulk",
    metadata: { synced: result.synced, failed: result.failed, deactivated: result.deactivated, errors: result.errors },
  });
  // Best-effort observability timestamp (never breaks the sync).
  try {
    await (db as any).omsConnection?.update?.({
      where: { workspaceId: ctx.workspaceId },
      data: { lastProductSyncAt: new Date() },
    });
  } catch { /* observability only */ }
  return result;
}

/**
 * Blacklist sync by phone — OMS is the source of truth for the blacklist.
 *
 * P2 conflict policy (documented): OMS `true` always blacklists (source OMS).
 * OMS `false`/missing un-blacklists ONLY rows the OMS blacklisted before —
 * a manual/local block is never silently lifted by a sync. Unknown phones
 * (no local row) are skipped, never created (no customer fabrication).
 */
export interface CustomerSyncResult {
  updated: number;
  skipped: number;
}

export async function syncCustomersFromOms(db: Db, ctx: ActorContext, phones: string[]): Promise<CustomerSyncResult> {
  const client = await buildOmsClient(db, ctx.workspaceId);
  const result: CustomerSyncResult = { updated: 0, skipped: 0 };
  // OCR-2026-10-16 (أداء): 500 نداء متسلسل كانوا دقائق — تجميع محدود
  // التوازي (8) بنفس الدلالة: فشل النداء يقفل المزامنة كلها (سلوك مثبت).
  let firstError: unknown = null;
  await runPool(phones, 8, async (phone) => {
    if (firstError !== null) return; // أعطال سابقة: ما عاد نداءات جديدة
    const omsCustomer: OmsCustomer | null = await client.getCustomer(phone);
    if (!omsCustomer) {
      result.skipped += 1;
      return;
    }
    const existing = await db.customer.findUnique({
      where: { workspaceId_phone: { workspaceId: ctx.workspaceId, phone } },
    });
    if (!existing) {
      result.skipped += 1;
      return;
    }
    const row = existing as { isBlacklisted?: boolean; blacklistSource?: string | null };
    if (omsCustomer.isBlacklisted) {
      await db.customer.update({
        where: { id: existing.id },
        data: { isBlacklisted: true, blacklistSource: "OMS" },
      });
      result.updated += 1;
    } else if (row.blacklistSource === "OMS" || row.isBlacklisted !== true) {
      // Only OMS-owned blocks are lifted; manual blocks survive the sync.
      await db.customer.update({
        where: { id: existing.id },
        data: { isBlacklisted: false, blacklistSource: null },
      });
      result.updated += 1;
    } else {
      result.skipped += 1;
    }
  }).catch((err) => {
    firstError ??= err;
  });
  if (firstError !== null) throw firstError;
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "oms.customers_synced",
    entityType: "Customer",
    entityId: "bulk",
    metadata: { updated: result.updated, skipped: result.skipped },
  });
  try {
    await (db as any).omsConnection?.update?.({
      where: { workspaceId: ctx.workspaceId },
      data: { lastCustomerSyncAt: new Date() },
    });
  } catch { /* observability only */ }
  return result;
}

/**
 * Upserts the OMS connection for a workspace (token stored encrypted).
 * @deprecated P12 — المسار يستخدم saveOmsConnection (connection.ts) بالحقول الجديدة.
 */
export async function upsertOmsConnection(
  db: Db,
  ctx: ActorContext,
  input: { baseUrl: string; token: string; isActive?: boolean }
) {
  const tokenEncrypted = (await import("@/core/crypto")).encryptSecret(input.token);
  const row = await (db as any).omsConnection.upsert({
    where: { workspaceId: ctx.workspaceId },
    create: {
      workspaceId: ctx.workspaceId,
      baseUrl: input.baseUrl,
      tokenEncrypted,
      isActive: input.isActive ?? true,
    },
    update: {
      baseUrl: input.baseUrl,
      tokenEncrypted,
      isActive: input.isActive ?? true,
    },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "oms.connection_saved",
    entityType: "OmsConnection",
    entityId: row.id,
    metadata: { baseUrl: input.baseUrl },
  });
  return row;
}
