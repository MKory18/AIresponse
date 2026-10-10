// NOTE (P1): `@prisma/client` loads the repo `.env` via dotenv as a SIDE
// EFFECT of its first import — which happens during test-file collection,
// i.e. AFTER this setup module's body runs. Import it here first so that
// load happens now, then scrub AI-selection keys below. Without this, a
// local `.env` containing e.g. `AI_PROVIDER=openai` (no key) silently flips
// provider-dependent tests to AI_NOT_CONFIGURED depending on import order.
import "@/core/db/prisma";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
// Forced (not ??=): with the dotenv load above, a local .env would otherwise
// win and e.g. its ENCRYPTION_KEY breaks encryptSecret in unrelated files.
// Unit tests must run on fixed doubles — never on developer-local secrets.
process.env.JWT_SECRET = "test-secret-value-for-unit-tests-0000000000";
process.env.ENCRYPTION_KEY = "test-encryption-key-for-unit-tests-00000000000";

// P1 hermeticity: the suite must NEVER depend on the developer's local .env
// (or shell) for AI provider selection. A local `AI_PROVIDER=openai` without
// a key used to flip provider-dependent tests (e.g. the phase5 orchestrator
// pipeline) from green to AI_NOT_CONFIGURED depending on where vitest ran.
// Provider behavior under test is set explicitly per-test (injected mocks,
// setMockAIProvider, or direct resolveAIProvider opts) — never ambient.
for (const k of [
  "AI_PROVIDER",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "HERMES_BASE_URL",
  "HERMES_API_KEY",
  "HERMES_MODEL",
  "ALLOW_MOCK_AI",
  // Empty-string overrides (e.g. `META_REDIRECT_URI=` in a local .env) defeat
  // `?? default` fallbacks (`""` is not nullish) — proven by the facebook-oauth
  // redirect test. Only optional-override keys are scrubbed here; keyed
  // secrets (META_APP_SECRET etc.) are left untouched for signature tests.
  "META_REDIRECT_URI",
  "META_GRAPH_VERSION",
]) {
  delete process.env[k];
}
