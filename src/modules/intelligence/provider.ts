import { AIProviderError, OpenAICompatibleProvider, type AIProvider } from "@/modules/ai/provider";

/** العنوان الرسمي لـ OpenRouter — الأساس دائمًا، وأي تغيير صريح من بيئة الخادم فقط. */
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * يقبل: https://openrouter.ai/api/v1 · .../v1/ · .../api/v1/chat/completions
 * ويرجّع دائمًا عنوان /chat/completions كامل. لا أسرار ولا طباعة للعنوان.
 */
export function openRouterChatUrl(raw?: string | null): string {
  const base = (raw?.trim() || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v1$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export interface ExtractionProviderHandle {
  provider: AIProvider;
  model: string;
  /** اسم آمن للعرض/السجل — لا يحتوي أي جزء من المفتاح. */
  providerName: string;
}

/**
 * مزوّد الاستخراج: OpenRouter مباشرة (متغيّر بيئة سري).
 * - المفتاح لا يُقرأ من قاعدة البيانات ولا من الواجهة ولا يُسجَّل.
 * - النموذج قابل للضبط: INTEL_MODEL ثم EXTRACTION_MODEL ثم افتراضي موثّق.
 * - غياب المفتاح = خطأ دائم واضح (المهمة تفشل بأمان والرسالة تبقى محفوظة).
 */
export function getExtractionProvider(): ExtractionProviderHandle {
  const apiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new AIProviderError("OPENROUTER_API_KEY is not configured (extraction provider)", {
      retryable: false,
      httpStatus: 401,
    });
  }
  const model = (process.env.INTEL_MODEL ?? process.env.EXTRACTION_MODEL ?? "openai/gpt-4o-mini").trim();
  const provider = new OpenAICompatibleProvider({
    name: "openrouter",
    apiKey,
    baseUrl: openRouterChatUrl(process.env.OPENROUTER_BASE_URL),
    defaultModel: model,
    delivery: "external",
  });
  return { provider, model, providerName: "openrouter" };
}
