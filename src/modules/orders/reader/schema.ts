import { z } from "zod";

/**
 * مخطط ما بيرجّعه «قارئ الطلب» (02-ORDER-FLOW §7.4). الموديل بيقترح فقط —
 * `verify.ts` هو اللي بيقرر شو بيدخل الطلب فعلًا.
 */
const evidenceIds = z.array(z.string().max(8)).max(6).default([]);

export const orderReadingSchema = z.object({
  intent: z.enum(["NONE", "INTERESTED", "ORDERING", "CANCELLED"]),
  relation: z.enum(["NEW", "AMEND_LAST", "NONE"]).default("NONE"),
  items: z
    .array(
      z.object({
        productRef: z.string().trim().min(1).max(200),
        quantity: z.number().int().min(1).max(1000).nullable(),
        evidence: evidenceIds,
      })
    )
    .max(20)
    .default([]),
  customer: z.object({
    name: z.string().max(200).nullable(),
    phone: z.string().max(40).nullable(),
    altPhone: z.string().max(40).nullable(),
    city: z.string().max(100).nullable(),
    address: z.string().max(500).nullable(),
    evidence: z.record(z.array(z.string().max(8)).max(6)).default({}),
  }),
  agreement: z.object({
    state: z.enum(["EXPLICIT", "IMPLICIT", "NONE", "DECLINED"]),
    evidence: z.array(z.string().max(8)).max(4).default([]),
  }),
  cancelRequested: z.boolean().default(false),
  notes: z.string().max(500).nullable().default(null),
  openQuestions: z.array(z.string().max(200)).max(5).default([]),
  aiClaimedConfirmed: z.boolean().default(false),
  needsHuman: z
    .object({
      value: z.boolean(),
      reason: z.enum(["CUSTOMER_REQUEST", "COMPLAINT", "PAYMENT_ISSUE", "OTHER"]).nullable(),
    })
    .default({ value: false, reason: null }),
  memories: z
    .array(z.object({ type: z.enum(["FACT", "PREFERENCE", "NOTE"]), content: z.string().min(3).max(500) }))
    .max(5)
    .default([]),
  confidence: z.number().min(0).max(1),
});

export type OrderReading = z.infer<typeof orderReadingSchema>;

/** مدقّق على شكل `StructuredRequest.validate` — بيرجّع نص الخطأ لإعادة المحاولة. */
export function validateOrderReading(raw: unknown): { ok: true; value: OrderReading } | { ok: false; error: string } {
  const parsed = orderReadingSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; "),
  };
}
