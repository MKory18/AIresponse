import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getEnv } from "@/core/env";
import { openAIChatUrl, openAIEmbeddingsUrl, probeOpenAICompatibleCaps, probeProviderEndpoint } from "@/modules/ai/provider";
import { resolveModel } from "@/modules/ai/router";
import { assertEndpointResolvesPublic } from "@/modules/ai/endpoint-guard";
import { isHermesPrivateNetworkAllowed } from "@/modules/ai/endpoint-guard";
import { runHermesDiagnostics } from "@/modules/ai/hermes-diagnostics";

const testSchema = z.object({
  /** Which configured provider to probe. Defaults to the workspace choice. */
  provider: z.enum(["openai", "openrouter", "internal", "hermes", "mock"]).optional(),
});

/**
 * P6 — POST /api/ai/providers/test: live connection probe (ai.configure).
 *
 * Sends a synthetic PII-free "ping" (max 5 tokens, no customer data) from the
 * SERVER using server-side ENV keys. The key is never returned, logged, or
 * echoed in errors — only HTTP status / timeout causes are reported.
 * Rate-limited to avoid hammering providers. Read-only: settings are loaded
 * with findUnique (no rows created) and nothing customer-facing is touched.
 */
export const POST = createHandler(
  { body: testSchema, permission: "ai.configure", rateLimit: { limit: 5, windowMs: 60_000 } },
  async ({ auth, body }) => {
    // Read-only settings load (diagnostics must not write to the database).
    const settings = ((await prisma.aISettings.findUnique({
      where: { workspaceId: auth!.workspaceId },
    })) ?? null) as unknown as Record<string, unknown> | null;

    const env = getEnv();
    const choice =
      (body.provider as string | undefined) ?? (settings?.provider as string | undefined) ?? env.AI_PROVIDER ?? "mock";

    if (choice === "mock") {
      return ok({ provider: "mock", status: "local", latencyMs: 0, detail: "LOCAL_MOCK_OK" });
    }

    // Hermes Agent gateway (OpenAI-compatible) — staged diagnostics instead
    // of a single ping, so production connectivity failures are attributable:
    // CONFIGURATION → URL_VALIDATION → DNS → CONNECTIVITY → HEALTH →
    // AUTHENTICATION → CHAT_COMPLETION. Endpoint prefers a workspace
    // override (Hermes-scoped SSRF guard: loopback/LAN additionally allowed
    // only with server HERMES_ALLOW_PRIVATE_NETWORK), else server ENV
    // HERMES_BASE_URL (deployer-trusted). Key always comes from server ENV,
    // never the client. Redirects are never followed (fail fast instead).
    // The /health stage is informational: it never proves (or disproves)
    // authentication or generation — only the chat POST does.
    if (choice === "hermes") {
      const override = (settings?.customBaseUrl as string | null | undefined)?.trim() || "";
      const allowPrivateNetwork = isHermesPrivateNetworkAllowed();
      const rawBase = override || env.HERMES_BASE_URL?.trim() || "";
      if (!rawBase) {
        return ok({ provider: "hermes", status: "unconfigured", latencyMs: 0, detail: "ENDPOINT_NOT_CONFIGURED" });
      }
      const key = env.HERMES_API_KEY?.trim() || "";
      const model =
        (settings?.responseModel as string | null | undefined) ?? env.HERMES_MODEL ?? env.RESPONSE_MODEL ?? "hermes-agent";
      const diag = await runHermesDiagnostics({ baseUrl: rawBase, apiKey: key, model, allowPrivateNetwork });
      const status = !key ? "needs_key" : diag.verdict;
      const totalMs = diag.stages.reduce((a, s) => a + (s.latencyMs ?? 0), 0);
      return ok({
        provider: "hermes",
        status,
        latencyMs: totalMs,
        detail: diag.code,
        endpoint: diag.endpoint,
        model: diag.model,
        diagnostics: {
          verdict: diag.verdict,
          code: diag.code,
          host: diag.host,
          port: diag.port,
          scheme: diag.scheme,
          allowPrivateNetwork: diag.allowPrivateNetwork,
          stages: diag.stages,
        },
      });
    }

    const key = choice === "openai" ? env.OPENAI_API_KEY : choice === "openrouter" ? env.OPENROUTER_API_KEY : undefined;
    let endpoint: string;
    let model: string;
    if (choice === "internal") {
      const base = (settings?.customBaseUrl as string | null | undefined)?.trim();
      if (!base) {
        return ok({ provider: "internal", status: "unconfigured", latencyMs: 0, detail: "ENDPOINT_NOT_CONFIGURED" });
      }
      // P7 SSRF guard: every probe re-validates the stored URL (defense in
      // depth — validation also runs at save time). Fail-closed with a safe
      // reason; the URL itself is never echoed into the error.
      const guard = await assertEndpointResolvesPublic(base);
      if (!guard.ok) {
        return ok({ provider: "internal", status: "failed", latencyMs: 0, detail: `SSRF_REJECTED_${guard.reason}` });
      }
      endpoint = base;
      model = resolveModel(settings as never, "RESPONSE").model;
      // Internal endpoints are tested INDEPENDENTLY of external models; a
      // success here proves the self-hosted route, never an external one.
      const probe = await probeProviderEndpoint(endpoint, "internal-probe", model);
      return ok({
        provider: "internal",
        status: probe.ok ? "working" : "failed",
        latencyMs: probe.latencyMs,
        detail: probe.detail,
        endpoint,
        model,
      });
    }

    if (!key) {
      return ok({ provider: choice, status: "needs_key", latencyMs: 0, detail: "API_KEY_MISSING" });
    }
    model = resolveModel(settings as never, "RESPONSE").model;
    try {
      endpoint =
        choice === "openai"
          ? openAIChatUrl()
          : "https://openrouter.ai/api/v1/chat/completions";
    } catch {
      // Malformed OPENAI_BASE_URL: report, never probe a fallback host.
      return ok({ provider: choice, status: "failed", latencyMs: 0, detail: "ENDPOINT_MISCONFIGURED", endpoint: null, model });
    }
    // Embeddings are a SEPARATE capability on a separate endpoint (often a
    // separate model): a gateway with working chat but no /v1/embeddings is
    // NOT ready — every turn would die at knowledge retrieval. Report both.
    const embModel =
      (settings?.embeddingModel as string | null | undefined) ?? env.EMBEDDING_MODEL ?? "text-embedding-3-small";
    const caps = await probeOpenAICompatibleCaps({
      chatUrl: endpoint,
      embeddingsUrl: choice === "openai" ? openAIEmbeddingsUrl() : "https://openrouter.ai/api/v1/embeddings",
      apiKey: key,
      chatModel: model,
      embeddingsModel: embModel,
    });
    return ok({
      provider: choice,
      status: caps.status,
      latencyMs: caps.latencyMs,
      detail: caps.detail,
      endpoint,
      model,
      chat: caps.chat,
      embeddings: caps.embeddings,
    });
  }
);
