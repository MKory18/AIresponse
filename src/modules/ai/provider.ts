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
  generateText(req: TextRequest): Promise<AIResponse>;
  generateStructured<T>(req: StructuredRequest<T>): Promise<AIResponse & { value: T }>;
  generateVision?(req: VisionRequest): Promise<AIResponse>;
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Shared OpenAI-compatible implementation for OpenAI & OpenRouter. */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(opts: { name: string; apiKey: string; baseUrl: string; defaultModel: string }) {
    this.name = opts.name;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.defaultModel = opts.defaultModel;
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
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new AIProviderError(`${this.name} request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
    clearTimeout(timer);
    if (!res.ok) {
      throw new AIProviderError(`${this.name} request failed with status ${res.status}`);
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

export class AIProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIProviderError";
  }
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
    responseModel: env.RESPONSE_MODEL,
    nodeEnv: process.env.NODE_ENV,
    allowMockAi: env.ALLOW_MOCK_AI,
  });
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
