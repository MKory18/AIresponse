import { z } from "zod";

/**
 * P9 — تعريف شريحة الجمهور: مجموعة مغلقة من عوامل التصفية الآمنة.
 * لا SQL ولا تعابير نصية ولا كود ينفَّذ — كل شرط حتمي على حقول موثوقة
 * (Customer/Conversation/Order) داخل مساحة العمل صاحبة الشريحة.
 */

export const SEGMENT_VERSION = 1;

const cmp = z.enum(["EQ", "IN"]);
const strVal = z.union([z.string(), z.array(z.string())]);
const days = z.number().int().min(1).max(365);

/** عمليات المقارنة المسماة فقط (لا تعابير حرة). */
export const segmentConditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("customer.tags"), op: cmp, value: strVal }).strict(),
  z.object({ field: z.literal("customer.status"), op: cmp, value: strVal }).strict(),
  z.object({ field: z.literal("customer.adSource"), op: cmp, value: strVal }).strict(),
  z.object({ field: z.literal("customer.marketingConsent"), op: z.enum(["EQ"]), value: z.enum(["UNKNOWN", "OPTED_IN", "OPTED_OUT"]) }).strict(),
  z.object({ field: z.literal("customer.lastContact"), op: z.enum(["WITHIN_DAYS", "OLDER_THAN_DAYS"]), days }).strict(),
  z.object({ field: z.literal("customer.language"), op: cmp, value: strVal }).strict(),
  z.object({ field: z.literal("orders.hasAny"), op: z.enum(["EQ"]), value: z.boolean() }).strict(),
  z.object({ field: z.literal("orders.status"), op: cmp, value: strVal }).strict(),
  z.object({ field: z.literal("conversation.lastCustomerMessage"), op: z.enum(["WITHIN_DAYS", "OLDER_THAN_DAYS"]), days }).strict(),
  z.object({ field: z.literal("conversation.noReply"), op: z.enum(["EQ"]), value: z.boolean() }).strict(),
  // P12 — شرائح الكليبر (عقد الكليبر IN03/LG07) — إضافات مغلقة بنفس الأسلوب:
  // راسل برمز خلال [minDays, maxDays] يوم (رمز معيّن/بادئة/أي رمز صالح).
  z.object({
    field: z.literal("attribution.code"),
    op: z.enum(["ANY", "EQ", "PREFIX"]),
    value: z.string().regex(/^[A-Z0-9]{1,12}$/).optional(),
    minDays: z.number().int().min(0).max(90),
    maxDays: z.number().int().min(1).max(90),
    // رمز منتج معيّن (من تحقق الكليبر) — شريحة منتج مش «أي رمز».
    productCode: z.string().regex(/^[A-Za-z0-9_\-]{1,64}$/).optional(),
  }).strict(),
  // ما طلب خلال آخر N يوم.
  z.object({ field: z.literal("orders.noneWithinDays"), op: z.enum(["EQ"]), days }).strict(),
  // عنده طلب بحالة من القائمة تغيّرت خلال [minDays, maxDays] (انلغى قبل الشحن · استلم من 30 يوم).
  z.object({
    field: z.literal("orders.statusBetweenDays"),
    op: z.enum(["IN"]),
    value: z.array(z.string()).min(1).max(9),
    minDays: z.number().int().min(0).max(365),
    maxDays: days,
    // طلب فيه هالمنتج بالذات (معرّف المنتج بالردود).
    productId: z.string().min(1).max(64).optional(),
  }).strict(),
  // سقف التكرار: ما وصلته رسالة حملة خلال آخر N يوم.
  z.object({ field: z.literal("campaign.notReceivedWithinDays"), op: z.enum(["EQ"]), days }).strict(),
]);
export type SegmentCondition = z.infer<typeof segmentConditionSchema>;

/** المجموع: كل الشروط أو بعضها — بلا تعشيق حر يسمح بتعقيد غير قابل للتدقيق. */
export const segmentDefinitionSchema = z
  .object({
    version: z.literal(SEGMENT_VERSION),
    match: z.enum(["ALL", "ANY"]),
    conditions: z.array(segmentConditionSchema).min(1).max(10),
  })
  .strict();
export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>;

export const segmentCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    definition: segmentDefinitionSchema,
  })
  .strict();

export const segmentUpdateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    definition: segmentDefinitionSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

/** توزيع أسباب الاستبعاد — فئات مغلقة فقط (أرقام من DB). */
export const EXCLUSION_REASONS = [
  "BLACKLISTED",
  "NO_CONSENT",
  "OPTED_OUT",
  "NO_CHANNEL_CONTACT",
  "CHANNEL_NOT_READY",
  "NO_CONVERSATION_ALLOWED",
  "TEMPLATE_REQUIRED",
  // P12 — سقف التكرار (وصلته رسالة حملة خلال المدة المحددة).
  "FREQUENCY_CAP",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];
