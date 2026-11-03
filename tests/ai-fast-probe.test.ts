/**
 * Fast link probe — the "فحص الاتصال" number must measure the network/key
 * round-trip, not a full model generation.
 *
 * Proves:
 *  - OpenRouter is probed via the small `/api/v1/key` endpoint (not the
 *    ~800 KB `/models` payload, and definitely not a chat completion).
 *  - Any OpenAI-compatible gateway is probed via `…/models`.
 *  - 401/403 = key rejected; 404/405 = reachable but no `/models` route.
 *  - No key → no Authorization header (self-hosted gateways).
 */
import { describe, expect, it } from "vitest";
import { linkProbeUrl, probeProviderLink } from "@/modules/ai/provider";

function fakeFetch(status: number, capture: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init;
    return new Response(status === 204 ? null : "{}", { status });
  }) as typeof fetch;
}

describe("linkProbeUrl", () => {
  it("OpenRouter → /api/v1/key بدل /models الكبير", () => {
    expect(linkProbeUrl("https://openrouter.ai/api/v1/chat/completions")).toBe(
      "https://openrouter.ai/api/v1/key"
    );
  });

  it("أي بوابة متوافقة → /models من نفس القاعدة", () => {
    expect(linkProbeUrl("https://glm.example/v1/chat/completions")).toBe("https://glm.example/v1/models");
    expect(linkProbeUrl("http://host:8642/v1")).toBe("http://host:8642/v1/models");
    expect(linkProbeUrl("http://host:8642")).toBe("http://host:8642/v1/models");
  });
});

describe("probeProviderLink", () => {
  it("نجاح: طلب واحد GET على /key مع المفتاح، وزمن صغير", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const r = await probeProviderLink("https://openrouter.ai/api/v1/chat/completions", "sk-or-test", {
      fetchFn: fakeFetch(200, capture),
    });
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("LINK_OK");
    expect(capture.url).toBe("https://openrouter.ai/api/v1/key");
    expect(capture.init?.method).toBe("GET");
    expect((capture.init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.latencyMs).toBeLessThan(1000);
  });

  it("مفتاح مرفوض = فشل سريع بلا توليد", async () => {
    const r = await probeProviderLink("https://openrouter.ai/api/v1/chat/completions", "bad", {
      fetchFn: fakeFetch(401),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("AUTH_REJECTED_401");
  });

  it("404/405 = الرابط حي بس ما في مسار /models", async () => {
    const r = await probeProviderLink("https://gateway.example/v1/chat/completions", "k", {
      fetchFn: fakeFetch(404),
    });
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("LINK_OK_NO_MODELS_ROUTE");
  });

  it("بلا مفتاح: ما بينبعت Authorization (بوابة داخلية)", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const r = await probeProviderLink("http://10.0.0.5:8642/v1/chat/completions", "", {
      fetchFn: fakeFetch(200, capture),
    });
    expect(r.ok).toBe(true);
    expect(capture.url).toBe("http://10.0.0.5:8642/v1/models");
    expect((capture.init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
