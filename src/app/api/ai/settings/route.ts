import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import {
  validateEndpointUrl,
  assertEndpointResolvesPublic,
  validateCustomEndpoint,
  assertCustomEndpointResolves,
  isCustomPrivateNetworkAllowed,
} from "@/modules/ai/endpoint-guard";
import { AppError } from "@/core/errors";
import { encryptSecret } from "@/core/crypto";

const settingsSchema = z.object({
  provider: z.enum(["mock", "openrouter", "internal", "custom"]).optional(),
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
  fallbackProvider: z.enum(["mock", "openrouter", "internal", "custom"]).nullable().optional(),
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
    // SSRF guard (fail-closed) for self-hosted/custom endpoints. Strict by
    // default; the deployer may opt into LAN/loopback via
    // AI_CUSTOM_ALLOW_PRIVATE_NETWORK. Metadata/reserved ranges stay blocked.
    if (body.customBaseUrl !== undefined && body.customBaseUrl !== null) {
      const current = await prisma.aISettings.findUnique({ where: { workspaceId: auth!.workspaceId } });
      const effectiveProvider = body.provider ?? current?.provider ?? "openrouter";
      const isCustomProvider = effectiveProvider === "custom" || effectiveProvider === "internal";
      if (isCustomProvider) {
        const allowPrivateNetwork = isCustomPrivateNetworkAllowed();
        const sync = validateCustomEndpoint(body.customBaseUrl, { allowPrivateNetwork });
        if (!sync.ok) {
          throw new AppError(
            `عنوان الاتصال مرفوض (${sync.reason}) — للعناوين الداخلية (localhost/LAN) فعّل AI_CUSTOM_ALLOW_PRIVATE_NETWORK=1 في بيئة الخادم`,
            422,
            "ENDPOINT_REJECTED"
          );
        }
        const dns = await assertCustomEndpointResolves(body.customBaseUrl, { allowPrivateNetwork });
        if (!dns.ok) {
          throw new AppError(`عنوان الاتصال مرفوض (${dns.reason}) — تحقق من العنوان وأن DNS يحله لوجهة مسموحة`, 422, "ENDPOINT_REJECTED");
        }
      } else {
        const sync = validateEndpointUrl(body.customBaseUrl);
        if (!sync.ok) {
          throw new AppError(`عنوان الاتصال مرفوض (${sync.reason}) — لا تُسمح عناوين داخلية أو محجوزة`, 422, "ENDPOINT_REJECTED");
        }
        const dns = await assertEndpointResolvesPublic(body.customBaseUrl);
        if (!dns.ok) {
          throw new AppError(`عنوان الاتصال مرفوض (${dns.reason}) — لا تُسمح عناوين داخلية أو محجوزة`, 422, "ENDPOINT_REJECTED");
        }
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
