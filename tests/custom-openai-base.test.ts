/**
 * CUSTOM OPENAI-COMPATIBLE BASE (OPENAI_BASE_URL) — Mock-based coverage.
 *
 * Pins: default unchanged when unset; custom root respected for chat AND
 * embeddings; malformed root fails closed (never silently falls back to
 * api.openai.com with the gateway key); error taxonomy preserved;
 * secrets never leak into errors/logs; other providers unaffected;
 * full pipeline bound to the custom host without duplicate sends.
 *
 * Live-gateway verification needs the real key (Coolify-only) and is NOT
 * claimed here — see the PR report for the owner-run checklist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import {
  AIProviderError,
  OpenAICompatibleProvider,
  openAIChatUrl,
  openAIEmbeddingsUrl,
  probeEmbeddingsEndpoint,
  probeOpenAICompatibleCaps,
  resolveOpenAIBaseRoot,
} from "@/modules/ai/provider";
import { getWorkspaceProvider } from "@/modules/ai/router";
import { OpenAIEmbeddingProvider, getEmbeddingProvider } from "@/modules/knowledge/embeddings";
import { resetEnvCache } from "@/core/env";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { processIncomingMessage } from "@/modules/conversations/service";
import {
  FacebookClient,
  setFacebookClientFactory,
} from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

const CUSTOM_ROOT = "https://gateway.example.com/v1";
const TEST_KEY = "test-key-openai-fixture";

function setBaseEnv() {
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = TEST_KEY;
  process.env.OPENAI_BASE_URL = CUSTOM_ROOT;
  resetEnvCache();
}

beforeEach(() => {
  resetEnvCache();
  delete process.env.OPENAI_BASE_URL;
});

afterEach(() => {
  delete process.env.AI_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  resetEnvCache();
  setFacebookClientFactory(undefined as never);
  vi.unstubAllGlobals();
});

describe("OPENAI_BASE_URL resolution", () => {
  it("keeps the api.openai.com default when unset", () => {
    expect(resolveOpenAIBaseRoot()).toBe("https://api.openai.com/v1");
    expect(openAIChatUrl()).toBe("https://api.openai.com/v1/chat/completions");
    expect(openAIEmbeddingsUrl()).toBe("https://api.openai.com/v1/embeddings");
  });

  it("uses the custom root and trims slashes", () => {
    expect(resolveOpenAIBaseRoot(`${CUSTOM_ROOT}///`)).toBe(CUSTOM_ROOT);
    process.env.OPENAI_BASE_URL = CUSTOM_ROOT;
    expect(openAIChatUrl()).toBe(`${CUSTOM_ROOT}/chat/completions`);
    expect(openAIEmbeddingsUrl()).toBe(`${CUSTOM_ROOT}/embeddings`);
  });

  it("fails closed on malformed roots (never silently falls back)", () => {
    for (const bad of ["not-a-url", "ftp://host/v1", "https://user:pass@host/v1", "javascript:alert(1)"]) {
      expect(() => resolveOpenAIBaseRoot(bad)).toThrow(AIProviderError);
    }
  });
});

describe("provider wiring with custom base", () => {
  it("openai provider hits the custom chat URL", () => {
    setBaseEnv();
    const p = getWorkspaceProvider({ provider: "openai", responseModel: null, customBaseUrl: null } as never);
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect((p as OpenAICompatibleProvider).endpointUrl).toBe(`${CUSTOM_ROOT}/chat/completions`);
  });

  it("openai provider keeps the default URL when unset", () => {
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = TEST_KEY;
    resetEnvCache();
    const p = getWorkspaceProvider({ provider: "openai", responseModel: null, customBaseUrl: null } as never);
    expect((p as OpenAICompatibleProvider).endpointUrl).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("other providers ignore OPENAI_BASE_URL", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = TEST_KEY;
    process.env.OPENAI_BASE_URL = CUSTOM_ROOT;
    resetEnvCache();
    const p = getWorkspaceProvider({ provider: "openrouter", responseModel: null, customBaseUrl: null } as never);
    expect((p as OpenAICompatibleProvider).endpointUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("embeddings follow the custom root", () => {
    setBaseEnv();
    const provider = getEmbeddingProvider();
    expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
    const ep = new OpenAIEmbeddingProvider("m", 1536, openAIEmbeddingsUrl());
    expect((ep as any).endpoint).toBe(`${CUSTOM_ROOT}/embeddings`);
  });

  it("sends Bearer auth to the custom host", async () => {
    const seen: { url: string; auth: string }[] = [];
    vi.stubGlobal("fetch", (async (url: any, init?: any) => {
      seen.push({ url: String(url), auth: String((init as any)?.headers?.Authorization ?? "") });
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch);
    const p = new OpenAICompatibleProvider({ name: "openai", apiKey: TEST_KEY, baseUrl: `${CUSTOM_ROOT}/chat/completions`, defaultModel: "m" });
    await p.generateText({ system: "s", user: "u" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${CUSTOM_ROOT}/chat/completions`);
    expect(seen[0].auth).toBe(`Bearer ${TEST_KEY}`);
  });

  it("classifies gateway errors: 401/404 permanent, 429/5xx transient", async () => {
    const chat = async (status: number, body: unknown) => {
      vi.stubGlobal("fetch", (async () => new Response(JSON.stringify(body), { status })) as typeof fetch);
      const p = new OpenAICompatibleProvider({ name: "openai", apiKey: TEST_KEY, baseUrl: `${CUSTOM_ROOT}/chat/completions`, defaultModel: "m" });
      try {
        await p.generateText({ system: "s", user: "u" });
        return null;
      } catch (e) {
        return e as AIProviderError;
      }
    };
    const auth = await chat(401, { error: { message: "bad key" } });
    expect(auth).toBeInstanceOf(AIProviderError);
    expect(auth!.retryable).toBe(false);
    const missing = await chat(404, { error: { message: "model not found" } });
    expect(missing!.retryable).toBe(false);
    const limited = await chat(429, { error: { message: "slow down" } });
    expect(limited!.retryable).toBe(true);
    const broken = await chat(500, {});
    expect(broken!.retryable).toBe(true);
  });

  it("rejects empty and non-conforming responses", async () => {
    vi.stubGlobal("fetch", (async () => Response.json({ choices: [{ message: { content: "   " } }] })) as typeof fetch);
    const p = new OpenAICompatibleProvider({ name: "openai", apiKey: TEST_KEY, baseUrl: `${CUSTOM_ROOT}/chat/completions`, defaultModel: "m" });
    await expect(p.generateText({ system: "s", user: "u" })).rejects.toBeInstanceOf(AIProviderError);
  });

  it("never leaks the key in errors", async () => {
    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 401 })) as typeof fetch);
    const p = new OpenAICompatibleProvider({ name: "openai", apiKey: TEST_KEY, baseUrl: `${CUSTOM_ROOT}/chat/completions`, defaultModel: "m" });
    try {
      await p.generateText({ system: "s", user: "u" });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(TEST_KEY);
    }
  });
});

describe("custom-base pipeline (mock transport)", () => {  const WS = "ws-cbase";
  const PAGE = "page-cbase";
  type Db = Prisma.TransactionClient;
  let db: ReturnType<typeof createFakeDb>;
  const stubVector = { search: async () => [] } as never;

  it("answers through the custom host exactly once (rerun duplicates nothing)", async () => {
    db = createFakeDb();
    setBaseEnv();
    const hits: string[] = [];
    vi.stubGlobal("fetch", (async (url: any, init?: any) => {
      const u = String(url);
      hits.push(u);
      if (u.startsWith(CUSTOM_ROOT) && u.endsWith("/embeddings")) {
        return Response.json({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }] });
      }
      if (u.startsWith(CUSTOM_ROOT)) {
        return Response.json({
          choices: [{ message: { content: "أهلاً، كيف أساعدك؟" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      }
      if (u.includes("graph.facebook.com") && u.includes("/me/messages")) {
        return Response.json({ recipient_id: "psid", message_id: `mid-${Date.now()}` });
      }
      if (u.includes("graph.facebook.com")) return Response.json({ id: "p", name: "P" });
      throw new Error(`unexpected external call ${u}`);
    }) as typeof fetch);
    setFacebookClientFactory(() => new FacebookClient({}));
    const ch = (await db.channel.create({
      data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "CB Page", externalId: PAGE },
    } as never)) as any;
    await db.channelAccount.create({
      data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: PAGE, pageName: "CB Page", encryptedCredentials: encryptSecret("tok-cb") },
    } as never);
    await (db as any).aISettings.create({
      data: { workspaceId: WS, provider: "openai", temperature: 0.4, maxTokens: 500, aiEnabled: true, autoRespond: true },
    });
    const r = (await processIncomingMessage(db as Db, {
      workspaceId: WS, channelType: "FACEBOOK", channelId: ch.id,
      externalUserId: "psid-cb", externalConversationId: "psid-cb",
      externalMessageId: "m-cb", externalEventId: "e-cb",
      provider: "facebook", type: "TEXT", text: "مرحبا",
    })) as any;
    const out = await processAIMessage(db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS }, { vectorStore: stubVector });
    expect(["RESPONDED", "CLARIFIED"].includes((out as { status: string }).status)).toBe(true);
    // Chat + embeddings both went to the custom gateway, never api.openai.com.
    expect(hits.some((h) => h.startsWith(`${CUSTOM_ROOT}/chat/completions`))).toBe(true);
    expect(hits.some((h) => h.startsWith(`${CUSTOM_ROOT}/embeddings`))).toBe(true);
    expect(hits.some((h) => h.includes("api.openai.com"))).toBe(false);
    const sent = (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND" && m.deliveryStatus === "SENT");
    expect(sent).toHaveLength(1);
    // Rerun: DUPLICATE terminal, still exactly one SENT row.
    const again = await processAIMessage(db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS }, { vectorStore: stubVector });
    expect((again as { status: string }).status).toBe("DUPLICATE");
    const sentAfter = (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND" && m.deliveryStatus === "SENT");
    expect(sentAfter).toHaveLength(1);
  }, 120000);
});

describe("embeddings capability probe", () => {
  const EMB_URL = `${CUSTOM_ROOT}/embeddings`;

  function mockFetch(handler: (url: string) => Response) {
    vi.stubGlobal("fetch", (async (url: any) => handler(String(url))) as typeof fetch);
  }

  it("reports working + actual dimensions on success", async () => {
    mockFetch((u) => {
      expect(u).toBe(EMB_URL);
      return Response.json({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.02) }] });
    });
    const r = await probeEmbeddingsEndpoint(EMB_URL, TEST_KEY, "emb-model");
    expect(r.ok).toBe(true);
    expect(r.dimensions).toBe(1536);
    expect(r.model).toBe("emb-model");
    expect(r.detail).toBe("HTTP_200");
  });

  it("classifies 401/404 distinctly from timeouts and bad shapes", async () => {
    mockFetch(() => new Response("{}", { status: 401 }));
    expect((await probeEmbeddingsEndpoint(EMB_URL, TEST_KEY, "m")).detail).toBe("HTTP_401");
    mockFetch(() => new Response("{}", { status: 404 }));
    expect((await probeEmbeddingsEndpoint(EMB_URL, TEST_KEY, "m")).detail).toBe("HTTP_404");
    mockFetch(() => Response.json({ data: [{ embedding: "oops" }] }));
    expect((await probeEmbeddingsEndpoint(EMB_URL, TEST_KEY, "m")).detail).toBe("BAD_RESPONSE_SHAPE");
    mockFetch(() => Response.json({ data: [] }));
    expect((await probeEmbeddingsEndpoint(EMB_URL, TEST_KEY, "m")).detail).toBe("BAD_RESPONSE_SHAPE");
  });

  it("never leaks the key in results", async () => {
    mockFetch(() => new Response("denied", { status: 401 }));
    const r = await probeEmbeddingsEndpoint(EMB_URL, TEST_KEY, "m");
    expect(JSON.stringify(r)).not.toContain(TEST_KEY);
  });

  it("aggregate is failed when chat works but embeddings fail", async () => {
    mockFetch((u) => {
      if (u.endsWith("/embeddings")) return new Response("{}", { status: 404 });
      return Response.json({ choices: [{ message: { content: "hi" } }] });
    });
    const caps = await probeOpenAICompatibleCaps({
      chatUrl: `${CUSTOM_ROOT}/chat/completions`,
      embeddingsUrl: EMB_URL,
      apiKey: TEST_KEY,
      chatModel: "chat-m",
      embeddingsModel: "emb-m",
    });
    expect(caps.chat.ok).toBe(true);
    expect(caps.embeddings.ok).toBe(false);
    expect(caps.status).toBe("failed");
    expect(caps.detail).toContain("EMB_HTTP_404");
  });

  it("aggregate is working only when both pass", async () => {
    mockFetch((u) => {
      if (u.endsWith("/embeddings")) {
        return Response.json({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }] });
      }
      return Response.json({ choices: [{ message: { content: "hi" } }] });
    });
    const caps = await probeOpenAICompatibleCaps({
      chatUrl: `${CUSTOM_ROOT}/chat/completions`,
      embeddingsUrl: EMB_URL,
      apiKey: TEST_KEY,
      chatModel: "chat-m",
      embeddingsModel: "emb-m",
    });
    expect(caps.status).toBe("working");
    expect(caps.embeddings.dimensions).toBe(1536);
  });
});
