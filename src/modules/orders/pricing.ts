import type { Prisma } from "@prisma/client";
import type { Db } from "@/modules/customers/service";
import { quoteDelivery } from "./delivery";

export interface PriceBreakdown {
  unitPrice: number;
  quantity: number;
  subtotal: number;
  discount: number;
  deliveryFee: number;
  total: number;
  currency: string;
  deliveryAvailable: boolean;
  deliveryReason?: string;
}

/**
 * PricingService — the ONLY place money is computed.
 * unitPrice always comes from the Product DB row passed in; AI-suggested
 * prices are ignored by the caller design (draft never stores AI prices).
 */
export async function calculatePricing(
  db: Db,
  params: {
    workspaceId: string;
    product: { price: Prisma.Decimal | number | string; currency: string };
    quantity: number;
    province?: string | null;
    discount?: number;
  }
): Promise<PriceBreakdown> {
  const unitPrice = Number(params.product.price);
  // قرش واحد: الحساب بكسور صحيحة (integer cents) لا فواصل عائمة —
  // 0.1×3 = 0.30 بالضبط، والتقريب بيسير مرة وحدة آخر الخط. المبالغ
  // الصحيحة (SYP وأمثالها) بقوا تطابق بت-ببت مع السلوك القديم.
  const subtotalCents = Math.round(unitPrice * 100) * params.quantity;
  const subtotal = subtotalCents / 100;
  const delivery = await quoteDelivery(db, {
    workspaceId: params.workspaceId,
    province: params.province,
    subtotal,
  });
  // الخصم يمرّ بسقف [0, subtotal] — بسالب/كامل ما بيفيد أي مسار محاسبي.
  const discount = Math.min(Math.max(params.discount ?? 0, 0), subtotal);
  const discountCents = Math.round(discount * 100);
  const feeCents = Math.round(delivery.fee * 100);
  return {
    unitPrice,
    quantity: params.quantity,
    subtotal,
    discount,
    deliveryFee: delivery.fee,
    total: (subtotalCents - discountCents + feeCents) / 100,
    currency: params.product.currency,
    deliveryAvailable: delivery.available,
    deliveryReason: delivery.reason,
  };
}

/** Deterministic order summary used by the AI to phrase a message. */
export function formatOrderSummary(params: {
  productName: string;
  quantity: number;
  breakdown: PriceBreakdown;
  phone?: string | null;
  address?: string | null;
  province?: string | null;
  customerName?: string | null;
}): string {
  const b = params.breakdown;
  const lines = [
    `المنتج: ${params.productName}`,
    `الكمية: ${params.quantity}`,
    `السعر: ${b.subtotal} ${b.currency}`,
    `التوصيل: ${b.deliveryFee === 0 ? "مجاني" : `${b.deliveryFee} ${b.currency}`}`,
    `الإجمالي: ${b.total} ${b.currency}`,
  ];
  if (params.customerName) lines.push(`الاسم: ${params.customerName}`);
  if (params.phone) lines.push(`الهاتف: ${params.phone}`);
  if (params.address || params.province) {
    lines.push(`العنوان: ${[params.province, params.address].filter(Boolean).join(" - ")}`);
  }
  return lines.join("\n");
}
