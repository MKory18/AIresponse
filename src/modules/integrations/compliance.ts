import { z } from "zod";
import { AppError, NotFoundError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { getDecryptedConnection } from "./connections";
import { systemGet } from "./http";

/**
 * P12 — قواعد الادعاءات من سيستم 1 (عقد سيستم 1 IN04):
 *   GET {S1}/api/s1/v1/products/{product_ref}/compliance
 * «نظام الردود بيستخدم نفس القواعد بردوده على الزبائن، فما بينكتب ادعاء
 * ممنوع حتى بالرسائل.» — الممنوع يُرفض من حارس الرد قبل الإرسال، والمسموح
 * يُعطى للموديل كالمصدر الوحيد للادعاءات. compliance.updated ← إعادة قراءة.
 */

const log = childLogger("integrations.compliance");

/** عمر النسخة قبل اعتبارها قديمة (تُعاد قراءتها يوميًا وعند كل تحديث). */
export const COMPLIANCE_STALE_HOURS = 24 * 7;

const complianceSchema = z
  .object({
    product_ref: z.string().min(1).max(64),
    classification: z.string().max(64).nullable().optional(),
    verdict: z.string().max(64).nullable().optional(),
    allowed_claims: z.array(z.string().max(300)).max(100).default([]),
    banned_claims: z.array(z.string().max(300)).max(200).default([]),
    ad_rules: z.array(z.string().max(300)).max(100).default([]),
    updated_at: z.string().max(64).nullable().optional(),
  })
  .passthrough();

type ProductRow = { id: string; workspaceId: string; s1ProductRef?: string | null };

function complianceModel(db: Db) {
  return (db as unknown as {
    productCompliance: {
      findUnique: (a: unknown) => Promise<unknown>;
      upsert: (a: unknown) => Promise<unknown>;
      updateMany: (a: unknown) => Promise<unknown>;
    };
  }).productCompliance;
}

export interface ComplianceView {
  productRef: string;
  classification: string | null;
  verdict: string | null;
  allowedClaims: string[];
  bannedClaims: string[];
  adRules: string[];
  sourceUpdatedAt: string | null;
  fetchedAt: string | null;
  lastError: string | null;
  stale: boolean;
}

type ComplianceRow = {
  productRef: string;
  classification: string | null;
  verdict: string | null;
  allowedClaims: string[];
  bannedClaims: string[];
  adRules: string[];
  sourceUpdatedAt: Date | string | null;
  fetchedAt: Date | string | null;
  lastError: string | null;
};

export function toComplianceView(row: ComplianceRow | null, now = new Date()): ComplianceView | null {
  if (!row) return null;
  const fetched = row.fetchedAt ? new Date(row.fetchedAt) : null;
  return {
    productRef: row.productRef,
    classification: row.classification,
    verdict: row.verdict,
    allowedClaims: row.allowedClaims ?? [],
    bannedClaims: row.bannedClaims ?? [],
    adRules: row.adRules ?? [],
    sourceUpdatedAt: row.sourceUpdatedAt ? new Date(row.sourceUpdatedAt).toISOString() : null,
    fetchedAt: fetched ? fetched.toISOString() : null,
    lastError: row.lastError,
    stale: !fetched || now.getTime() - fetched.getTime() > COMPLIANCE_STALE_HOURS * 3600_000,
  };
}

export async function getProductCompliance(db: Db, productId: string): Promise<ComplianceView | null> {
  try {
    const row = (await complianceModel(db).findUnique({ where: { productId } })) as ComplianceRow | null;
    return toComplianceView(row);
  } catch {
    return null;
  }
}

/** يقرأ قواعد منتج واحد من سيستم 1 ويحفظ نسخة. الفشل يُسجّل ولا يمسح النسخة السابقة. */
export async function refreshProductCompliance(db: Db, workspaceId: string, productId: string): Promise<{ ok: boolean; error?: string }> {
  const product = (await db.product.findUnique({ where: { id: productId } })) as ProductRow | null;
  if (!product || product.workspaceId !== workspaceId) throw new NotFoundError("Product");
  const ref = product.s1ProductRef?.trim();
  if (!ref) return { ok: false, error: "NO_S1_REF" };
  const conn = await getDecryptedConnection(db, workspaceId, "s1");
  if (!conn || !conn.enabled || !conn.baseUrl) return { ok: false, error: "S1_NOT_CONNECTED" };
  const res = await systemGet(conn, `/api/s1/v1/products/${encodeURIComponent(ref)}/compliance`);
  if (!res.ok) {
    const error = res.error ?? `HTTP ${res.status}`;
    await complianceModel(db)
      .updateMany({ where: { productId }, data: { lastError: error.slice(0, 200) } })
      .catch(() => undefined);
    return { ok: false, error };
  }
  const parsed = complianceSchema.safeParse(res.json);
  if (!parsed.success || parsed.data.product_ref !== ref) {
    await complianceModel(db).updateMany({ where: { productId }, data: { lastError: "BAD_RESPONSE" } }).catch(() => undefined);
    return { ok: false, error: "BAD_RESPONSE" };
  }
  const d = parsed.data;
  const sourceUpdatedAt = d.updated_at && !Number.isNaN(new Date(d.updated_at).getTime()) ? new Date(d.updated_at) : null;
  const clean = (arr: string[]) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
  const data = {
    productRef: ref,
    classification: d.classification ?? null,
    verdict: d.verdict ?? null,
    allowedClaims: clean(d.allowed_claims),
    bannedClaims: clean(d.banned_claims),
    adRules: clean(d.ad_rules),
    sourceUpdatedAt,
    fetchedAt: new Date(),
    lastError: null,
  };
  await complianceModel(db).upsert({
    where: { productId },
    create: { workspaceId, productId, ...data },
    update: data,
  });
  await recordAudit(db, {
    workspaceId,
    action: "compliance.refreshed",
    entityType: "Product",
    entityId: productId,
    metadata: { productRef: ref, verdict: data.verdict, banned: data.bannedClaims.length, allowed: data.allowedClaims.length },
  });
  return { ok: true };
}

/** مهمة refresh_product_compliance: {productRef} (من الحدث) أو {productId}. */
export async function refreshComplianceJob(db: Db, workspaceId: string, payload: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const productId = typeof payload.productId === "string" ? payload.productId : null;
  const productRef = typeof payload.productRef === "string" ? payload.productRef : null;
  const products = productId
    ? [{ id: productId }]
    : productRef
      ? ((await db.product.findMany({ where: { workspaceId, s1ProductRef: productRef } as never, select: { id: true } })) as Array<{ id: string }>)
      : [];
  let failed = 0;
  for (const p of products) {
    try {
      const r = await refreshProductCompliance(db, workspaceId, p.id);
      // سيستم 1 واقف: نعيد المحاولة؛ منتج بلا مرجع/اتصال: لا معنى للإعادة.
      if (!r.ok && r.error !== "NO_S1_REF" && r.error !== "S1_NOT_CONNECTED" && r.error !== "BAD_RESPONSE") failed += 1;
    } catch (err) {
      log.warn({ err, productId: p.id }, "compliance_refresh_failed");
      failed += 1;
    }
  }
  return failed > 0 ? { success: false, error: `${failed} product(s) failed` } : { success: true };
}

/** حدث compliance.updated من سيستم 1 ← مهمة إعادة قراءة (لا قراءة داخل الطلب). */
export async function onComplianceUpdated(db: Db, workspaceId: string, eventId: string, data: Record<string, unknown>): Promise<boolean> {
  const ref = typeof data.product_ref === "string" ? data.product_ref.trim() : "";
  if (!ref || ref.length > 64) throw new AppError("product_ref ناقص", 422, "VALIDATION_FAILED");
  const { enqueueJob } = await import("@/modules/jobs/service");
  await enqueueJob(db, {
    workspaceId,
    type: "refresh_product_compliance",
    payload: { productRef: ref },
    idempotencyKey: `compliance:${ref}:${eventId}`,
  });
  return true;
}

/** ربط منتج بمرجعه بسيستم 1 (من شاشة المنتج) ثم قراءة فورية. */
export async function setProductS1Ref(db: Db, ctx: ActorContext, productId: string, ref: string | null): Promise<ComplianceView | null> {
  const product = (await db.product.findUnique({ where: { id: productId } })) as ProductRow | null;
  if (!product || product.workspaceId !== ctx.workspaceId) throw new NotFoundError("Product");
  const value = ref?.trim() || null;
  if (value && !/^[A-Za-z0-9_\-]{2,64}$/.test(value)) throw new AppError("مرجع سيستم 1 غير صالح", 422, "INVALID_S1_REF");
  await db.product.update({ where: { id: productId }, data: { s1ProductRef: value } as never });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "product.s1_ref_set",
    entityType: "Product",
    entityId: productId,
    metadata: { s1ProductRef: value },
  });
  if (value) await refreshProductCompliance(db, ctx.workspaceId, productId).catch(() => undefined);
  return getProductCompliance(db, productId);
}

function normalizeForMatch(text: string): string {
  return text
    .replace(/[ً-ْٰ]/g, "")
    .replace(/ـ/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/** الادعاءات الممنوعة الموجودة بنص (مطابقة بعد تطبيع العربي). */
export function findBannedClaims(text: string, bannedClaims: string[]): string[] {
  if (!text || !bannedClaims?.length) return [];
  const hay = ` ${normalizeForMatch(text)} `;
  const hits: string[] = [];
  for (const claim of bannedClaims) {
    const needle = normalizeForMatch(claim);
    if (needle.length >= 3 && hay.includes(needle)) hits.push(claim);
  }
  return hits;
}
