import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import {
  validateHermesEndpoint,
  assertHermesEndpointResolves,
  isHermesPrivateNetworkAllowed,
  isCustomPrivateNetworkAllowed,
} from "@/modules/ai/endpoint-guard";
import { AppError } from "@/core/errors";
import { encryptSecret } from "@/core/crypto";

const settingsSchema = z.object({
  provider: z.enum(["mock", "openai", "openrouter", "internal", "hermes", "custom"]).optional(),
  classificationModel: z.string().trim().max(120).nullable().optional(),
  extractionModel: z.string().trim().max(120).nullable().optional(),
  responseModel: z.string().trim().max(120).nullable().optional(),
  visionModel: z.string().trim().max(120).nullable().optional(),
  summaryModel: z.string().trim().max(120).nullable().optional(),
  embeddingModel: z.string().trim().max(120).nullable().optional(),
  // مفتاح مزوّد مخصص (custom) — كتابة-فقط: لا يُرجع أبداً من أي قراءة،
  // وتنخزن القيمة المعمّاة فقط. إرسال null = إلغاء المفتاح.
  customApiKey: z.string().trim().min(8).max(300).nullable().optional(),
  // P6: self-hosted OpenAI-compatible endpoint + explicit fallback.
  customBaseUrl: z.string().trim().max(500).url("عنوان الاتصال يجب أن يكون رابطًا صالحًا").nullable().optional(),
  fallbackProvider: z.enum(["mock", "openai", "openrouter", "internal", "hermes", "custom"]).nullable().optional(),
  fallbackModel: z.string().trim().max(120).nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(50).max(4000).optional(),
  confidenceExecute: z.number().min(0).max(1).optional(),
  confidenceRespond: z.number().min(0).max(1).optional(),
  humanHandoffThreshold: z.number().min(0).max(1).optional(),
  aiEnabled: z.boolean().optional(),
  autoRespond: z.boolean().optional(),
});

export const GET = createHandler(
  { permission: "ai.configure" },
  async ({ auth }) => {
    // API keys are never exposed — the workspace custom key returns as a
    // boolean only; platform keys live in ENV.
    const settings = await prisma.aISettings.upsert({
      where: { workspaceId: auth!.workspaceId },
      create: { workspaceId: auth!.workspaceId },
      update: {},
    });
    const { customApiKeyEnc: _enc, ...rest } = settings as Record<string, unknown>;
    return ok({ ...rest, hasCustomApiKey: Boolean(_enc) });
  }
);

export const PATCH = createHandler(
  { body: settingsSchema, permission: "ai.configure" },
  async ({ auth, body }) => {
    // P7 SSRF guard (fail-closed): an operator-supplied model endpoint must
    // not target loopback/LAN/metadata addresses. Sync checks always; DNS
    // re-check when a new endpoint is being stored.
    // Hermes exception (narrow, deployer-opt-in): when the EFFECTIVE provider
    // is hermes, loopback/RFC1918 targets are additionally allowed IFF the
    // server sets HERMES_ALLOW_PRIVATE_NETWORK=1/true/yes. Metadata, creds,
    // and reserved ranges stay blocked regardless; every other provider keeps
    // the strict guard byte-identically.
    // ⚠️ كان: أي حفظ فيه customBaseUrl بينفحص العنوان حتى لو المزوّد المختار
    // ما بيستعمله — فعنوان خربان بيقفل الصفحة كلها، وما بتقدر تهرب منه لمزوّد
    // تاني (الواجهة بتبعت العنوان مع كل حفظ).
    // 🔧 هلأ: الفحص بيصير بس للمزوّدين اللي فعلًا بيستعملوا العنوان، وبيشمل
    // العنوان المخزّن كمان لما تبدّل لمزوّد منهم بلا ما تبعت عنوان جديد —
    // فما في ثغرة تخزين عنوان بلا فحص وبعدين تفعيله.
    const currentSettings = await prisma.aISettings.findUnique({ where: { workspaceId: auth!.workspaceId } });
    const effectiveProvider = body.provider ?? currentSettings?.provider ?? "mock";
    const isHermesProvider = effectiveProvider === "hermes";
    const isCustomProvider = effectiveProvider === "custom";
    // المزوّدين اللي فعلًا بيستعملوا العنوان. غيرهم: العنوان بينخزّن بلا
    // استعمال، وبينفحص كامل لحظة ما تبدّل لمزوّد بيستعمله (فوق) — فما في
    // طريق لتخزين عنوان بلا فحص وبعدين تشغيله.
    const usesCustomUrl = isHermesProvider || isCustomProvider;
    const urlToCheck = usesCustomUrl
      ? (body.customBaseUrl !== undefined
          ? body.customBaseUrl
          : ((currentSettings as { customBaseUrl?: string | null } | null)?.customBaseUrl ?? null))
      : null;
    if (urlToCheck !== null && urlToCheck !== undefined) {
      const allowPrivateNetwork = isHermesProvider
        ? isHermesPrivateNetworkAllowed()
        : isCustomPrivateNetworkAllowed();
      const sync = validateHermesEndpoint(urlToCheck, { allowPrivateNetwork });
      if (!sync.ok) {
        const hint = isHermesProvider
          ? "فعّل HERMES_ALLOW_PRIVATE_NETWORK=true في بيئة الخادم، أو اضبط HERMES_BASE_URL هناك مباشرة"
          : "فعّل AI_CUSTOM_ALLOW_PRIVATE_NETWORK=1 في بيئة الخادم إذا الـ API على نفس السيرفر أو شبكتك المحلية";
        throw new AppError(
          `عنوان الاتصال مرفوض (${sync.reason}) — للعناوين الداخلية (localhost/LAN) ${hint}`,
          422,
          "ENDPOINT_REJECTED"
        );
      }
      const dns = await assertHermesEndpointResolves(urlToCheck, { allowPrivateNetwork });
      if (!dns.ok) {
        throw new AppError(`عنوان الاتصال مرفوض (${dns.reason}) — تحقق من العنوان وأن DNS يحله لوجهة مسموحة`, 422, "ENDPOINT_REJECTED");
      }
    }
    // customApiKey أيضاً write-only: تنخزن معمّاة — القيمة المفتوحة لا
    // تسجل ولا ترجع. null = إلغاء المفتاح المخزن.
    const { customApiKey: _apiKey, ...data } = body;
    if (_apiKey !== undefined) {
      (data as Record<string, unknown>).customApiKeyEnc = _apiKey === null ? null : encryptSecret(_apiKey);
    }
    const settings = await prisma.aISettings.upsert({
      where: { workspaceId: auth!.workspaceId },
      create: { workspaceId: auth!.workspaceId, ...data },
      update: data,
    });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "ai_settings.updated",
      entityType: "AISettings",
      entityId: settings.id,
      metadata: { fields: Object.keys(data) },
    });
    const { customApiKeyEnc: _enc, ...rest } = settings as Record<string, unknown>;
    return ok({ ...rest, hasCustomApiKey: Boolean(_enc) });
  }
);
