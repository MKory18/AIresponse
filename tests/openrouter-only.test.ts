import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveAIProvider, OpenAICompatibleProvider } from "@/modules/ai/provider";
import { getWorkspaceProvider, DEFAULT_MODELS } from "@/modules/ai/router";
import { DEFAULT_OPENROUTER_GLM_MODEL, openRouterModel } from "@/modules/ai/config";

describe("OpenRouter is the only external provider", () => {
  it("resolves OpenRouter with the configured GLM id", () => {
    const p = resolveAIProvider({ aiProvider: "openrouter", openrouterKey: "sk-or-test", nodeEnv: "production" });
    expect(p.name).toBe("openrouter");
    expect(p.delivery).toBe("external");
    expect((p as OpenAICompatibleProvider).defaultModelName).toBe(DEFAULT_OPENROUTER_GLM_MODEL);
  });

  it("maps local gateway aliases to a real OpenRouter GLM id", () => {
    expect(openRouterModel("auto/best-chat")).toBe(DEFAULT_OPENROUTER_GLM_MODEL);
    expect(openRouterModel("z-ai/glm-4.6")).toBe("z-ai/glm-4.6");
    for (const task of ["CLASSIFICATION", "EXTRACTION", "RESPONSE", "VISION", "SUMMARY"] as const) {
      expect(DEFAULT_MODELS[task]).toMatch(/^z-ai\//);
    }
  });

  it("legacy workspace/env provider 'openai' maps to OpenRouter, never OpenAI", () => {
    const p = getWorkspaceProvider(
      { provider: "openai", responseModel: "auto/best-chat" },
      { openrouterKey: "sk-or-test", nodeEnv: "production" }
    );
    expect(p.name).toBe("openrouter");
    const q = resolveAIProvider({ aiProvider: "openai", openrouterKey: "sk-or-test", nodeEnv: "production" });
    expect(q.name).toBe("openrouter");
  });

  it("fails closed without a key (never a fake reply)", () => {
    expect(() => resolveAIProvider({ aiProvider: "openrouter", nodeEnv: "production" })).toThrow(/OPENROUTER_API_KEY/);
    expect(() =>
      getWorkspaceProvider({ provider: "openrouter" }, { openrouterKey: "", nodeEnv: "production" })
    ).toThrow(/OPENROUTER_API_KEY/);
  });

  it("no removed provider name remains in src", () => {
    const files = readdirSync("src", { recursive: true }) as string[];
    const hits = files.filter((f) => {
      if (!/\.(ts|tsx)$/.test(f)) return false;
      return /hermes/i.test(readFileSync(join("src", f), "utf8"));
    });
    expect(hits).toEqual([]);
  });
});
