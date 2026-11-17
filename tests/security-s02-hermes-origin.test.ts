import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getWorkspaceProvider, resolveHermesBase } from "@/modules/ai/router";

/**
 * S-02 — حل عنوان Hermes (التفاصيل: docs/HANDOVER-2026-10-27.md §4.1).
 * عنوان من مساحة بيتقبل بس إذا نفس أصل `HERMES_BASE_URL`.
 */

const ENV = {
  aiProvider: "hermes",
  hermesBaseUrl: "https://gw.zaki.test:8642/v1",
  hermesKey: "PLATFORM-SECRET-KEY",
  hermesModel: "hermes-agent",
  nodeEnv: "test",
};

type Call = { url: string; auth: string | null };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), auth: headers.get("authorization") });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "تمام" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function ask(customBaseUrl: string | null) {
  const p = getWorkspaceProvider({ provider: "hermes", responseModel: null, customBaseUrl }, { ...ENV });
  await p.generateText({ system: "s", user: "u" });
}

describe("S-02 حل عنوان hermes", () => {
  it("عنوان بأصل مختلف ← بيتجاهل ويروح الطلب لبوابة المنصة", async () => {
    await ask("https://evil.example/collect");
    expect(calls.length).toBe(1);
    expect(calls[0].url.startsWith("https://gw.zaki.test:8642/")).toBe(true);
    for (const c of calls) {
      if (c.auth) expect(new URL(c.url).host).toBe("gw.zaki.test:8642");
    }
    expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("نفس host البوابة ← مسموح (مسار مختلف)", async () => {
    await ask("https://gw.zaki.test:8642/v1/chat/completions");
    expect(calls[0].url).toBe("https://gw.zaki.test:8642/v1/chat/completions");
    expect(calls[0].auth).toBe("Bearer PLATFORM-SECRET-KEY");
  });

  it("host شبيه (subdomain/لاحقة) ما بيمرّ", async () => {
    await ask("https://gw.zaki.test.evil.example/v1");
    await ask("https://evil.gw.zaki.test:8642/v1");
    await ask("https://gw.zaki.test:9999/v1");
    expect(calls.every((c) => c.url.startsWith("https://gw.zaki.test:8642/"))).toBe(true);
  });

  it("رابط مش صالح ← بيتجاهل ويبقى على بوابة المنصة", async () => {
    await ask("not a url");
    expect(calls[0].url.startsWith("https://gw.zaki.test:8642/")).toBe(true);
  });

  it("بدون HERMES_BASE_URL وبعنوان من المساحة ← فشل مغلق (ما بنبعت المفتاح لحدا)", async () => {
    expect(() =>
      getWorkspaceProvider(
        { provider: "hermes", responseModel: null, customBaseUrl: "https://evil.example/v1" },
        { ...ENV, hermesBaseUrl: undefined }
      )
    ).toThrow(/AI_NOT_CONFIGURED/);
    expect(calls.length).toBe(0);
  });
});

describe("S-02 مسار «اختبار الاتصال» بنفس القاعدة", () => {
  it("resolveHermesBase: غريب ← عنوان المنصة، نفس الأصل ← مقبول، بلا بيئة ← undefined", () => {
    expect(resolveHermesBase("https://evil.example/v1", "https://gw.zaki.test:8642/v1")).toBe("https://gw.zaki.test:8642/v1");
    expect(resolveHermesBase("https://gw.zaki.test:8642/x", "https://gw.zaki.test:8642/v1")).toBe("https://gw.zaki.test:8642/x");
    expect(resolveHermesBase("https://evil.example/v1", undefined)).toBeUndefined();
    expect(resolveHermesBase(null, " https://gw.zaki.test:8642/v1 ")).toBe("https://gw.zaki.test:8642/v1");
  });
  it("المسار بيستعمل resolveHermesBase مش customBaseUrl الخام", () => {
    const src = readFileSync("src/app/api/ai/providers/test/route.ts", "utf8");
    expect(src).toContain("resolveHermesBase(");
    expect(src).not.toContain("override || (env.HERMES_BASE_URL");
  });
});
