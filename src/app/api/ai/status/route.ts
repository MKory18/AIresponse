import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getEnv } from "@/core/env";
import {
  AI_TASKS,
  DEFAULT_MODELS,
  resolveModel,
  validateTaskModel,
  type AiTask,
} from "@/modules/ai/router";
import { testProviderConnection } from "@/modules/ai/provider";
import { getCurrentEmbeddingIdentity } from "@/modules/knowledge/embeddings";

/**
 * P6 — GET /api/ai/status: single studio snapshot (ai.configure).
 *
 * Returns provider states, per-task resolved models + compatibility, the
 * embedding identity, and knowledge index stats. NEVER returns API keys or
 * endpoint secrets (only presence flags and safe metadata).
 */
export const GET = createHandler({ permission: "ai.configure" }, async ({ auth }) => {
  const settings = (await prisma.aISettings.upsert({
    where: { workspaceId: auth!.workspaceId },
    create: { workspaceId: auth!.workspaceId },
    update: {},
  })) as unknown as Record<string, unknown>;

  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch {
    env = {} as ReturnType<typeof getEnv>;
  }
  const hasOpenaiKey = Boolean(env.OPENAI_API_KEY);
  const hasOpenrouterKey = Boolean(env.OPENROUTER_API_KEY);
  const hasHermesConfig = Boolean(env.HERMES_BASE_URL && env.HERMES_API_KEY);
  const allowMock = ["1", "true", "yes"].includes(((env.ALLOW_MOCK_AI ?? "") as string).toLowerCase());
  const isProd = process.env.NODE_ENV === "production";

  const providers = [
    {
      id: "hermes",
      configured: hasHermesConfig,
      status: hasHermesConfig ? "configured" : "needs_env",
      endpoint: (settings.customBaseUrl as string | null) ?? (env.HERMES_BASE_URL as string | null) ?? null,
    },
    {
      id: "openai",
      configured: hasOpenaiKey,
      status: hasOpenaiKey ? ("configured" as const) : ("needs_key" as const),
      endpoint: (env.OPENAI_BASE_URL as string | null)?.trim() || "https://api.openai.com/v1/chat/completions",
    },
    {
      id: "openrouter",
      configured: hasOpenrouterKey,
      status: hasOpenrouterKey ? ("configured" as const) : ("needs_key" as const),
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
    },
    {
      id: "internal",
      configured: Boolean(settings.customBaseUrl),
      status: settings.customBaseUrl ? ("configured" as const) : ("unconfigured" as const),
      endpoint: (settings.customBaseUrl as string | null) ?? null,
    },
    {
      id: "mock",
      configured: allowMock || !isProd,
      status: (allowMock || !isProd ? "local" : "disabled") as "local" | "disabled",
      endpoint: null,
    },
  ];

  const tasks = AI_TASKS.map((task: AiTask) => {
    const resolved = resolveModel(settings as never, task);
    const compat = validateTaskModel(task, resolved.model);
    return {
      task,
      model: resolved.model,
      temperature: resolved.temperature,
      maxTokens: resolved.maxTokens,
      defaultModel: DEFAULT_MODELS[task],
      compatible: compat.compatible,
      compatibilityReason: compat.reason,
    };
  });

  const embedding = getCurrentEmbeddingIdentity();
  const [ready, processing, failed, faqCount, personaCount] = await Promise.all([
    prisma.knowledgeDocument.count({ where: { workspaceId: auth!.workspaceId, status: "READY" } }),
    prisma.knowledgeDocument.count({ where: { workspaceId: auth!.workspaceId, status: "PROCESSING" } }),
    prisma.knowledgeDocument.count({ where: { workspaceId: auth!.workspaceId, status: "FAILED" } }),
    prisma.faq.count({ where: { workspaceId: auth!.workspaceId, isActive: true } }),
    prisma.persona.count({ where: { workspaceId: auth!.workspaceId } }),
  ]);

  // Live classification of the EFFECTIVE workspace provider (no network).
  const { getWorkspaceProvider } = await import("@/modules/ai/router");
  let effective: { name: string; delivery: string; status: string } | null = null;
  try {
    const p = getWorkspaceProvider(settings as never);
    const t = await testProviderConnection(p);
    effective = { name: p.name, delivery: p.delivery, status: t.status };
  } catch {
    effective = { name: "unconfigured", delivery: "external", status: "unconfigured" };
  }

  return ok({
    provider: settings.provider,
    aiEnabled: settings.aiEnabled,
    autoRespond: settings.autoRespond,
    effectiveProvider: effective,
    providers,
    tasks,
    embedding,
    fallback: {
      provider: (settings.fallbackProvider as string | null) ?? null,
      model: (settings.fallbackModel as string | null) ?? null,
      configured: Boolean(settings.fallbackModel),
    },
    knowledge: { ready, processing, failed, faqs: faqCount, personas: personaCount },
  });
});
