import { z } from "zod";

/**
 * P8 — Sales Intelligence: خطة البيع بنية بيانات متحقق منها.
 *
 * الفصل الصارم: كل رقم في الخطة صادر من قاعدة البيانات/قواعد المجال
 * (المنتج، عروض OMS، سقف الخصم) — النموذج يصيغ اللغة فقط. المخطط صارم
 * (`.strict()`) بأعداد محسوبة، وأي صف عرض تالف يُهمل ولا يُخترع.
 */

export const SALES_PLAN_VERSION = 1;

/** الحد الأقصى لضغط العرض نفسه في المحادثة (سياسة مضادة للإلحاح). */
export const MAX_OFFER_PRESSES = 2;
/** الحد الأقصى لعدد المنتجات المكملة في خطة واحدة. */
export const MAX_CROSS_SELL = 2;
/** صلاحية الموافقة على الخصم (ساعات) — بعدها تُبطل. */
export const APPROVAL_TTL_HOURS = 24;

/** مواضيع الاعتراض المعروفة (تصنيف حتمي بالكلمات المفتاحية). */
export const OBJECTION_TOPICS = [
  "PRICE_HIGH",
  "HESITANT",
  "COMPARISON",
  "QUANTITY",
  "WANT_DIFFERENT",
  "NOT_READY",
] as const;
export type ObjectionTopic = (typeof OBJECTION_TOPICS)[number];

export const PRIMARY_SOURCES = ["PRODUCT_DB", "OMS_SYNC"] as const;

export const salesPrimarySchema = z
  .object({
    productId: z.string().min(1),
    sku: z.string().min(1),
    name: z.string().min(1).max(300),
    unitPrice: z.number().finite().positive(),
    currency: z.string().min(1).max(10),
    quantity: z.number().int().min(1).max(1000).default(1),
    subtotal: z.number().finite().nonnegative(),
    stockStatus: z.string().min(1).max(30),
    source: z.enum(PRIMARY_SOURCES),
  })
  .strict();
export type SalesPrimary = z.infer<typeof salesPrimarySchema>;

export const salesUpsellSchema = z
  .object({
    productId: z.string().min(1),
    sku: z.string().min(1),
    title: z.string().min(1).max(300),
    quantity: z.number().int().min(1),
    price: z.number().finite().positive(),
    /** التوفير محسوب حتميًا: unitPrice×quantity − offerPrice (متحقق > 0). */
    saving: z.number().finite().positive(),
    currency: z.string().min(1).max(10),
    remainingQty: z.number().int().min(0).nullable(),
  })
  .strict();
export type SalesUpsell = z.infer<typeof salesUpsellSchema>;

export const salesCrossSellSchema = z
  .object({
    productId: z.string().min(1),
    sku: z.string().min(1),
    name: z.string().min(1).max(300),
    unitPrice: z.number().finite().positive(),
    currency: z.string().min(1).max(10),
    source: z.enum(PRIMARY_SOURCES),
  })
  .strict();
export type SalesCrossSell = z.infer<typeof salesCrossSellSchema>;

export const salesObjectionSchema = z
  .object({
    topic: z.enum(OBJECTION_TOPICS),
    /** هل يوجد رد موثوق (من بيانات المنتج المحلية) لهذا الاعتراض؟ */
    trustedAnswerAvailable: z.boolean(),
  })
  .strict();
export type SalesObjection = z.infer<typeof salesObjectionSchema>;

export const salesDiscountSchema = z
  .object({
    percent: z.number().finite().min(0).max(100),
    basePrice: z.number().finite().positive(),
    discountedPrice: z.number().finite().nonnegative(),
    amount: z.number().finite().nonnegative(),
    capPercent: z.number().finite().min(0).max(100).nullable(),
    requiresApproval: z.boolean(),
  })
  .strict();
export type SalesDiscount = z.infer<typeof salesDiscountSchema>;

export const salesPlanSchema = z
  .object({
    version: z.literal(SALES_PLAN_VERSION),
    intent: z.string().max(50),
    primary: salesPrimarySchema.nullable(),
    upsell: salesUpsellSchema.nullable(),
    crossSell: z.array(salesCrossSellSchema).max(MAX_CROSS_SELL),
    objection: salesObjectionSchema.nullable(),
    discount: salesDiscountSchema.nullable(),
    /** لماذا لا يوجد عرض (لا يُخترع سبب). */
    noOfferReason: z.string().max(60).nullable(),
    constraints: z.array(z.string().max(60)).max(10),
    /** داخلي للموظف فقط — لا يغادر الخادم إلى النموذج الخارجي. */
    internalOnly: z.boolean().default(false),
  })
  .strict();
export type SalesPlan = z.infer<typeof salesPlanSchema>;

/** صف عرض من بيانات OMS المتزامنة (فك ترميز آمن — الصفوف التالفة تُهمل). */
export const productOfferSchema = z
  .object({
    title: z.string().min(1).max(300),
    quantity: z.number().int().min(1).max(1000),
    price: z.number().finite().positive(),
    saving: z.number().finite().min(0).nullable().optional(),
    remainingQty: z.number().int().min(0).nullable().optional(),
    expiresAt: z.string().nullable().optional(),
  })
  .strict();
export type ProductOffer = z.infer<typeof productOfferSchema>;

/** أسباب عدم تقديم عرض (مجموعة مغلقة — لا نصوص حرة). */
export const NO_OFFER_REASONS = [
  "NO_PRODUCT",
  "PRICE_UNAVAILABLE",
  "PRODUCT_UNAVAILABLE",
  "NO_VALID_OFFERS",
  "OFFER_EXPIRED",
  "OFFER_NOT_WORTHWHILE",
  "OFFER_PRESSED_OUT",
  "OFFER_DECLINED_BY_CUSTOMER",
  "NOT_A_BUYING_CONTEXT",
  "HUMAN_ACTIVE",
] as const;
export type NoOfferReason = (typeof NO_OFFER_REASONS)[number];

/** تصنيف نية الخصم — مواضيع الاعتراض مرتبطة بأسباب آمنة فقط. */
export function objectionReason(topic: ObjectionTopic): string {
  return `OBJECTION:${topic}`;
}
