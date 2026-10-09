import { AppError } from "@/core/errors";
import { decryptSecret } from "@/core/crypto";
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
    | { id: string; baseUrl: string; tokenEncrypted: string; isActive: boolean }
    | null;
}

/** Builds an OmsClient for a workspace from the stored (encrypted) connection. */
export async function buildOmsClient(db: Db, workspaceId: string) {
  const conn = await getOmsConnection(db, workspaceId);
  if (!conn || !conn.isActive) {
    throw new AppError("OMS connection not configured", 422, "OMS_NOT_CONFIGURED");
  }
  return createOmsClient({ baseUrl: conn.baseUrl, token: decryptSecret(conn.tokenEncrypted) });
}

/**
 * Syncs products from the OMS. OMS owns: price, offers, complements,
 * discount cap, wholesale price. Local sales fields (objections,
 * salesNotes, ingredients) are NEVER overwritten.
 */
export async function syncProductsFromOms(db: Db, ctx: ActorContext): Promise<number> {
  const client = await buildOmsClient(db, ctx.workspaceId);
  const { products } = await client.getProducts();
  let count = 0;
  for (const p of products) {
    const data: Prisma.ProductUncheckedUpdateInput = {
      syncedFromOms: true,
      price: p.price,
      currency: p.currency,
      offers: (p.offers ?? []) as unknown as Prisma.InputJsonValue,
      complementarySkus: p.complementarySkus ?? [],
      discountCap: p.discountCap ?? null,
      wholesalePrice: p.wholesalePrice ?? null,
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
    count += 1;
  }
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "oms.products_synced",
    entityType: "Product",
    entityId: "bulk",
    metadata: { count },
  });
  return count;
}

/** Blacklist sync by phone — OMS is the source of truth for the blacklist. */
export async function syncCustomersFromOms(db: Db, ctx: ActorContext, phones: string[]): Promise<number> {
  const client = await buildOmsClient(db, ctx.workspaceId);
  let updated = 0;
  for (const phone of phones) {
    const omsCustomer: OmsCustomer | null = await client.getCustomer(phone);
    if (!omsCustomer) continue;
    const existing = await db.customer.findUnique({
      where: { workspaceId_phone: { workspaceId: ctx.workspaceId, phone } },
    });
    if (!existing) continue;
    await db.customer.update({
      where: { id: existing.id },
      data: {
        isBlacklisted: omsCustomer.isBlacklisted ?? false,
        blacklistSource: omsCustomer.isBlacklisted ? "OMS" : null,
      },
    });
    updated += 1;
  }
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "oms.customers_synced",
    entityType: "Customer",
    entityId: "bulk",
    metadata: { updated },
  });
  return updated;
}

/** Upserts the OMS connection for a workspace (token stored encrypted). */
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
