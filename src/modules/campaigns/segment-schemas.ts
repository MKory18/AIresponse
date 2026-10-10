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
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];
