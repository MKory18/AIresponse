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

/**
 * Pricing for N independent orders created from ONE cart confirmation.
 * Delivery is quoted ONCE on the whole cart subtotal (never charged twice),
 * then allocated to the first independent order only. Item prices still come
 * from the DB rows passed by the caller.
 */
export interface IndependentOrderLine {
  unitPrice: number;
  quantity: number;
  subtotal: number;
  discount: number;
  deliveryFee: number;
  total: number;
  currency: string;
}
export async function calculateIndependentOrdersPricing(
  db: Db,
  params: {
    workspaceId: string;
    items: { price: Prisma.Decimal | number | string; quantity: number; currency: string }[];
    province?: string | null;
  }
): Promise<{ lines: IndependentOrderLine[]; deliveryAvailable: boolean; deliveryReason?: string }> {
  const subtotalCents = params.items.reduce(
    (sum, item) => sum + Math.round(Number(item.price) * 100) * item.quantity,
    0
  );
  const subtotal = subtotalCents / 100;
  const delivery = await quoteDelivery(db, {
    workspaceId: params.workspaceId,
    province: params.province,
    subtotal,
  });
  const feeCents = Math.round(delivery.fee * 100);
  const weights = params.items.map((item) => Math.round(Number(item.price) * 100) * item.quantity);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  // Exact proportional split in integer cents (largest remainder). The sum of
  // every order's delivery share equals the batch fee exactly — never a full
  // fee dumped on the first order, never a duplicated fee.
  const rawShares =
    totalWeight > 0
      ? weights.map((w) => (feeCents * w) / totalWeight)
      : params.items.map(() => feeCents / Math.max(1, params.items.length));
  const shares = rawShares.map((v) => Math.floor(v));
  let remainder = feeCents - shares.reduce((a, b) => a + b, 0);
  const order = rawShares
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && remainder > 0; k += 1) {
    shares[order[k]!.i] += 1;
    remainder -= 1;
  }
  const lines = params.items.map((item, idx) => {
    const lineCents = Math.round(Number(item.price) * 100) * item.quantity;
    const lineFee = shares[idx] ?? 0;
    return {
      unitPrice: Number(item.price),
      quantity: item.quantity,
      subtotal: lineCents / 100,
      discount: 0,
      deliveryFee: lineFee / 100,
      total: (lineCents + lineFee) / 100,
      currency: item.currency,
    };
  });
  return { lines, deliveryAvailable: delivery.available, deliveryReason: delivery.reason };
}

/** Deterministic order summary used by the AI to phrase a message. */
export function formatOrderSummary(params: {  productName: string;
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
