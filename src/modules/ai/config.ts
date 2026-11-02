/**
 * Central AI provider configuration.
 *
 * OpenRouter is the ONLY external AI provider. Every external task (reply,
 * intent extraction, customer intelligence, summaries, vision) resolves here,
 * so a workspace can never silently call a different external vendor.
 *
 * The project's stored GLM routing aliases (`auto/*`) belong to the owner's
 * self-hosted GLM gateway; OpenRouter needs a real model id. The default below
 * is a real, published OpenRouter GLM id and can be overridden by
 * `OPENROUTER_GLM_MODEL` without touching code.
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Exact OpenRouter GLM model id (env override wins; never invented at runtime). */
export const DEFAULT_OPENROUTER_GLM_MODEL =
  process.env.OPENROUTER_GLM_MODEL?.trim() || "z-ai/glm-4.6";

/** True for the owner's local gateway aliases (not valid OpenRouter ids). */
export function isLocalGatewayAlias(model: string | null | undefined): boolean {
  const m = model?.trim();
  return !m || m.startsWith("auto/") || m.startsWith("gpt-") || m.startsWith("text-embedding-");
}

/**
 * Maps any configured task model to a valid OpenRouter GLM id. Real `z-ai/*`
 * ids are preserved exactly; gateway aliases/legacy models fall back to the
 * one configured GLM id — no second vendor, no silent model invention.
 */
export function openRouterModel(requested?: string | null): string {
  const model = requested?.trim();
  if (model && model.startsWith("z-ai/")) return model;
  return DEFAULT_OPENROUTER_GLM_MODEL;
}
