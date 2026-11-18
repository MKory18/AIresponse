import type { AIProvider } from "@/modules/ai/provider";
import { sendProtectedStructured, type CustomerPII } from "@/modules/ai/privacy-gate";
import { PROMPT_VERSIONS, READER_SYSTEM_PROMPT, buildReaderUserPrompt } from "./prompt";
import { validateOrderReading, type OrderReading } from "./schema";
import { buildTranscript, type RawTranscriptMessage, type Transcript } from "./transcript";
import { verifyReading, type VerifiedReading, type VerifyContext } from "./verify";

/**
 * القارئ النقي (الحزمة 1.2): من قائمة رسائل لـ `VerifiedReading` — بلا كتابة
 * بالقاعدة وبلا طابور. المزوّد بيجي من برّا (مزوّد المساحة نفسه) والنداء
 * دايمًا من `sendProtectedStructured` (الأرقام بتصير [PII-n] وبترجع محليًا).
 * ممنوع: `provider.generateStructured` مباشرة · `getExtractionProvider()`.
 */
export interface ReadConversationInput {
  provider: AIProvider;
  /** نموذج المهمة (من `resolveModel(settings, "EXTRACTION")`) أو undefined للافتراضي. */
  model?: string;
  messages: RawTranscriptMessage[];
  pageName: string;
  /** YYYY-MM-DD */
  date: string;
  timeZone?: string;
  previousOrderSummary?: string | null;
  /** بيانات العميل المعروفة — بتتعتّم قبل ما يطلع النص لمزوّد خارجي. */
  pii?: CustomerPII;
  /** باقي سياق التحقق (messages بتنبني من الـ transcript). */
  verify: Omit<VerifyContext, "messages">;
}

export interface ReadConversationResult {
  verified: VerifiedReading;
  raw: OrderReading;
  transcript: Transcript;
  promptVersion: string;
  usage: { promptTokens?: number; completionTokens?: number; model?: string; latencyMs?: number };
}

export const READER_TEMPERATURE = 0;
export const READER_MAX_TOKENS = 900;
export const READER_TIMEOUT_MS = 30_000;

export async function readConversation(input: ReadConversationInput): Promise<ReadConversationResult> {
  const transcript = buildTranscript(input.messages, { timeZone: input.timeZone });
  const user = buildReaderUserPrompt({
    pageName: input.pageName,
    market: input.verify.market,
    date: input.date,
    productNames: input.verify.products.map((p) => p.name),
    required: input.verify.required,
    previousOrderSummary: input.previousOrderSummary ?? null,
    transcriptLines: transcript.lines,
  });

  const res = await sendProtectedStructured<OrderReading>(
    input.provider,
    {
      system: READER_SYSTEM_PROMPT,
      user,
      model: input.model,
      temperature: READER_TEMPERATURE,
      maxTokens: READER_MAX_TOKENS,
      timeoutMs: READER_TIMEOUT_MS,
      validate: validateOrderReading,
    },
    { pii: input.pii, purpose: "ORDER_READ" }
  );

  const verified = verifyReading(res.value, { ...input.verify, messages: transcript.messages });
  const meta = res as unknown as { promptTokens?: number; completionTokens?: number; model?: string; latencyMs?: number };
  return {
    verified,
    raw: res.value,
    transcript,
    promptVersion: PROMPT_VERSIONS.READER,
    usage: { promptTokens: meta.promptTokens, completionTokens: meta.completionTokens, model: meta.model, latencyMs: meta.latencyMs },
  };
}
