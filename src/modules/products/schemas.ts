import { z } from "zod";

const decimalString = z.union([z.number(), z.string()]).transform((v) => String(v));

export const productInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(64),
  description: z.string().max(10000).nullable().optional(),
  shortDescription: z.string().max(500).nullable().optional(),
  price: decimalString,
  compareAtPrice: decimalString.nullable().optional(),
  currency: z.string().trim().min(3).max(3).optional(),
  stockStatus: z.enum(["IN_STOCK", "OUT_OF_STOCK", "PRE_ORDER", "DISCONTINUED"]).optional(),
  stockQty: z.number().int().min(0).max(1_000_000).optional(),
  category: z.string().trim().max(100).nullable().optional(),
  tags: z.array(z.string().trim().max(50)).max(30).optional(),
  benefits: z.array(z.string().trim().max(300)).max(20).optional(),
  ingredients: z.string().max(5000).nullable().optional(),
  usage: z.string().max(5000).nullable().optional(),
  warnings: z.string().max(5000).nullable().optional(),
  objections: z.array(z.string().trim().max(500)).max(30).optional(),
  salesNotes: z.string().max(10000).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const productUpdateSchema = productInputSchema.partial().extend({
  isArchived: z.boolean().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

export const listParamsSchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive", "archived", "all"]).optional(),
  productId: z.string().cuid().optional(),
  type: z.enum(["IMAGE", "VIDEO", "AUDIO", "DOCUMENT"]).optional(),
  sentiment: z.string().trim().max(30).optional(),
  approved: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),
  archived: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),
  status2: z.string().optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const mediaUpdateSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().trim().max(50)).max(30).optional(),
  category: z.enum(["PRODUCT", "FEEDBACK", "TESTIMONIAL", "BRAND", "EDUCATIONAL", "OTHER"]).optional(),
  productId: z.string().cuid().nullable().optional(),
});

export const feedbackInputSchema = z.object({
  kind: z.enum(["TEXT", "IMAGE", "VIDEO", "AUDIO", "SCREENSHOT"]).optional(),
  productId: z.string().cuid().nullable().optional(),
  customerId: z.string().cuid().nullable().optional(),
  mediaId: z.string().cuid().nullable().optional(),
  content: z.string().max(10000).nullable().optional(),
  customerSegment: z.string().trim().max(100).nullable().optional(),
  source: z.string().trim().max(200).nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  sentiment: z.string().trim().max(30).nullable().optional(),
  tags: z.array(z.string().trim().max(50)).max(30).optional(),
});

export const feedbackUpdateSchema = feedbackInputSchema.partial().extend({
  isApproved: z.boolean().optional(),
  isArchived: z.boolean().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

export const knowledgeCreateSchema = z.object({
  title: z.string().trim().min(2).max(200),
  content: z.string().min(1).max(500_000),
  category: z.enum(["PRODUCT", "FAQ", "POLICY", "DELIVERY", "PAYMENT", "COMPANY", "DOCUMENT", "CUSTOM"]).optional(),
  sourceType: z.string().trim().max(50).optional(),
  sourceUrl: z.string().url().max(2048).nullable().optional(),
});

export const knowledgeUpdateSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  content: z.string().min(1).max(500_000).optional(),
  category: z.enum(["PRODUCT", "FAQ", "POLICY", "DELIVERY", "PAYMENT", "COMPANY", "DOCUMENT", "CUSTOM"]).optional(),
  isActive: z.boolean().optional(),
});

export const faqCreateSchema = z.object({
  question: z.string().trim().min(2).max(500),
  answer: z.string().trim().min(1).max(5000),
  category: z.string().trim().max(100).nullable().optional(),
  productId: z.string().cuid().nullable().optional(),
  tags: z.array(z.string().trim().max(50)).max(20).optional(),
});

export const faqUpdateSchema = z.object({
  question: z.string().trim().min(2).max(500).optional(),
  answer: z.string().trim().min(1).max(5000).optional(),
  category: z.string().trim().max(100).nullable().optional(),
  isActive: z.boolean().optional(),
  tags: z.array(z.string().trim().max(50)).max(20).optional(),
});

export const productMediaActionSchema = z.object({
  mediaAssetId: z.string().cuid(),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});
