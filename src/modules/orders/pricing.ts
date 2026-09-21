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
  const subtotal = unitPrice * params.quantity;
  const delivery = await quoteDelivery(db, {
    workspaceId: params.workspaceId,
    province: params.province,
    subtotal,
  });
  const discount = params.discount ?? 0;
  return {
    unitPrice,
    quantity: params.quantity,
    subtotal,
    discount,
    deliveryFee: delivery.fee,
    total: subtotal - discount + delivery.fee,
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
