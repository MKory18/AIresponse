import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import {
  AIProviderError,
  MockAIProvider,
  getAIProvider,
  resolveAIProvider,
  setMockAIProvider,
} from "@/modules/ai/provider";
import { resetEnvCache } from "@/core/env";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { processIncomingMessage } from "@/modules/conversations/service";
import { LocalStorageProvider, generateStorageKey } from "@/modules/media/storage";

const WS = "ws-prod-safety";
const AGENT = { userId: "agent-prod", workspaceId: WS };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

const SAVED_ENV = { ...process.env };

function restoreEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(SAVED_ENV)) process.env[k] = v;
  resetEnvCache();
}

beforeEach(async () => {
  db = createFakeDb();
  (db._stores.workspaceMember as any[]).push({
    id: "m-prod",
    workspaceId: WS,
    userId: AGENT.userId,
    status: "ACTIVE",
  });
  setMockAIProvider(new MockAIProvider());
  await db.aISettings.create({
    data: { workspaceId: WS, provider: "mock", temperature: 0.4, maxTokens: 500 },
  } as never);
});

afterEach(() => {
  restoreEnv();
  setMockAIProvider(new MockAIProvider());
});

describe("fail-closed AI provider resolution (pure)", () => {
  // The global injected mock short-circuits resolution at runtime; clear it
  // here so the pure fallback/throw contract is actually exercised.
  beforeEach(() => setMockAIProvider(undefined));
  afterEach(() => setMockAIProvider(new MockAIProvider()));

  it("openrouter without key throws AI_NOT_CONFIGURED (never mock)", () => {
    for (const nodeEnv of ["production", "development", "test"]) {
      expect(() =>
        resolveAIProvider({ aiProvider: "openrouter", nodeEnv })
      ).toThrow(/AI_NOT_CONFIGURED/);
    }
  });

  it("openai without key throws AI_NOT_CONFIGURED", () => {
    expect(() => resolveAIProvider({ aiProvider: "openai", nodeEnv: "production" })).toThrow(
      /OPENAI_API_KEY/
    );
  });

  it("production with no provider and no opt-in throws", () => {
    expect(() => resolveAIProvider({ nodeEnv: "production" })).toThrow(/AI_NOT_CONFIGURED/);
  });

  it("explicit ALLOW_MOCK_AI=1 in production returns mock only", () => {
    const p = resolveAIProvider({ nodeEnv: "production", allowMockAi: "1" });
    expect(p.name).toBe("mock");
  });

  it("test env keeps mock for unit tests", () => {
    expect(resolveAIProvider({ nodeEnv: "test" }).name).toBe("mock");
  });

  it("development without provider keeps mock (local DX)", () => {
    expect(resolveAIProvider({ nodeEnv: "development" }).name).toBe("mock");
  });

  it("configured openrouter + key resolves a real provider", () => {
    const p = resolveAIProvider({
      aiProvider: "openrouter",
      openrouterKey: "sk-or-test",
      nodeEnv: "production",
    });
    expect(p.name).toBe("openrouter");
  });
});

describe("fail-closed getAIProvider via env", () => {
  it("AI_PROVIDER=openrouter without key throws instead of mock", () => {
    setMockAIProvider(undefined);
    process.env.AI_PROVIDER = "openrouter";
    delete process.env.OPENROUTER_API_KEY;
    resetEnvCache();
    expect(() => getAIProvider()).toThrow(AIProviderError);
    expect(() => getAIProvider()).toThrow(/AI_NOT_CONFIGURED/);
  });
});

describe("fail-closed orchestrator: no fake replies, visible failure", () => {
  async function seedInbound(text: string) {
    const res = await processIncomingMessage(db as Db, {
      workspaceId: WS,
      channelType: "FACEBOOK",
      externalUserId: "fb-prod-user",
      externalConversationId: "fb-prod-conv",
      externalMessageId: `fb-p-${Math.random().toString(36).slice(2, 8)}`,
      externalEventId: `fb-pe-${Math.random().toString(36).slice(2, 8)}`,
      provider: "mock",
      type: "TEXT",
      text,
    });
    const inbound = (db._stores.message as any[]).find((m) => m.direction === "INBOUND");
    return { conversationId: res.conversationId, messageId: inbound.id };
  }

  it("misconfigured provider → AI_FAILED + handoff + zero outbound AI sends", async () => {
    const { conversationId, messageId } = await seedInbound("بكم السعر؟");
    setMockAIProvider(undefined);
    process.env.AI_PROVIDER = "openrouter";
    delete process.env.OPENROUTER_API_KEY;
    resetEnvCache();
    try {
      const res = await processAIMessage(
        db as Db,
        { conversationId, messageId, workspaceId: WS },
        { vectorStore: { search: async () => [] } as never }
      );
      expect(res.status).toBe("AI_FAILED");
      expect(res.error).toMatch(/AI_NOT_CONFIGURED/);
    } finally {
      restoreEnv();
      setMockAIProvider(new MockAIProvider());
    }
    // No fake AI reply was persisted or queued for sending.
    const outboundAI = (db._stores.message as any[]).filter(
      (m) => m.direction === "OUTBOUND" && m.senderType === "AI"
    );
    expect(outboundAI).toHaveLength(0);
    // Failure is visible: handoff + paused conversation + failed usage log.
    const handoffs = (db._stores.humanHandoff as any[]).filter(
      (h) => h.conversationId === conversationId && h.status === "OPEN"
    );
    expect(handoffs.length).toBeGreaterThanOrEqual(1);
    const conv = (db._stores.conversation as any[]).find((c) => c.id === conversationId);
    expect(conv.aiState).toBe("AI_PAUSED");
    const usage = (db._stores.aIUsageLog as any[]).filter(
      (u) => u.messageId === messageId && u.success === false
    );
    expect(usage.length).toBeGreaterThanOrEqual(1);
  });

  it("failed job is retryable and maps to success:false in the handler contract", async () => {
    const { processPendingJobs } = await import("@/modules/jobs/service");
    await db.backgroundJob.create({
      data: { workspaceId: WS, type: "process_ai_message", payload: {}, maxAttempts: 3 },
    } as never);
    const out = await processPendingJobs(
      db as Db,
      {
        process_ai_message: async () => ({ success: false, error: "AI_NOT_CONFIGURED test" }),
      },
      { limit: 5 }
    );
    expect(out.failed).toBe(1);
    expect((db._stores.backgroundJob as any[])[0].status).toBe("PENDING");
  });
});

describe("production storage path", () => {
  it("resolves the exact production directory from STORAGE_DIR", () => {
    const p = new LocalStorageProvider("/app/.data/storage");
    expect((p as unknown as { root: string }).root).toBe("/app/.data/storage");
  });

  it("arabic filenames + same-name uploads persist distinctly and reload", async () => {
    const root = `./.tmp-prod-safety-${Date.now()}`;
    const provider = new LocalStorageProvider(root);
    const k1 = generateStorageKey(WS, "صورة منتج.png");
    const k2 = generateStorageKey(WS, "صورة منتج.png");
    expect(k1).not.toBe(k2);
    await provider.put(k1, Buffer.from("bytes-1"), "image/png");
    await provider.put(k2, Buffer.from("bytes-2"), "image/png");
    for (const [k, want] of [[k1, "bytes-1"], [k2, "bytes-2"]] as const) {
      const got = await provider.get(k);
      expect(got).not.toBeNull();
      const chunks: Buffer[] = [];
      for await (const c of got!.stream) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe(want);
    }
    await provider.delete(k1);
    await provider.delete(k2);
    expect(await provider.get(k1)).toBeNull();
  });

  it("rejects path traversal on put", async () => {
    const provider = new LocalStorageProvider(`./.tmp-prod-safety-${Date.now()}`);
    await expect(provider.put("../../evil.png", Buffer.from("x"), "image/png")).rejects.toThrow();
  });
});
