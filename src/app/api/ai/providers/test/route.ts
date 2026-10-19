import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getEnv } from "@/core/env";
import { probeProviderEndpoint, normalizeHermesEndpoint, normalizeOpenAiCompatibleEndpoint, normalizeOpenAiEmbeddingsEndpoint, probeEmbeddingEndpoint } from "@/modules/ai/provider";
import { decryptSecret } from "@/core/crypto";
import { resolveModel } from "@/modules/ai/router";
import { assertEndpointResolvesPublic, assertHermesEndpointResolves, isHermesPrivateNetworkAllowed, assertCustomEndpointResolves, isCustomPrivateNetworkAllowed } from "@/modules/ai/endpoint-guard";

const testSchema = z.object({
  /** Which configured provider to probe. Defaults to the workspace choice. */
  provider: z.enum(["openai", "openrouter", "internal", "hermes", "custom", "mock"]).optional(),
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

    const key = choice === "openai" ? env.OPENAI_API_KEY : choice === "openrouter" ? env.OPENROUTER_API_KEY : undefined;
    let endpoint: string;
    let model: string;
    if (choice === "hermes") {
      const override = (settings?.customBaseUrl as string | null | undefined)?.trim();
      const base = override || (env.HERMES_BASE_URL as string | undefined)?.trim();
      const hermesKey = (env.HERMES_API_KEY as string | undefined)?.trim();
      if (!base || !hermesKey) {
        return ok({ provider: "hermes", status: "needs_key", latencyMs: 0, detail: "HERMES_BASE_URL_OR_API_KEY_MISSING" });
      }
      // Hermes guard: strict baseline + optional deployer-opt-in private
      // networks (HERMES_ALLOW_PRIVATE_NETWORK) for loopback/LAN gateways.
      const guard = await assertHermesEndpointResolves(base, {
        allowPrivateNetwork: isHermesPrivateNetworkAllowed(),
      });
      if (!guard.ok) {
        return ok({ provider: "hermes", status: "failed", latencyMs: 0, detail: `SSRF_REJECTED_${guard.reason}` });
      }
      endpoint = normalizeHermesEndpoint(base);
      model = (env.HERMES_MODEL as string | undefined)?.trim() || resolveModel(settings as never, "RESPONSE").model || "hermes-agent";
      const probe = await probeProviderEndpoint(endpoint, hermesKey, model, { followRedirects: false });
      return ok({
        provider: "hermes",
        status: probe.ok ? "working" : "failed",
        latencyMs: probe.latencyMs,
        detail: probe.detail,
        endpoint,
        model,
      });
    }
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

    if (choice === "custom") {
      const base = (settings?.customBaseUrl as string | null | undefined)?.trim();
      const enc = (settings?.customApiKeyEnc as string | null | undefined)?.trim();
      if (!base || !enc) {
        return ok({ provider: "custom", status: "unconfigured", latencyMs: 0, detail: "CUSTOM_ENDPOINT_OR_KEY_MISSING" });
      }
      const allowPrivate = isCustomPrivateNetworkAllowed();
      const guard = await assertCustomEndpointResolves(base, { allowPrivateNetwork: allowPrivate });
      if (!guard.ok) {
        return ok({
          provider: "custom",
          status: "failed",
          latencyMs: 0,
          detail: `SSRF_REJECTED_${guard.reason}` + (allowPrivate ? "" : "_SET_AI_CUSTOM_ALLOW_PRIVATE_NETWORK_1"),
        });
      }
      const key = decryptSecret(enc);
      endpoint = normalizeHermesEndpoint(base);
      model = resolveModel(settings as never, "RESPONSE").model;
      // المفتاح المخصص ما بيرجع بالنتيجة — بس الحالة والتأخير والسبب.
      const probe = await probeProviderEndpoint(endpoint, key, model, { followRedirects: false });
      return ok({
        provider: "custom",
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
    const openaiBase = (env.OPENAI_BASE_URL as string | undefined)?.trim();
    endpoint =
      choice === "openai"
        ? (openaiBase ? (normalizeOpenAiCompatibleEndpoint(openaiBase) ?? "https://api.openai.com/v1/chat/completions") : "https://api.openai.com/v1/chat/completions")
        : "https://openrouter.ai/api/v1/chat/completions";
    model = resolveModel(settings as never, "RESPONSE").model;
    const probe = await probeProviderEndpoint(endpoint, key, model);
    // الشات والـ embeddings بتفحص لحالهم — نجاح واحد ما بيثبت التاني.
    // الفحص بيوصل للـ embeddings بس مع بوابة مخصصة (Custom OCR... هنا: من بيئة الخادم).
    let embedding: Record<string, unknown> | null = null;
    if (choice === "openai" && openaiBase) {
      // فحص الـ embeddings لحاله (بيئة الخادم هي مصدر المفتاح/العنوان —
      // ما في مدخل مساحة هنا، فالفحص مخطط فقط حسب سياسة المصدر الموثوق).
      const embedEndpoint = normalizeOpenAiEmbeddingsEndpoint(openaiBase);
      const embedModel = (env.EMBEDDING_MODEL as string | undefined)?.trim() || "text-embedding-3-small";
      if (!embedEndpoint) {
        embedding = { status: "failed", detail: "MALFORMED_OPENAI_BASE_URL" };
      } else {
        const embedProbe = await probeEmbeddingEndpoint(embedEndpoint, key, embedModel);
        embedding = {
          status: embedProbe.ok ? "working" : "failed",
          detail: embedProbe.detail,
          dimensions: embedProbe.dimensions,
          endpoint: embedEndpoint,
          model: embedModel,
        };
      }
    }
    return ok({
      provider: choice,
      status: probe.ok ? "working" : "failed",
      latencyMs: probe.latencyMs,
      detail: probe.detail,
      endpoint,
      model,
      ...(embedding ? { embedding } : {}),
    });
  }
);
