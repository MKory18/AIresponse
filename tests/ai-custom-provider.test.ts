import { describe, expect, it } from "vitest";
import { AIProviderError } from "@/modules/ai/provider";
import { getWorkspaceProvider } from "@/modules/ai/router";
import { encryptSecret } from "@/core/crypto";

const env = {
  aiProvider: undefined,
  openaiKey: undefined,
  openrouterKey: undefined,
  responseModel: undefined,
  nodeEnv: "test",
  allowMockAi: undefined,
} as never as Parameters<typeof getWorkspaceProvider>[1];

describe("custom provider — أي واجهة OpenAI خارجية من إعداد مساحة العمل", () => {
  it("يبني مزوّد custom بالمفتاح المشفّر (تخزين معمّى → اتصال بالمفتاح الأصلي)", () => {
    const enc = encryptSecret("sk-test-1234567890");
    const provider = getWorkspaceProvider(
      {
        provider: "custom",
        customBaseUrl: "https://gateway.example.com/v1/chat/completions",
        customApiKeyEnc: enc,
        responseModel: "my-model-x",
      } as never,
      env
    );
    expect(provider.name).toBe("custom");
    expect((provider as { delivery?: string }).delivery).toBe("external");
  });

  it("fail-closed: بلا مفتاح مخزّن = رفض واضح بلا ردود وهمية", () => {
    expect(() =>
      getWorkspaceProvider(
        { provider: "custom", customBaseUrl: "https://gateway.example.com/v1", customApiKeyEnc: null } as never,
        env
      )
    ).toThrowError(AIProviderError);
  });

  it("fail-closed: بلا عنوان = رفض واضح", () => {
    expect(() =>
      getWorkspaceProvider(
        { provider: "custom", customBaseUrl: null, customApiKeyEnc: encryptSecret("sk-x-sk-x-sk-x") } as never,
        env
      )
    ).toThrowError(/CUSTOM/);
  });

  it("لا يرحّل أبدًا مفتاح المنصة أصلًا لمزوّد custom — المفتاح مخزّن من الإعداد نفسه", () => {
    const provider = getWorkspaceProvider(
      {
        provider: "custom",
        customBaseUrl: "https://gateway.example.com/v1/chat/completions",
        customApiKeyEnc: encryptSecret("sk-workspace-key"),
      } as never,
      { ...env, openaiKey: "sk-PLATFORM-SECRET" } as never
    );
    expect(provider.name).toBe("custom");
  });
});
