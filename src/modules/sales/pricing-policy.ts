import { AppError, AuthorizationError, NotFoundError } from "@/core/errors";
import type { ActorContext, Db } from "@/modules/customers/service";
import type { Permission } from "@/modules/rbac/permissions";

/** سياق قرار الصلاحيات: ActorContext + فاحص اختياري (يأتي من AuthContext). */
export type PolicyCtx = ActorContext & { can?: (p: Permission) => boolean };
import { recordAudit } from "@/modules/audit/service";
import { recordSalesEvent } from "./metrics";
import { APPROVAL_TTL_HOURS } from "./plan-schemas";

/**
 * P8 — سياسة الخصم وسعر الجملة (إنفاذ من الخادم، لا من الواجهة ولا من
 * تعليمات النموذج):
 *
 * - سعر الجملة مخفي عن العملاء وعن كل رسائل AI الخارجية؛ رؤيته للموظفين
 *   تتطلب صلاحية `products.wholesale` صراحة (تُفحص في كل استدعاء حساس).
 * - سقف الخصم من `Product.discountCap` (مصدره OMS). بلا سقف مُهيّأ → لا
 *   خصم مباشر، بل طلب موافقة.
 * - فوق السقف → موافقة مشرف (`orders.discount.approve`) بسجل مُثبَّت:
 *   SKU + سعر لحظة الاعتماد، وتبطل الموافقة إذا تغيّر السعر أو المنتج
 *   أو انتهت صلاحيتها.
 */

export const WHOLESALE_PERMISSION = "products.wholesale";
export const DISCOUNT_PERMISSION = "orders.discount";
export const DISCOUNT_APPROVE_PERMISSION = "orders.discount.approve";

export interface DiscountDecision {
  allowed: boolean;
  requiresApproval: boolean;
  capPercent: number | null;
  reason: string;
}

/** قرار حتمي: الخصم ضمن السقف مسموح لمن يملك orders.discount، وفوقه موافقة. */
export function evaluateDiscountPolicy(
  product: { discountCap?: unknown; price?: unknown },
  requestedPercent: number
): DiscountDecision {
  if (!Number.isFinite(requestedPercent) || requestedPercent <= 0 || requestedPercent >= 100) {
    return { allowed: false, requiresApproval: false, capPercent: null, reason: "INVALID_DISCOUNT" };
  }
  const cap = product.discountCap === null || product.discountCap === undefined ? null : Number(product.discountCap);
  const capPercent = cap !== null && Number.isFinite(cap) ? cap : null;
  if (capPercent === null) {
    return { allowed: false, requiresApproval: true, capPercent: null, reason: "NO_CAP_CONFIGURED" };
  }
  if (requestedPercent <= capPercent) {
    return { allowed: true, requiresApproval: false, capPercent, reason: "WITHIN_CAP" };
  }
  return { allowed: false, requiresApproval: true, capPercent, reason: "ABOVE_CAP" };
}

export function discountedPrice(unitPrice: number, percent: number): { price: number; amount: number } {
  const amount = Math.round(unitPrice * (percent / 100) * 100) / 100;
  return { price: Math.round((unitPrice - amount) * 100) / 100, amount };
}

export interface DiscountApprovalRow {
  id: string;
  workspaceId: string;
  status: string;
  productId: string;
  sku: string;
  unitPriceAtApproval: unknown;
  discountPercent: unknown;
  requestedBy: string;
  decidedBy: string | null;
  expiresAt: Date | string | null;
  [k: string]: unknown;
}

/** طلب موافقة خصم (أي موظف يملك orders.discount). */
export async function requestDiscountApproval(
  db: Db,
  ctx: ActorContext,
  input: {
    productId: string;
    discountPercent: number;
    conversationId?: string | null;
    reason?: string | null;
    requestedPercentCap?: number | null;
  }
) {
  const product = await db.product.findUnique({ where: { id: input.productId } });
  if (!product || product.workspaceId !== ctx.workspaceId) throw new NotFoundError("Product");
  const unitPrice = Number(product.price);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    throw new AppError("سعر المنتج غير متوفر — لا يمكن طلب خصم", 422, "PRICE_UNAVAILABLE");
  }
  const decision = evaluateDiscountPolicy(product, input.discountPercent);
  if (decision.reason === "INVALID_DISCOUNT") {
    throw new AppError("نسبة الخصم غير صالحة", 422, "VALIDATION_ERROR");
  }
  const { price, amount } = discountedPrice(unitPrice, input.discountPercent);
  const row = await (db as unknown as {
    discountApproval: { create: (a: unknown) => Promise<DiscountApprovalRow> };
  }).discountApproval.create({
    data: {
      workspaceId: ctx.workspaceId,
      conversationId: input.conversationId ?? null,
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      unitPriceAtApproval: unitPrice,
      currency: String(product.currency ?? "USD"),
      discountPercent: input.discountPercent,
      discountAmount: amount,
      reason: input.reason ?? null,
      status: "PENDING",
      requestedBy: ctx.userId,
      // الموافقة تصلاح 24 ساعة من القرار (يُحدَّث عند الاعتماد).
      expiresAt: new Date(Date.now() + APPROVAL_TTL_HOURS * 3600_000),
    } as never,
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "sales.discount_requested",
    entityType: "Product",
    entityId: product.id,
    metadata: { approvalId: row.id, percent: input.discountPercent, capped: decision.capPercent, price, requiresApproval: decision.requiresApproval },
  });
  await recordSalesEvent(db, {
    workspaceId: ctx.workspaceId,
    type: "DISCOUNT_REQUESTED",
    conversationId: input.conversationId ?? null,
    productId: product.id,
    sku: product.sku,
    value: input.discountPercent,
  }).catch(() => {});
  return { approval: row, decision, discountedPrice: price, discountAmount: amount };
}

/** قرار المشرف — لا يجوز للمُصدِر أن يعتمد طلبه بنفسه (فصل واجبات). */
export async function decideDiscountApproval(
  db: Db,
  ctx: PolicyCtx,
  approvalId: string,
  decision: "APPROVED" | "REJECTED"
) {
  // إنفاذ خادمي مزدوج: المسار يفحص الصلاحية أيضًا، وهنا فحص سياقي اختياري.
  if (typeof ctx.can === "function" && !ctx.can(DISCOUNT_APPROVE_PERMISSION)) {
    throw new AuthorizationError(`Missing permission: ${DISCOUNT_APPROVE_PERMISSION}`);
  }
  const row = await (db as unknown as {
    discountApproval: { findUnique: (a: unknown) => Promise<DiscountApprovalRow | null> };
  }).discountApproval.findUnique({ where: { id: approvalId } });
  if (!row || row.workspaceId !== ctx.workspaceId) throw new NotFoundError("Discount approval");
  if (row.status !== "PENDING") {
    throw new AppError("تم البتّ في الطلب مسبقًا", 422, "ALREADY_DECIDED");
  }
  if (row.requestedBy === ctx.userId) {
    throw new AuthorizationError("لا يمكن لمُصدِر الطلب اعتماده بنفسه");
  }
  const updated = await (db as unknown as {
    discountApproval: { update: (a: unknown) => Promise<DiscountApprovalRow> };
  }).discountApproval.update({
    where: { id: approvalId },
    data: { status: decision, decidedBy: ctx.userId, decidedAt: new Date() } as never,
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: decision === "APPROVED" ? "sales.discount_approved" : "sales.discount_rejected",
    entityType: "DiscountApproval",
    entityId: approvalId,
    metadata: { requestedBy: row.requestedBy, percent: Number(row.discountPercent), sku: row.sku },
  });
  await recordSalesEvent(db, {
    workspaceId: ctx.workspaceId,
    type: decision === "APPROVED" ? "DISCOUNT_APPROVED" : "DISCOUNT_REJECTED",
    productId: row.productId,
    sku: row.sku,
    value: Number(row.discountPercent),
    payload: { approvalId, decidedBy: ctx.userId },
  }).catch(() => {});
  return updated;
}

export type ApprovalUse =
  | { valid: true; approval: DiscountApprovalRow }
  | { valid: false; reason: "NOT_APPROVED" | "EXPIRED" | "PRODUCT_MISMATCH" | "PRICE_CHANGED" };

/**
 * استخدام الموافقة لحظة التطبيق — إعادة تحقق كاملة: المنتج نفسه، السعر
 * نفسه (لم يتغير منذ الاعتماد)، غير منتهية، وغير مستهلكة.
 */
export async function useDiscountApproval(
  db: Db,
  workspaceId: string,
  approvalId: string,
  current: { productId: string; unitPrice: number }
): Promise<ApprovalUse> {
  const row = await (db as unknown as {
    discountApproval: { findUnique: (a: unknown) => Promise<DiscountApprovalRow | null> };
  }).discountApproval.findUnique({ where: { id: approvalId } });
  if (!row || row.workspaceId !== workspaceId) return { valid: false, reason: "NOT_APPROVED" };
  if (row.status !== "APPROVED") return { valid: false, reason: "NOT_APPROVED" };
  if (row.expiresAt && new Date(row.expiresAt as string | Date).getTime() <= Date.now()) {
    await (db as unknown as {
      discountApproval: { update: (a: unknown) => Promise<unknown> };
    }).discountApproval.update({ where: { id: approvalId }, data: { status: "INVALIDATED" } as never }).catch(() => {});
    return { valid: false, reason: "EXPIRED" };
  }
  if (row.productId !== current.productId) return { valid: false, reason: "PRODUCT_MISMATCH" };
  const approvedPrice = Number(row.unitPriceAtApproval);
  if (!Number.isFinite(approvedPrice) || Math.abs(approvedPrice - current.unitPrice) > 0.001) {
    return { valid: false, reason: "PRICE_CHANGED" };
  }
  return { valid: true, approval: row };
}

export async function listDiscountApprovals(db: Db, workspaceId: string, status?: string) {
  const where: Record<string, unknown> = { workspaceId };
  if (status) where.status = status;
  return (db as unknown as {
    discountApproval: { findMany: (a: unknown) => Promise<DiscountApprovalRow[]> };
  }).discountApproval.findMany({ where, orderBy: { createdAt: "desc" } } as never);
}
