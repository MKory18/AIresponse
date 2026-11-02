import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  AIProviderError,
  OpenAICompatibleProvider,
  normalizeHermesEndpoint,
  resolveAIProvider,
  setMockAIProvider,
} from "@/modules/ai/provider";
import { executeWithFallback, getWorkspaceProvider } from "@/modules/ai/router";
import { validateResponse } from "@/modules/ai/guardrails";
import type { AIContext } from "@/modules/ai/context-builder";

/**
 * Hermes Agent provider — unit coverage for the customer-service reply path.
 *
 * Hermes reuses the OpenAI-compatible provider class, so these tests pin:
 * endpoint normalization (/v1 → /v1/chat/completions), request/response
 * mapping, timeout + HTTP error classification, fail-closed resolution,
 * workspace selection + fallback, secret non-exposure, and the guardrail
 * invariant that a Hermes reply can never invent prices.
 */

const HERMES_ENV = {
  aiProvider: "hermes",
  hermesBaseUrl: "http://127.0.0.1:8642/v1",
  hermesKey: "hermes-test-key",
  hermesModel: "hermes-agent",
  nodeEnv: "test",
};

function hermesProvider() {
  const p = resolveAIProvider({ ...HERMES_ENV });
  if (!(p instanceof OpenAICompatibleProvider)) throw new Error("expected OpenAICompatibleProvider");
  return p;
}

function productContext(price: string): AIContext {
  return {
    product: {
      id: "p1",
      name: "منتج تجريبي",
      sku: "SKU-1",
      price,
      currency: "ل.س",
      compareAtPrice: null,
      stockStatus: "IN_STOCK",
      shortDescription: null,
      description: null,
      benefits: [],
      usage: null,
      warnings: null,
      ingredients: null,
      objections: [],
      salesNotes: null,
      faqs: [],
    },
    knowledge: { faqs: [], documents: [] },
    feedback: [],
    media: [],
    citations: [],
  };
}

describe("Hermes endpoint normalization", () => {
  it("appends /v1/chat/completions to a bare host", () => {
    expect(normalizeHermesEndpoint("http://127.0.0.1:8642")).toBe("http://127.0.0.1:8642/v1/chat/completions");
  });

  it("appends /chat/completions when the base includes /v1", () => {
    expect(normalizeHermesEndpoint("http://127.0.0.1:8642/v1")).toBe("http://127.0.0.1:8642/v1/chat/completions");
  });

  it("keeps a full chat-completions URL as-is (trailing slash tolerated)", () => {
    expect(normalizeHermesEndpoint("http://127.0.0.1:8642/v1/chat/completions/")).toBe(
      "http://127.0.0.1:8642/v1/chat/completions"
    );
  });
});

describe("Hermes provider resolution (fail-closed)", () => {
  beforeEach(() => setMockAIProvider(undefined));

  it("resolves name=hermes with the normalized endpoint and hermes-agent model", () => {
    const p = hermesProvider();
    expect(p.name).toBe("hermes");
    expect(p.endpointUrl).toBe("http://127.0.0.1:8642/v1/chat/completions");
    expect(p.defaultModelName).toBe("hermes-agent");
    expect(p.hasCredentials).toBe(true);
  });

  it("is an external-delivery provider (privacy gate keeps masking PII)", () => {
    expect(hermesProvider().delivery).toBe("external");
  });

  it("prefers HERMES_MODEL, then RESPONSE_MODEL, then hermes-agent", () => {
    expect(
      (resolveAIProvider({ ...HERMES_ENV, hermesModel: "custom-agent" }) as OpenAICompatibleProvider).defaultModelName
    ).toBe("custom-agent");
    const { hermesModel: _drop, ...noHermesModel } = HERMES_ENV;
    expect(
      (resolveAIProvider({ ...noHermesModel, responseModel: "env-model" }) as OpenAICompatibleProvider).defaultModelName
    ).toBe("env-model");
    expect((resolveAIProvider({ ...noHermesModel }) as OpenAICompatibleProvider).defaultModelName).toBe("hermes-agent");
  });

  it("throws AI_NOT_CONFIGURED (never a silent mock) when base URL or key is missing", () => {
    expect(() => resolveAIProvider({ aiProvider: "hermes", nodeEnv: "production" })).toThrow(/AI_NOT_CONFIGURED/);
    expect(() =>
      resolveAIProvider({ aiProvider: "hermes", hermesBaseUrl: "http://127.0.0.1:8642/v1", nodeEnv: "production" })
    ).toThrow(/HERMES_API_KEY/);
    expect(() => resolveAIProvider({ aiProvider: "hermes", hermesKey: "k", nodeEnv: "production" })).toThrow(
      /HERMES_BASE_URL/
    );
  });
});

describe("Hermes workspace selection", () => {
  beforeEach(() => setMockAIProvider(undefined));

  it("a workspace provider=hermes wins over an ENV openai choice", () => {
    const p = getWorkspaceProvider(
      { provider: "hermes", responseModel: "hermes-agent", customBaseUrl: null },
      { aiProvider: "openai", openaiKey: "env-key", ...HERMES_ENV, nodeEnv: "production" }
    );
    expect(p.name).toBe("hermes");
  });

  it("ENV AI_PROVIDER=hermes applies when the workspace defers (mock/unset)", () => {
    const p = getWorkspaceProvider({ provider: "mock", responseModel: null, customBaseUrl: null }, { ...HERMES_ENV });
    expect(p.name).toBe("hermes");
  });

  it("a public workspace customBaseUrl can override the ENV gateway", () => {
    const p = getWorkspaceProvider(
      { provider: "hermes", responseModel: null, customBaseUrl: "https://hermes.example.com/v1" },
      { ...HERMES_ENV }
    );
    expect((p as OpenAICompatibleProvider).endpointUrl).toBe("https://hermes.example.com/v1/chat/completions");
  });

  it("throws (fail-closed) when the Hermes key is absent", () => {
    const { hermesKey: _drop, ...noKey } = HERMES_ENV;
    expect(() =>
      getWorkspaceProvider({ provider: "hermes", responseModel: null, customBaseUrl: null }, { ...noKey })
    ).toThrow(/AI_NOT_CONFIGURED/);
  });

  it("switching back to openai needs no rebuild — pure runtime selection", () => {
    const p = getWorkspaceProvider(
      { provider: "openai", responseModel: null, customBaseUrl: null },
      { aiProvider: "hermes", openaiKey: "env-key", ...HERMES_ENV, nodeEnv: "production" }
    );
    expect(p.name).toBe("openai");
  });
});

describe("Hermes request/response mapping (OpenAI Chat Completions)", () => {
  const origFetch = globalThis.fetch;
  let lastUrl = "";
  let lastInit: RequestInit = {};
  beforeEach(() => {
    setMockAIProvider(undefined);
    lastUrl = "";
    lastInit = {};
  });
  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    delete process.env.AI_REQUEST_TIMEOUT_MS;
  });

  function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
    (globalThis as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => {
      lastUrl = String(url);
      lastInit = init;
      return handler(String(url), init);
    };
  }

  const okReply = (text: string) =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200 }
    );

  it("POSTs model + system/user messages with a Bearer key, and parses usage", async () => {
    stubFetch(async () => okReply("أهلًا فيك 🌹"));
    const res = await hermesProvider().generateText({ system: "sys", user: "بكم السعر؟" });
    expect(lastUrl).toBe("http://127.0.0.1:8642/v1/chat/completions");
    expect(lastInit.method).toBe("POST");
    expect((lastInit.headers as Record<string, string>).Authorization).toBe("Bearer hermes-test-key");
    const body = JSON.parse(String(lastInit.body));
    expect(body.model).toBe("hermes-agent");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "بكم السعر؟" },
    ]);
    expect(res.text).toBe("أهلًا فيك 🌹");
    expect(res.promptTokens).toBe(10);
    expect(res.completionTokens).toBe(5);
  });

  it("rejects empty model output (never sends a blank reply)", async () => {
    stubFetch(async () => okReply("   "));
    await expect(hermesProvider().generateText({ system: "s", user: "u" })).rejects.toThrow(/empty/i);
  });

  it("rejects unparseable JSON on the structured path", async () => {
    stubFetch(async () => okReply("not-json-at-all{{{"));
    await expect(
      hermesProvider().generateStructured({
        system: "s",
        user: "u",
        validate: (raw: unknown) => ({ ok: true, value: raw as Record<string, unknown> }),
      })
    ).rejects.toThrow();
  });

  it("classifies 429/5xx as retryable and honors Retry-After", async () => {
    stubFetch(async () => new Response("busy", { status: 429, headers: { "retry-after": "2" } }));
    const err = await hermesProvider().generateText({ system: "s", user: "u" }).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderError);
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(429);
    expect(err.retryAfterMs).toBe(2000);
  });

  it("classifies 401 as permanent (fail fast, no hammering)", async () => {
    stubFetch(async () => new Response("unauthorized", { status: 401 }));
    const err = await hermesProvider().generateText({ system: "s", user: "u" }).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderError);
    expect(err.retryable).toBe(false);
    expect(err.httpStatus).toBe(401);
  });

  it("times out a hung gateway as retryable (bounded execution)", async () => {
    process.env.AI_REQUEST_TIMEOUT_MS = "60";
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (!signal) return;
          if (signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })
    );
    const err = await hermesProvider().generateText({ system: "s", user: "u" }).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderError);
    expect(err.retryable).toBe(true);
    expect(String(err.message)).toMatch(/timed out/);
  }, 10000);
});

describe("Hermes fallback (project mechanism)", () => {
  it("runs the configured fallback only after a retryable primary failure", async () => {
    const out = await executeWithFallback(
      () => Promise.reject(new AIProviderError("gateway down", { retryable: true })),
      { fallbackModel: "hermes-agent-fallback", runFallback: async (m) => `via:${m}` }
    );
    expect(out).toEqual({ result: "via:hermes-agent-fallback", fallbackUsed: true });
  });

  it("never falls back on permanent errors (surfaces immediately)", async () => {
    let fallbackRan = false;
    await expect(
      executeWithFallback(() => Promise.reject(new AIProviderError("bad key", { retryable: false })), {
        fallbackModel: "hermes-agent-fallback",
        runFallback: async () => {
          fallbackRan = true;
          return "x";
        },
      })
    ).rejects.toThrow(/bad key/);
    expect(fallbackRan).toBe(false);
  });

  it("throws the primary error when no fallback is configured", async () => {
    await expect(
      executeWithFallback(() => Promise.reject(new AIProviderError("boom", { retryable: true })), {
        fallbackModel: null,
        runFallback: async () => "x",
      })
    ).rejects.toThrow(/boom/);
  });
});

describe("Hermes replies stay inside system rules (no invented prices/stock)", () => {
  it("rejects a Hermes reply that invents a price (PRICE_MISMATCH)", () => {
    const r = validateResponse({
      response: "السعر 75000 ل.س والتوصيل مجاني",
      context: productContext("50000"),
    });
    expect(r.valid).toBe(false);
    expect(r.violations).toContain("PRICE_MISMATCH");
  });

  it("accepts a Hermes reply that quotes the trusted DB price", () => {
    const r = validateResponse({
      response: "السعر 50000 ل.س، إذا حابب أسجل لك الطلب",
      context: productContext("50000"),
    });
    expect(r.valid).toBe(true);
  });

  it("rejects confident price claims with no product context (UNSUPPORTED_PRICE)", () => {
    const r = validateResponse({ response: "السعر 45000 ل.س متوفر", context: null });
    expect(r.valid).toBe(false);
    expect(r.violations).toContain("UNSUPPORTED_PRICE");
  });
});

describe("Hermes secret hygiene", () => {
  beforeEach(() => setMockAIProvider(undefined));

  it("fail-closed error messages name the variable, never the secret value", () => {
    const secret = "super-secret-hermes-key-123";
    let message = "";
    try {
      resolveAIProvider({ aiProvider: "hermes", hermesBaseUrl: "http://127.0.0.1:8642/v1", nodeEnv: "production" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/HERMES_API_KEY/);
    expect(message).not.toContain(secret);
    // And when the key IS provided, it never appears in safe metadata.
    const p = resolveAIProvider({
      aiProvider: "hermes",
      hermesBaseUrl: "http://127.0.0.1:8642/v1",
      hermesKey: secret,
      nodeEnv: "production",
    }) as OpenAICompatibleProvider;
    expect(p.endpointUrl).not.toContain(secret);
    expect(String(p.hasCredentials)).not.toContain(secret);
  });
});
