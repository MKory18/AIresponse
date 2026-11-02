import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getEnv } from "@/core/env";
import { probeProviderEndpoint, normalizeChatCompletionsEndpoint } from "@/modules/ai/provider";
import { decryptSecret } from "@/core/crypto";
import { resolveModel } from "@/modules/ai/router";
import { openRouterModel } from "@/modules/ai/config";
import {
  assertEndpointResolvesPublic,
  assertCustomEndpointResolves,
  isCustomPrivateNetworkAllowed,
} from "@/modules/ai/endpoint-guard";

const testSchema = z.object({
  /** Which configured provider to probe. Defaults to the workspace choice. */
  provider: z.enum(["openrouter", "internal", "custom", "mock"]).optional(),
});

/**
 * POST /api/ai/providers/test: live connection probe (ai.configure).
 * Synthetic PII-free ping; the key is never returned/logged.
 */
export const POST = createHandler(
  { body: testSchema, permission: "ai.configure", rateLimit: { limit: 5, windowMs: 60_000 } },
  async ({ auth, body }) => {
    const settings = ((await prisma.aISettings.findUnique({
      where: { workspaceId: auth!.workspaceId },
    })) ?? null) as unknown as Record<string, unknown> | null;

    const env = getEnv();
    const choice =
      (body.provider as string | undefined) ?? (settings?.provider as string | undefined) ?? env.AI_PROVIDER ?? "openrouter";

    if (choice === "mock") {
      return ok({ provider: "mock", status: "local", latencyMs: 0, detail: "LOCAL_MOCK_OK" });
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
      const endpoint = normalizeChatCompletionsEndpoint(base);
      const model = resolveModel(settings as never, "RESPONSE").model;
      const probe = await probeProviderEndpoint(endpoint, decryptSecret(enc), model, { followRedirects: false });
      return ok({
        provider: "custom",
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
      const guard = await assertEndpointResolvesPublic(base);
      if (!guard.ok) {
        return ok({ provider: "internal", status: "failed", latencyMs: 0, detail: `SSRF_REJECTED_${guard.reason}` });
      }
      const endpoint = normalizeChatCompletionsEndpoint(base);
      const model = resolveModel(settings as never, "RESPONSE").model;
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

    // OpenRouter — the only external provider.
    const key = env.OPENROUTER_API_KEY?.trim();
    if (!key) {
      return ok({ provider: "openrouter", status: "needs_key", latencyMs: 0, detail: "API_KEY_MISSING" });
    }
    const endpoint = "https://openrouter.ai/api/v1/chat/completions";
    const model = openRouterModel(resolveModel(settings as never, "RESPONSE").model);
    const probe = await probeProviderEndpoint(endpoint, key, model);
    return ok({
      provider: "openrouter",
      status: probe.ok ? "working" : "failed",
      latencyMs: probe.latencyMs,
      detail: probe.detail,
      endpoint,
      model,
    });
  }
);
