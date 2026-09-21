import { z } from "zod";
import { AIProviderError } from "./provider";
import { INTENTS } from "./prompts";

/** Zod schemas for every AI structured output — untrusted JSON never passes. */

export const intentResultSchema = z.object({
  intent: z.enum(INTENTS as unknown as [string, ...string[]]),
  confidence: z.number().min(0).max(1),
  language: z.string().max(10).optional().default("ar"),
});
export type IntentResult = z.infer<typeof intentResultSchema>;

export const memoryCandidateSchema = z.object({
  type: z.enum(["FACT", "PREFERENCE", "NOTE"]),
  content: z.string().min(3).max(500),
});

export const extractionResultSchema = z.object({
  intent: z.enum(INTENTS as unknown as [string, ...string[]]),
  confidence: z.number().min(0).max(1),
  entities: z
    .object({
      customer_name: z.string().max(200).nullish(),
      phone: z.string().max(32).nullish(),
      address: z.string().max(500).nullish(),
      province: z.string().max(100).nullish(),
      product: z.string().max(200).nullish(),
      product_variant: z.string().max(200).nullish(),
      quantity: z.number().int().min(1).max(1000).nullish(),
      notes: z.string().max(1000).nullish(),
    })
    .default({}),
  missingFields: z.array(z.enum(["phone", "address", "product", "quantity", "name"])).default([]),
  memories: z.array(memoryCandidateSchema).max(5).default([]),
  requestedAction: z.enum(["ANSWER", "CREATE_ORDER", "HANDOFF_HUMAN", "CLARIFY"]).default("ANSWER"),
});
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

export const responsePlanSchema = z.object({
  goal: z.string().max(50),
  needsClarification: z.boolean().default(false),
  missingFields: z.array(z.string().max(30)).default([]),
  sendMedia: z.boolean().default(false),
  useFeedback: z.boolean().default(false),
  knowledgeSources: z.array(z.enum(["product", "faq", "policy", "document", "feedback"])).default([]),
});
export type ResponsePlan = z.infer<typeof responsePlanSchema>;

export const summaryResultSchema = z.object({
  summary: z.string().min(3).max(1000),
});

/**
 * Validate AI JSON with repair semantics: the provider output may be wrapped
 * or slightly malformed — parse/repair happens in parseJsonLoose, then Zod.
 * Anything invalid is rejected here and never reaches the Order Engine.
 */
export function validateStructured<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } },
  raw: unknown
): { ok: true; value: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return { ok: false, error: detail };
}

export { AIProviderError };
