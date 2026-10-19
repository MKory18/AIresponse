import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeOpenAiCompatibleEndpoint,
  normalizeOpenAiEmbeddingsEndpoint,
  resolveAIProvider,
  type AIProvider,
} from "@/modules/ai/provider";
import { OpenAIEmbeddingProvider } from "@/modules/knowledge/embeddings";
import { resetEnvCache } from "@/core/env";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

const baseEnv = {
  aiProvider: "openai",
  openaiKey: "sk-test-000000000000000000000000",
  nodeEnv: "test",
} as never as Parameters<typeof resolveAIProvider>[1];

describe("OPENAI_BASE_URL — بوابة OpenAI-compatible للمنصة", () => {
  it("بلا OPENAI_BASE_URL = عنوان OpenAI الرسمي (سلوك قديم)", () => {
    const p = resolveAIProvider(baseEnv);
    expect((p as AIProvider).name).toBe("openai");
    expect((p as { endpointUrl?: string }).endpointUrl).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("مع OPENAI_BASE_URL: الشات يوجّه للبوابة ولا موقع رسمي ما بيدخله الطلب", () => {
    const p = resolveAIProvider({ ...baseEnv, openaiBaseUrl: "https://glm.erv.zakiai.io/v1" });
    expect((p as { endpointUrl?: string }).endpointUrl).toBe("https://glm.erv.zakiai.io/v1/chat/completions");
    expect((p as { endpointUrl?: string }).endpointUrl).not.toContain("api.openai.com");
  });

  it("عنوان بلا /v1 بيتطبع لـ /v1/chat/completions", () => {
    expect(normalizeOpenAiCompatibleEndpoint("https://gw.example.com")).toBe("https://gw.example.com/v1/chat/completions");
    expect(normalizeOpenAiCompatibleEndpoint("https://gw.example.com/v1/")).toBe("https://gw.example.com/v1/chat/completions");
  });

  it("رفض: مخطط غير http(s) · رابط معطوب · credentials داخل الرابط · بلا مفتاح", () => {
    expect(normalizeOpenAiCompatibleEndpoint("ftp://gw.example.com")).toBeNull();
    expect(normalizeOpenAiCompatibleEndpoint(":\\bad url")).toBeNull();
    expect(normalizeOpenAiCompatibleEndpoint("https://user:pass@gw.example.com")).toBeNull();
    expect(() => resolveAIProvider({ aiProvider: "openai", openaiKey: undefined, nodeEnv: "production" } as never)).toThrowError(/AI_NOT_CONFIGURED/);
    expect(() =>
      resolveAIProvider({ ...baseEnv, openaiBaseUrl: "not-a-url" } as never)
    ).toThrowError(/AI_NOT_CONFIGURED/);
  });

  it("workspace customBaseUrl يعمل بـ openRouter/Hermes زي ما كان — ولا تأثر", () => {
    const p = resolveAIProvider({
      aiProvider: "openrouter",
      openrouterKey: "sk-test-000000000000000000000000",
      nodeEnv: "test",
    } as never);
    expect((p as { endpointUrl?: string }).endpointUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("embeddings: البوابة المخصصة بتحملها لـ /v1/embeddings · الرسمي الافتراضي", async () => {
    const viaGateway = new OpenAIEmbeddingProvider(undefined, 1536, "https://glm.erv.zakiai.io/v1");
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {        calls.push({ url, headers: init?.headers ?? {}, body: init?.body });
        return new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.1) }] }), { status: 200 });
      })
    );
    vi.stubEnv("AI_ALLOW_EXTERNAL_EMBEDDINGS", "1");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-000000000000000000000000");
    resetEnvCache();
    const vec = await viaGateway.embed("نص تجريبي 0500000000");
    expect(calls[0].url).toBe("https://glm.erv.zakiai.io/v1/embeddings");
    expect(calls[0].headers.Authorization).toMatch(/^Bearer /);
    // بوابة الخصوصية: الأرقام محجوبة قبل الإرسال
    expect(JSON.stringify(calls[0].body)).not.toContain("0500000000");
    expect(vec).toHaveLength(1536);
  });

  it("embeddings: بلا بوابة = OpenAI الرسمي (سلوك قديم) + بيانات الشات ما بتنخرض معها", async () => {
    const official = new OpenAIEmbeddingProvider();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0) }] }), { status: 200 });
      })
    );
    vi.stubEnv("AI_ALLOW_EXTERNAL_EMBEDDINGS", "1");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-000000000000000000000000");
    resetEnvCache();
    await official.embed("ping");
    expect(calls[0]).toBe("https://api.openai.com/v1/embeddings");
  });
});
