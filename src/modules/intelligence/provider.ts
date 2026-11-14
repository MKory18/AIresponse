import { AIProviderError, OpenAICompatibleProvider, type AIProvider } from "@/modules/ai/provider";
import { getWorkspaceProvider, resolveModel } from "@/modules/ai/router";

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
 * ⚠️ **ما تستعملها لرسائل زبون.** OpenRouter موديل خارجي، واستخراج بيانات
 * الزبون شغلته يطلّع الاسم والرقم والعنوان — فإرسال الرسالة لهون بيكسر
 * قاعدة «ولا بيانات زبون لموديل خارجي».
 * 🔧 البديل: `getWorkspaceExtractionProvider` تحت — بتمشي على مزوّد المساحة
 * نفسه (سيرفر المالك)، نفس اللي بيكتب الردود.
 *
 * بتضل موجودة للمختبر الداخلي اللي بيمرّر مزوّده صريح.
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

/**
 * مزوّد استخراج بيانات الزبون = مزوّد المساحة نفسه (سيرفر المالك).
 *
 * ⚠️ كان بيمشي على OpenRouter دايمًا مهما كانت إعدادات الذكاء بالمساحة،
 * وبيبعتله نص رسالة الزبون كامل — وهو اللي فيه الاسم والرقم والعنوان.
 * ومع مفتاح واقف صار كل استخراج يفشل (`PROVIDER_400` / `402`).
 * 🔧 هلأ بيقرأ إعدادات المساحة زي مسار الرد بالضبط: نفس المزوّد ونفس
 * الموديل تبع مهمة الاستخراج — فالبيانات ما بتطلع برّا سيرفرك.
 */
export async function getWorkspaceExtractionProvider(
  db: { aISettings: { findUnique: (args: unknown) => Promise<unknown> } },
  workspaceId: string
): Promise<ExtractionProviderHandle> {
  const settings = (await db.aISettings
    .findUnique({ where: { workspaceId } })
    .catch(() => null)) as Parameters<typeof resolveModel>[0];
  // ما في إعدادات ذكاء للمساحة = ما في مزوّد نختاره: منرجع لمزوّد البيئة
  // زي ما كان، بدل ما نوقف الاستخراج كله.
  if (!settings) return getExtractionProvider();
  const provider = getWorkspaceProvider(settings);
  const resolved = resolveModel(settings, "EXTRACTION");
  return { provider, model: resolved.model, providerName: provider.name };
}
