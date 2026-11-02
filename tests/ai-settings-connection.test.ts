import { describe, expect, it } from "vitest";
import { GLM_ZAKIAI_PRESET, aiConnectionMode } from "@/lib/ai-connection";

describe("AI settings — connection modes", () => {
  it("custom provider owns its endpoint + key fields", () => {
    expect(aiConnectionMode("custom")).toBe("custom");
  });

  it("internal and agent providers only need an endpoint", () => {
    expect(aiConnectionMode("internal")).toBe("endpoint");
    expect(aiConnectionMode("hermes")).toBe("endpoint");
  });

  it("gateway providers keep their keys on the server environment", () => {
    for (const provider of ["openai", "openrouter", "mock"]) {
      expect(aiConnectionMode(provider)).toBe("environment");
    }
  });
});

describe("AI settings — GLM preset", () => {
  it("points at the OpenAI-compatible /v1 base URL", () => {
    expect(GLM_ZAKIAI_PRESET.baseUrl).toBe("https://glm.erv.zakiai.io/v1");
    expect(GLM_ZAKIAI_PRESET.baseUrl.endsWith("/v1")).toBe(true);
  });

  it("fills a model for every chat task", () => {
    for (const model of Object.values(GLM_ZAKIAI_PRESET.models)) {
      expect(model.trim().length).toBeGreaterThan(0);
    }
  });

  it("never carries an API key inside the preset", () => {
    expect(JSON.stringify(GLM_ZAKIAI_PRESET)).not.toMatch(/sk-[a-z0-9]/i);
  });
});
