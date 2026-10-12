/**
 * AI Provider abstraction. The rest of the system never imports an SDK —
 * only this interface. MockAIProvider keeps the whole engine testable and
 * runnable without API keys.
 */
import { getEnv } from "@/core/env";
import { heuristicIntent } from "./intent";

export interface TextRequest {
  system: string;
  user: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface StructuredRequest<T> extends TextRequest {
  /** Zod-style validator callback applied to the parsed JSON. */
  validate: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string };
}

export interface VisionRequest {
  system: string;
  imageUrl: string;
  prompt: string;
  model?: string;
}

export interface AIResponse {
  text: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface AIProvider {
  readonly name: string;
  /**
   * Connection delivery class (P1 privacy gate). Declared by construction —
   * never inferred from the name:
   * - "external": traffic leaves our infrastructure (masking REQUIRED).
   * - "internal": self-hosted endpoint on our infrastructure (B3 policy).
   * - "local": in-process mock/test double (nothing leaves the process).
   */
  readonly delivery: "external" | "internal" | "local";
  generateText(req: TextRequest): Promise<AIResponse>;
  generateStructured<T>(req: StructuredRequest<T>): Promise<AIResponse & { value: T }>;
  generateVision?(req: VisionRequest): Promise<AIResponse>;
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Shared OpenAI-compatible implementation for OpenAI & OpenRouter. */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  readonly delivery: "external" | "internal" | "local";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  /**
   * Redirect policy. Default true preserves every existing provider's
   * behavior byte-identically. Hermes instances pass false: a gateway that
   * answers with a redirect is a misconfiguration, and silently following
   * it could carry the Bearer key + customer-derived prompts to an
   * attacker-chosen host. Redirects then fail fast (non-retryable).
   */
  private readonly followRedirects: boolean;

  constructor(opts: { name: string; apiKey: string; baseUrl: string; defaultModel: string; delivery?: "external" | "internal"; followRedirects?: boolean }) {
    this.name = opts.name;
    this.delivery = opts.delivery ?? "external";
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.defaultModel = opts.defaultModel;
    this.followRedirects = opts.followRedirects ?? true;
  }

  /** P6 studio: safe connection metadata (never the key itself). */
  get endpointUrl(): string {
    return this.baseUrl;
  }

  get hasCredentials(): boolean {
    return this.apiKey.trim().length > 0;
  }

  get defaultModelName(): string {
    return this.defaultModel;
  }

  private async chat(body: Record<string, unknown>): Promise<AIResponse> {
    const started = Date.now();
    // Bounded execution: a hung provider must never hang the worker forever.
    const timeoutMs = Math.max(1000, parseInt(process.env.AI_REQUEST_TIMEOUT_MS ?? "60000", 10) || 60000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: this.followRedirects ? "follow" : "manual",
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new AIProviderError(`${this.name} request timed out after ${timeoutMs}ms`, {
          retryable: true,
        });
      }
      throw err;
    }
    clearTimeout(timer);
    if (!this.followRedirects && (res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400))) {
      throw new AIProviderError(
        `${this.name} endpoint refused: server answered with a redirect (REDIRECT_BLOCKED). Point the endpoint at the final gateway URL — redirects are never followed.`,
        { retryable: false }
      );
    }
    if (!res.ok) {
      // Classify BEFORE reading the body: timeouts/rate-limits/5xx are
      // transient (durable retry with backoff); 401/403/404/400 are permanent
      // configuration or request errors (fail fast, stay operator-visible,
      // never hammer).
      const status = res.status;
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      if (status === 429 || status === 408 || status === 425 || status >= 500) {
        throw new AIProviderError(`${this.name} request failed with status ${status}`, {
          retryable: true,
          httpStatus: status,
          retryAfterMs,
        });
      }
      throw new AIProviderError(`${this.name} request failed with status ${status}`, {
        retryable: false,
        httpStatus: status,
      });
    }
    const json = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const text = json.choices[0]?.message?.content ?? "";
    if (!text.trim()) {
      throw new AIProviderError(`${this.name} returned an empty response`);
    }
    return {
      text,
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }

  async generateText(req: TextRequest): Promise<AIResponse> {
    return this.chat({
      model: req.model ?? this.defaultModel,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      temperature: req.temperature ?? 0.4,
      max_tokens: req.maxTokens ?? 500,
    });
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<AIResponse & { value: T }> {
    const res = await this.generateText({
      ...req,
      system: `${req.system}\n\nRespond with a single valid JSON object only. No markdown, no commentary.`,
    });
    const parsed = parseJsonLoose(res.text);
    const validated = req.validate(parsed);
    if (!validated.ok) {
      throw new AIProviderError(`Structured output failed validation: ${validated.error}`);
    }
    return { ...res, value: validated.value };
  }

  async generateVision(req: VisionRequest): Promise<AIResponse> {
    return this.chat({
      model: req.model ?? this.defaultModel,
      messages: [
        { role: "system", content: req.system },
        {
          role: "user",
          content: [
            { type: "text", text: req.prompt },
            { type: "image_url", image_url: { url: req.imageUrl } },
          ],
        },
      ],
      max_tokens: 300,
    });
  }
}

export interface AIProviderErrorOptions {
  /**
   * False for permanent configuration/request errors (bad credentials, unknown
   * model, invalid request) that retries will never fix — callers fail fast
   * and keep the message operator-visible instead of hammering the provider.
   * Defaults to true (transient until proven otherwise — never silently drop).
   */
  retryable?: boolean;
  httpStatus?: number;
  /** Server's Retry-After hint in milliseconds, when provided. */
  retryAfterMs?: number;
}

export class AIProviderError extends Error {
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  constructor(message: string, opts: AIProviderErrorOptions = {}) {
    super(message);
    this.name = "AIProviderError";
    this.retryable = opts.retryable ?? true;
    this.httpStatus = opts.httpStatus;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/** Extracts a JSON object from possibly-fenced/free-form model output. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  try {
    return JSON.parse(slice);
  } catch {
    // Repair attempt: remove trailing commas, then retry.
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      throw new AIProviderError("Model returned unparseable JSON");
    }
  }
}

const globalForAI = globalThis as typeof globalThis & { __acreMockAI?: MockAIProvider };

/**
 * Deterministic mock provider: routes on keyword heuristics and template
 * responses backed by injected context. Used in tests and when no API key is
 * configured — so the engine works end-to-end without external dependencies.
 */
export class MockAIProvider implements AIProvider {
  readonly name = "mock";
  readonly delivery = "local" as const;
  public intentHandler?: (user: string) => { intent: string; confidence: number; entities?: Record<string, unknown>; memories?: unknown[] };
  public responseHandler?: (user: string, system: string) => string;

  async generateText(req: TextRequest): Promise<AIResponse> {
    const text = this.responseHandler
      ? this.responseHandler(req.user, req.system)
      : defaultMockResponse(req.user, req.system);
    return {
      text,
      promptTokens: Math.ceil(req.system.length / 4) + Math.ceil(req.user.length / 4),
      completionTokens: Math.ceil(text.length / 4),
      latencyMs: 5,
    };
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<AIResponse & { value: T }> {
    const raw = this.intentHandler
      ? this.intentHandler(req.user)
      : defaultMockStructured(req.user);
    const validated = req.validate(raw);
    if (!validated.ok) throw new AIProviderError(validated.error);
    return {
      text: JSON.stringify(raw),
      promptTokens: 100,
      completionTokens: 30,
      latencyMs: 5,
      value: validated.value,
    };
  }
}

/** Default mock structured output: heuristic intent + naive entity scan. */
function defaultMockStructured(user: string): Record<string, unknown> {
  // Classify ONLY the untrusted customer content — never the surrounding
  // context/instruction scaffold.
  const untrusted = user.match(
    /\[UNTRUSTED_CUSTOMER_CONTENT\]([\s\S]*?)\[\/UNTRUSTED_CUSTOMER_CONTENT\]/
  );
  const { intent, confidence } = heuristicIntent(untrusted ? untrusted[1].trim() : user);
  const entities: Record<string, unknown> = {};
  const phone = user.match(/0\d{8,9}/);
  if (phone) entities.phone = phone[0];
  const qty = untrusted ? untrusted[1].match(/بدي\s*(\d+)|(\d+)\s*(قطع|حبة|عبوة)/) : null;
  if (qty) entities.quantity = Number(qty[1] ?? qty[2]);
  const name = untrusted ? untrusted[1].match(/اسمي\s+([\p{L}]{2,20})/u) : null;
  if (name) entities.customer_name = name[1];
  const address = untrusted ? untrusted[1].match(/عنواني\s+([^،,\n]+)/u) : null;
  if (address) entities.address = address[1].trim();
  const product = untrusted ? untrusted[1].match(/من\s+([\p{L}\s]{3,30})|بدي\s+([\p{L}\s]{3,30}?)[،,]/u) : null;
  if (product) entities.product = (product[1] ?? product[2])?.trim();
  return { intent, confidence, entities, missingFields: [], memories: [], requestedAction: "ANSWER" };
}

function defaultMockResponse(user: string, system: string): string {
  // Extract the DB price the orchestrator injected into trusted data.
  const priceMatch = system.match(/السعر الرسمي: ([^\n]+)/);
  const nameMatch = system.match(/اسم المنتج: ([^\n]+)/);
  if (priceMatch && nameMatch && /سعر|بكم|كم/.test(user)) {
    return `أهلًا فيك 🌹\nسعر ${nameMatch[1].trim()} ${priceMatch[1].trim()}.\nإذا حابب أقدر أسجل لك الطلب.`;
  }
  if (/توصيل/.test(user)) return "أي نعم، التوصيل متوفر لجميع المحافظات خلال 24-48 ساعة 🌹";
  return "شكرًا لتواصلك! كيف فيني ساعدك؟";
}

export function getAIProvider(): AIProvider {
  if (globalForAI.__acreMockAI) return globalForAI.__acreMockAI;
  const env = getEnv();
  return resolveAIProvider({
    aiProvider: env.AI_PROVIDER,
    openaiKey: env.OPENAI_API_KEY,
    openrouterKey: env.OPENROUTER_API_KEY,
    hermesBaseUrl: env.HERMES_BASE_URL,
    hermesKey: env.HERMES_API_KEY,
    hermesModel: env.HERMES_MODEL,
    responseModel: env.RESPONSE_MODEL,
    nodeEnv: process.env.NODE_ENV,
    allowMockAi: env.ALLOW_MOCK_AI,
  });
}

/**
 * Normalizes a Hermes gateway base URL into a full chat-completions endpoint.
 * Accepts any of: http://host:8642, http://host:8642/v1,
 * http://host:8642/v1/chat/completions (trailing slashes tolerated).
 */
export function normalizeHermesEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v1$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/**
 * Pure provider resolution (no env reads — unit-testable).
 *
 * Fail-closed contract for production:
 * - An explicitly configured real provider with a missing key throws
 *   AIProviderError(AI_NOT_CONFIGURED) — NEVER a silent mock.
 * - Production with no provider configured at all also throws.
 * - MockAIProvider is returned ONLY for explicit test/dev configuration:
 *   injected mock, NODE_ENV=test, ALLOW_MOCK_AI=1/true/yes, or a
 *   non-production run with no provider configured (local DX).
 */
export function resolveAIProvider(opts: {
  aiProvider?: string;
  openaiKey?: string;
  openrouterKey?: string;
  hermesBaseUrl?: string;
  hermesKey?: string;
  hermesModel?: string;
  responseModel?: string;
  nodeEnv?: string;
  allowMockAi?: string;
}): AIProvider {
  if (globalForAI.__acreMockAI) return globalForAI.__acreMockAI;
  if (opts.aiProvider === "openai" && opts.openaiKey) {
    return new OpenAICompatibleProvider({
      name: "openai",
      apiKey: opts.openaiKey,
      baseUrl: OPENAI_URL,
      defaultModel: opts.responseModel || "gpt-4o-mini",
    });
  }
  if (opts.aiProvider === "openrouter" && opts.openrouterKey) {
    return new OpenAICompatibleProvider({
      name: "openrouter",
      apiKey: opts.openrouterKey,
      baseUrl: OPENROUTER_URL,
      defaultModel: opts.responseModel || "openai/gpt-4o-mini",
    });
  }
  // Hermes Agent — OpenAI-compatible gateway (delivery "external" so the
  // privacy gate keeps masking PII: Hermes turns may invoke external tools).
  if (opts.aiProvider === "hermes") {
    const base = opts.hermesBaseUrl?.trim();
    const key = opts.hermesKey?.trim();
    if (!base || !key) {
      throw new AIProviderError(
        `AI_NOT_CONFIGURED: AI_PROVIDER="hermes" is configured but HERMES_BASE_URL or HERMES_API_KEY is missing. Set both (HERMES_BASE_URL like http://127.0.0.1:8642/v1, HERMES_API_KEY = the gateway API key). Refusing mock fallback — no fake replies will be sent.`
      );
    }
    return new OpenAICompatibleProvider({
      name: "hermes",
      apiKey: key,
      baseUrl: normalizeHermesEndpoint(base),
      defaultModel: opts.hermesModel?.trim() || opts.responseModel || "hermes-agent",
      // Hermes turns may invoke tools: never follow a gateway redirect with
      // the key + prompts (fail fast instead).
      followRedirects: false,
    });
  }
  if (opts.aiProvider === "openai" || opts.aiProvider === "openrouter") {
    const expected = opts.aiProvider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY";
    throw new AIProviderError(
      `AI_NOT_CONFIGURED: AI_PROVIDER="${opts.aiProvider}" is configured but ${expected} is missing. Refusing mock fallback — no fake replies will be sent.`
    );
  }
  const mockAllowed =
    opts.nodeEnv === "test" ||
    ["1", "true", "yes"].includes((opts.allowMockAi ?? "").toLowerCase()) ||
    (opts.nodeEnv !== "production" && !opts.aiProvider);
  if (mockAllowed) {
    // eslint-disable-next-line no-console
    console.warn(
      `[AI] No real provider configured (AI_PROVIDER=${opts.aiProvider ?? "unset"}) — using MockAIProvider for test/development only.`
    );
    return new MockAIProvider();
  }
  throw new AIProviderError(
    `AI_NOT_CONFIGURED: no AI provider configured (AI_PROVIDER=${opts.aiProvider ?? "unset"}). Set AI_PROVIDER + matching API key, or ALLOW_MOCK_AI=1 for explicit dev/test use.`
  );
}

/** Test/dev helper: force the mock provider for the current process. */
export function setMockAIProvider(mock: MockAIProvider | undefined) {
  globalForAI.__acreMockAI = mock;
}

/** P6: injected test double (if any) — workspace resolution must honor it. */
export function getInjectedMockProvider(): MockAIProvider | undefined {
  return globalForAI.__acreMockAI;
}

// ── P6: connection testing (studio "اختبار الاتصال") ─────────────────────
// Sends NO customer data: the live probe is a synthetic "ping" (max 5
// tokens). Returns a machine-readable status for the studio UI:
// "working" | "failed" | "needs_key" | "unconfigured" | "local". Failure
// causes are operator-safe (status codes, timeouts) — keys are never echoed
// in results, logs, or errors.

export type ProviderTestStatus = "working" | "failed" | "needs_key" | "unconfigured" | "local";

export interface ProviderTestResult {
  provider: string;
  status: ProviderTestStatus;
  latencyMs: number;
  detail: string;
}

/** Local classification only (no network) — safe for unit tests. */
export async function testProviderConnection(
  provider: AIProvider
): Promise<ProviderTestResult> {
  const started = Date.now();
  if (provider.delivery === "local") {
    return { provider: provider.name, status: "local", latencyMs: Date.now() - started, detail: "LOCAL_MOCK_OK" };
  }
  if (!(provider instanceof OpenAICompatibleProvider)) {
    return { provider: provider.name, status: "failed", latencyMs: Date.now() - started, detail: "UNKNOWN_PROVIDER_CLASS" };
  }
  if (!provider.hasCredentials || provider.endpointUrl.trim().length === 0) {
    return { provider: provider.name, status: "needs_key", latencyMs: Date.now() - started, detail: "API_KEY_OR_ENDPOINT_MISSING" };
  }
  // Reachability requires a live HTTP probe (server-side route below).
  return { provider: provider.name, status: "failed", latencyMs: Date.now() - started, detail: "PROBE_REQUIRED" };
}

/**
 * P6: live endpoint probe — server-side only. Sends a synthetic PII-free
 * "ping" (max 5 tokens, no customer data). The caller supplies the key from
 * server ENV; this function never includes it in results or errors.
 */
export async function probeProviderEndpoint(
  endpointUrl: string,
  apiKey: string,
  model: string,
  opts?: { fetchFn?: typeof fetch; timeoutMs?: number; followRedirects?: boolean }
): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
  const started = Date.now();
  const fetchFn = opts?.fetchFn ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const followRedirects = opts?.followRedirects ?? true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
      signal: controller.signal,
      redirect: followRedirects ? "follow" : "manual",
    });
    if (!followRedirects && (res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400))) {
      return { ok: false, latencyMs: Date.now() - started, detail: "REDIRECT_BLOCKED" };
    }
    return { ok: res.ok, latencyMs: Date.now() - started, detail: `HTTP_${res.status}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
