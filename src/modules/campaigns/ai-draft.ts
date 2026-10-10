import type { Db } from "@/modules/customers/service";
import { loadAISettings, resolveModel, getWorkspaceProvider } from "@/modules/ai/router";
import { validateResponse } from "@/modules/ai/guardrails";
import { sendProtectedText } from "@/modules/ai/privacy-gate";
import { marketingChannelDecision } from "./campaign-schemas";

/**
 * P9 — اقتراح نص حملة بالذكاء (مساعدة فقط): بلا بيانات عملاء إطلاقًا
 * (لا أسماء ولا أرقام ولا قوائم)، وبلا أسعار مخترعة (الـ Prompt يمنع
 * ذكر أي سعر/عرض)، وتقترح على القنوات المسموحة رسميًا فقط.
 * المراجعة البشرية إجبارية قبل الحفظ، والإرسال عبر المسار المصرّف وحده.
 */

export interface CampaignDraftSuggestion {
  draft: string;
  provider: string;
  purpose: "CAMPAIGN_DRAFT";
}

export async function suggestCampaignDraft(
  db: Db,
  input: {
    workspaceId: string;
    channelType: string;
    productName?: string | null;
    tone?: string | null;
    language?: string | null;
  }
): Promise<CampaignDraftSuggestion> {
  const decision = marketingChannelDecision(input.channelType);
  if (!decision.allowed) {
    throw new (await import("@/core/errors")).AppError("قناة غير مدعومة للتسويق", 422, decision.reason);
  }
  const settings = await loadAISettings(db, input.workspaceId);
  const provider = getWorkspaceProvider((settings ?? null) as never);
  const modelCfg = resolveModel(settings as never, "RESPONSE");

  const lang = input.language ?? "العربية";
  const product = (input.productName ?? "").slice(0, 200);
  const tone = (input.tone ?? "ودود ومهني").slice(0, 100);
  const system = [
    "أنت مساعد صياغة رسائل تسويقية.",
    "قواعد صارمة:",
    "1) لا تكتب أي أسعار أو خصومات أو أرقام أسعار — لا تُخترع أبدًا.",
    "2) لا تذكر أسماء عملاء ولا أرقام هواتف ولا أي بيانات شخصية.",
    "3) اكتب نص حملة قصيرًا جاهزًا للمراجعة البشرية.",
    "4) لو القناة واتساب: نص يصلح كقالب معتمد بسيط.",
    `اللغة: ${lang}. النبرة: ${tone}.`,
  ].join("\n");
  const user = product
    ? `اكتب نص رسالة تسويقية عن: ${product}`
    : "اكتب نص رسالة تسويقية عامة لعلامة Zaki AI.";

  // بلا PII إطلاقًا — كائن فارغ، والحجب fail-closed عند أي تسرب.
  const res = await sendProtectedText(
    provider,
    { system, user, model: modelCfg.model, temperature: Math.min(modelCfg.temperature, 0.6), maxTokens: Math.min(modelCfg.maxTokens, 600) },
    { pii: {}, allowedNumbers: [], purpose: "CAMPAIGN_DRAFT" }
  );
  const guard = validateResponse({
    response: res.text,
    trustedContacts: [],
    allowedNumbers: [],
  });
  if (!guard.valid) {
    throw new (await import("@/core/errors")).AppError("اقتراح الحملة فشل حراسة المخرجات", 422, "GUARDRAIL_REJECTED");
  }
  return { draft: res.text.trim(), provider: provider.name, purpose: "CAMPAIGN_DRAFT" };
}
