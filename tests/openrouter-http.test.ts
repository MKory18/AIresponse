import { afterEach, describe, expect, it, vi } from "vitest";
import { AIProviderError, OpenAICompatibleProvider } from "@/modules/ai/provider";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.AI_REQUEST_TIMEOUT_MS;
});

function provider() {
  return new OpenAICompatibleProvider({
    name: "openrouter",
    apiKey: "sk-or-secret-not-in-errors",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "z-ai/glm-4.6",
    modelMap: (m) => (m.startsWith("auto/") ? "z-ai/glm-4.6" : m),
  });
}

function errorOf(fn: Promise<unknown>): Promise<AIProviderError> {
  return fn.then(
    () => {
      throw new Error("expected failure");
    },
    (e) => e as AIProviderError
  );
}

describe("OpenRouter HTTP error contract", () => {
  it("401 is permanent, 429/5xx are retryable, key never appears", async () => {
    global.fetch = vi.fn(async () => new Response("{}", { status: 401 })) as never;
    const e401 = await errorOf(provider().generateText({ system: "s", user: "u" }));
    expect(e401.httpStatus).toBe(401);
    expect(e401.retryable).toBe(false);
    expect(e401.message).not.toContain("sk-or-secret");

    global.fetch = vi.fn(async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "2" } })
    ) as never;
    const e429 = await errorOf(provider().generateText({ system: "s", user: "u" }));
    expect(e429.retryable).toBe(true);
    expect(e429.retryAfterMs).toBe(2000);

    global.fetch = vi.fn(async () => new Response("{}", { status: 503 })) as never;
    const e503 = await errorOf(provider().generateText({ system: "s", user: "u" }));
    expect(e503.retryable).toBe(true);
    expect(e503.httpStatus).toBe(503);
  });

  it("timeout is retryable and never leaks the key", async () => {
    global.fetch = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as never;
    const err = await errorOf(provider().generateText({ system: "s", user: "u" }));
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/timed out/i);
    expect(err.message).not.toContain("sk-or-secret");
  });

  it("maps the local GLM alias to the configured OpenRouter model", async () => {
    let body: Record<string, unknown> = {};
    global.fetch = vi.fn(async (_url: string, init: { body?: string }) => {
      body = JSON.parse(String(init.body ?? "{}"));
      return Response.json({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }) as never;
    await provider().generateText({ system: "s", user: "u", model: "auto/best-chat" });
    expect(body.model).toBe("z-ai/glm-4.6");
  });
});
