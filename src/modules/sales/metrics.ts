import type { Prisma } from "@prisma/client";
import type { Db } from "@/modules/customers/service";

/**
 * P8 — أحداث البيع (قياس منفصل عن الإجراء): اقتراح ≠ أُرسل ≠ قَبِل ≠ طلب.
 * التسجيل لا يفشل العملية أبدًا (best-effort، مفهرس للتحليل).
 */

export type DbClient = Db | Prisma.TransactionClient;

export interface SalesEventInput {
  workspaceId: string;
  type:
    | "OFFER_QUALIFIED" | "OFFER_SHOWN" | "OFFER_ACCEPTED"
    | "CROSS_SELL_SHOWN" | "CROSS_SELL_ADDED"
    | "COACH_USED"
    | "DISCOUNT_REQUESTED" | "DISCOUNT_APPROVED" | "DISCOUNT_REJECTED";
  conversationId?: string | null;
  customerId?: string | null;
  orderId?: string | null;
  productId?: string | null;
  sku?: string | null;
  value?: number | null;
  payload?: Record<string, unknown>;
}

export async function recordSalesEvent(db: DbClient, ev: SalesEventInput): Promise<void> {
  await (db as unknown as {
    salesEvent: { create: (a: unknown) => Promise<unknown> };
  }).salesEvent.create({
    data: {
      workspaceId: ev.workspaceId,
      type: ev.type,
      conversationId: ev.conversationId ?? null,
      customerId: ev.customerId ?? null,
      orderId: ev.orderId ?? null,
      productId: ev.productId ?? null,
      sku: ev.sku ?? null,
      value: ev.value ?? null,
      payload: (ev.payload ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/** كم مرة ضُغط العرض نفسه في هذه المحادثة (سقف سياسة الإلحاح). */
export async function offerShownCount(
  db: DbClient,
  workspaceId: string,
  conversationId: string,
  sku: string
): Promise<number> {
  const n = await (db as unknown as {
    salesEvent: { count: (a: unknown) => Promise<number> };
  }).salesEvent.count({
    where: {
      workspaceId,
      conversationId,
      type: "OFFER_SHOWN",
      sku,
    },
  });
  return Number(n ?? 0);
}

/** رفض العميل العرض؟ (ذاكرة العميل — يوقف الإلحاح نهائيًا للـ SKU). */
export async function hasOfferDeclined(
  db: DbClient,
  workspaceId: string,
  conversationId: string,
  sku: string
): Promise<boolean> {
  const n = await (db as unknown as {
    salesEvent: { count: (a: unknown) => Promise<number> };
  }).salesEvent.count({
    where: {
      workspaceId,
      conversationId,
      type: "OFFER_QUALIFIED",
      sku,
      payload: { path: ["declined"], equals: true },
    },
  }).catch(() => 0);
  if (Number(n) > 0) return true;
  // المسار البديل: حدث صريح بلا فلتر Json (توافق مع الـ stub الاختباري).
  const rows = await (db as unknown as {
    salesEvent: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> };
  }).salesEvent.findMany({
    where: { workspaceId, conversationId, sku, type: { in: ["OFFER_QUALIFIED", "OFFER_SHOWN"] } },
  }).catch(() => [] as Array<Record<string, unknown>>);
  return rows.some((r) => (r.payload as Record<string, unknown> | null)?.declined === true);
}

// ── التحليلات (قسم 12) — تعريفات موثقة وقابلة للحساب اليدوي ─────────────

export interface SalesAnalytics {
  offersQualified: number;
  offersShown: number;
  /** OFFER_ACCEPTED / OFFER_SHOWN — يُسجل القبول فقط عند طلب مؤكد بكمية ≥ كمية العرض لنفس SKU. */
  offerAcceptRate: number | null;
  crossSellShown: number;
  /** طلبات أُضيف إليها منتج مُقترح سابقًا (CROSS_SELL_ADDED). */
  crossSellAdded: number;
  coachUsage: number;
  discountRequests: number;
  discountApproved: number;
  discountRejected: number;
}

export async function getSalesAnalytics(
  db: DbClient,
  workspaceId: string,
  range?: { from?: Date; to?: Date }
): Promise<SalesAnalytics> {
  const where: Record<string, unknown> = { workspaceId };
  if (range?.from || range?.to) {
    where.createdAt = {
      ...(range.from ? { gte: range.from } : {}),
      ...(range.to ? { lte: range.to } : {}),
    };
  }
  const model = (db as unknown as {
    salesEvent: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> };
  }).salesEvent;
  const rows = await model.findMany({ where });
  const count = (t: string) => rows.filter((r) => r.type === t).length;
  const shown = count("OFFER_SHOWN");
  const accepted = count("OFFER_ACCEPTED");
  return {
    offersQualified: count("OFFER_QUALIFIED"),
    offersShown: shown,
    offerAcceptRate: shown > 0 ? Math.round((accepted / shown) * 10000) / 10000 : null,
    crossSellShown: count("CROSS_SELL_SHOWN"),
    crossSellAdded: count("CROSS_SELL_ADDED"),
    coachUsage: count("COACH_USED"),
    discountRequests: count("DISCOUNT_REQUESTED"),
    discountApproved: count("DISCOUNT_APPROVED"),
    discountRejected: count("DISCOUNT_REJECTED"),
  };
}
