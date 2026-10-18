import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { validateEndpointUrl, assertEndpointResolvesPublic } from "@/modules/ai/endpoint-guard";
import { AppError } from "@/core/errors";

const settingsSchema = z.object({
  provider: z.enum(["mock", "openai", "openrouter", "internal"]).optional(),
  classificationModel: z.string().trim().max(120).nullable().optional(),
  extractionModel: z.string().trim().max(120).nullable().optional(),
  responseModel: z.string().trim().max(120).nullable().optional(),
  visionModel: z.string().trim().max(120).nullable().optional(),
  summaryModel: z.string().trim().max(120).nullable().optional(),
  embeddingModel: z.string().trim().max(120).nullable().optional(),
  // P6: self-hosted OpenAI-compatible endpoint + explicit fallback.
  customBaseUrl: z.string().trim().max(500).url("عنوان الاتصال يجب أن يكون رابطًا صالحًا").nullable().optional(),
  fallbackProvider: z.enum(["mock", "openai", "openrouter", "internal"]).nullable().optional(),
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
    // API keys are never exposed — provider keys live in ENV only.
    const settings = await prisma.aISettings.upsert({
      where: { workspaceId: auth!.workspaceId },
      create: { workspaceId: auth!.workspaceId },
      update: {},
    });
    return ok(settings);
  }
);

export const PATCH = createHandler(
  { body: settingsSchema, permission: "ai.configure" },
  async ({ auth, body }) => {
    // P7 SSRF guard (fail-closed): an operator-supplied model endpoint must
    // not target loopback/LAN/metadata addresses. Sync checks always; DNS
    // re-check when a new endpoint is being stored.
    if (body.customBaseUrl !== undefined && body.customBaseUrl !== null) {
      const sync = validateEndpointUrl(body.customBaseUrl);
      if (!sync.ok) {
        throw new AppError(`عنوان الاتصال مرفوض (${sync.reason}) — لا تُسمح عناوين داخلية أو محجوزة`, 422, "ENDPOINT_REJECTED");
      }
      const dns = await assertEndpointResolvesPublic(body.customBaseUrl);
      if (!dns.ok) {
        throw new AppError(`عنوان الاتصال مرفوض (${dns.reason}) — لا تُسمح عناوين داخلية أو محجوزة`, 422, "ENDPOINT_REJECTED");
      }
    }
    const settings = await prisma.aISettings.upsert({
      where: { workspaceId: auth!.workspaceId },
      create: { workspaceId: auth!.workspaceId, ...body },
      update: body,
    });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "ai_settings.updated",
      entityType: "AISettings",
      entityId: settings.id,
      metadata: { fields: Object.keys(body) },
    });
    return ok(settings);
  }
);
