import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getEnv } from "@/core/env";
import { probeProviderEndpoint } from "@/modules/ai/provider";
import { resolveModel } from "@/modules/ai/router";
import { assertEndpointResolvesPublic } from "@/modules/ai/endpoint-guard";

const testSchema = z.object({
  /** Which configured provider to probe. Defaults to the workspace choice. */
  provider: z.enum(["openai", "openrouter", "internal", "mock"]).optional(),
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
    endpoint =
      choice === "openai"
        ? "https://api.openai.com/v1/chat/completions"
        : "https://openrouter.ai/api/v1/chat/completions";
    model = resolveModel(settings as never, "RESPONSE").model;
    const probe = await probeProviderEndpoint(endpoint, key, model);
    return ok({
      provider: choice,
      status: probe.ok ? "working" : "failed",
      latencyMs: probe.latencyMs,
      detail: probe.detail,
      endpoint,
      model,
    });
  }
);
