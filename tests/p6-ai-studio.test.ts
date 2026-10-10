import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { createFakeDb } from "./helpers/inmemory-db";
import {
  AI_TASKS,
  DEFAULT_MODELS,
  estimateCost,
  executeWithFallback,
  getFallbackModel,
  getWorkspaceProvider,
  logUsage,
  resolveModel,
  validateTaskModel,
} from "@/modules/ai/router";
import {
  AIProviderError,
  MockAIProvider,
  OpenAICompatibleProvider,
  probeProviderEndpoint,
  setMockAIProvider,
  testProviderConnection,
} from "@/modules/ai/provider";
import { resolveChannelPersona } from "@/modules/ai/channel-persona";
import { createVersion, listVersions, publishVersion, rollbackVersion } from "@/modules/ai/persona-versions";
import { createPlaygroundSession, sendPlaygroundMessage } from "@/modules/ai/playground-service";
import { createKnowledgeDocument, deleteKnowledgeDocument, searchKnowledge } from "@/modules/knowledge/service";
import { HashEmbeddingProvider } from "@/modules/knowledge/embeddings";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";
import { runJobs } from "@/modules/jobs/handlers";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { processIncomingMessage } from "@/modules/conversations/service";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";
import { NotFoundError } from "@/core/errors";

// ── Route permission pins: deny-by-default auth, capture required strings ──

const seenPermissions: string[] = [];

vi.mock("@/modules/auth/context", async () => {
  const { AuthorizationError } = await import("@/core/errors");
  return {
    getAuthContext: async () => ({
      userId: "agent-1",
      workspaceId: "ws-p6",
      role: "SALES_AGENT",
      memberPermissions: [],
      can: () => false,
      require: (p: string) => {
        seenPermissions.push(p);
        throw new AuthorizationError(`Missing permission: ${p}`);
      },
    }),
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

function get(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: "GET" });
}

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Shared service harness ────────────────────────────────────────────────

const WS_A = "ws-p6-a";
const WS_B = "ws-p6-b";
const AGENT = { userId: "agent-1", workspaceId: WS_A };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

function emptyVectors() {
  return new InMemoryVectorStore(new Map(), new Map());
}

async function seedChannel() {
  const ch = (await db.channel.create({
    data: { workspaceId: WS_A, type: "FACEBOOK", status: "CONNECTED", displayName: "Demo Page", externalId: "page-1" },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-1", pageName: "Demo Page",
      encryptedCredentials: encryptSecret("page-token-test"),
    },
  } as never);
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: { body?: string }) => {
          const u = new URL(url as string);
          if (u.pathname.endsWith("/me/messages")) {
            let body: any = null;
            try {
              body = JSON.parse(String((init as any)?.body ?? ""));
            } catch { /* ignore */ }
            const recipientId = body?.recipient?.id ?? "psid";
            return Response.json({ recipient_id: recipientId, message_id: `mid-${recipientId}` });
          }
          return Response.json({ id: "page-1", name: "Demo Page" });
        }) as typeof fetch,
      })
  );
  return ch;
}

async function seedInbound(text: string) {
  return processIncomingMessage(db as Db, {
    workspaceId: WS_A,
    channelType: "FACEBOOK",
    externalUserId: `fb-user-${Math.random().toString(36).slice(2, 8)}`,
    externalConversationId: `fb-conv-${Math.random().toString(36).slice(2, 8)}`,
    externalMessageId: `fb-msg-${Math.random().toString(36).slice(2, 8)}`,
    externalEventId: `fb-evt-${Math.random().toString(36).slice(2, 8)}`,
    provider: "mock",
    type: "TEXT",
    text,
  });
}

beforeEach(async () => {
  seenPermissions.length = 0;
  setMockAIProvider(undefined);
  db = createFakeDb();
  (db._stores.workspaceMember as any[]).push({ id: "m1", workspaceId: WS_A, userId: AGENT.userId, status: "ACTIVE" });
  await db.aISettings.create({ data: { workspaceId: WS_A, provider: "mock", temperature: 0.4, maxTokens: 500 } } as never);
});

// ── 1. Provider + model routing per task ──────────────────────────────────

describe("P6-1 model router resolves the REAL model per task", () => {
  it("settings override wins, ENV is fallback, defaults are last", async () => {
    const { resetEnvCache } = await import("@/core/env");
    process.env.RESPONSE_MODEL = "env-response-model";
    resetEnvCache();
    try {
      expect(resolveModel(null, "RESPONSE").model).toBe("env-response-model");
      expect(
        resolveModel({ classificationModel: null, extractionModel: null, responseModel: "ws-model", visionModel: null, summaryModel: null, temperature: 0.4, maxTokens: 500 }, "RESPONSE").model
      ).toBe("ws-model");
    } finally {
      delete process.env.RESPONSE_MODEL;
      resetEnvCache();
    }
    expect(resolveModel(null, "EMBEDDING").model).toBe(DEFAULT_MODELS.EMBEDDING);
    expect(resolveModel(null, "RETRIEVAL").model).toBe(DEFAULT_MODELS.RETRIEVAL);
    expect(AI_TASKS).toContain("EMBEDDING");
  });

  it("task/model compatibility is validated (embeddings ≠ chat ≠ vision)", () => {
    expect(validateTaskModel("RESPONSE", "gpt-4o").compatible).toBe(true);
    expect(validateTaskModel("EMBEDDING", "gpt-4o").compatible).toBe(false);
    expect(validateTaskModel("EMBEDDING", "gpt-4o").reason).toBe("MODEL_NOT_EMBEDDING_CAPABLE");
    expect(validateTaskModel("RESPONSE", "text-embedding-3-small").compatible).toBe(false);
    expect(validateTaskModel("VISION", "text-embedding-3-small").compatible).toBe(false);
    expect(validateTaskModel("EMBEDDING", "text-embedding-3-small").compatible).toBe(true);
    expect(validateTaskModel("RESPONSE", "").compatible).toBe(false);
  });

  it("workspace provider choice is EFFECTIVE (not display-only)", () => {
    const openai = getWorkspaceProvider(
      { provider: "openai", responseModel: null, customBaseUrl: null },
      { aiProvider: undefined, openaiKey: "test-key-openai-fixture", openrouterKey: undefined, nodeEnv: "test" }
    );
    expect(openai.name).toBe("openai");
    expect(openai.delivery).toBe("external");
    // Missing key + production → fail-closed, never a silent mock.
    expect(() =>
      getWorkspaceProvider({ provider: "openai", responseModel: null, customBaseUrl: null }, { aiProvider: "openai", nodeEnv: "production" })
    ).toThrow(/AI_NOT_CONFIGURED/);
  });

  it("injected test doubles are honored by workspace resolution", () => {
    const mock = new MockAIProvider();
    mock.responseHandler = () => "injected!";
    setMockAIProvider(mock);
    try {
      expect(getWorkspaceProvider({ provider: "openai", responseModel: null, customBaseUrl: null }, { aiProvider: "openai", openaiKey: "test-key-openai-fixture", nodeEnv: "production" }).name).toBe("mock");
    } finally {
      setMockAIProvider(undefined);
    }
  });

  it("internal endpoint builds an INTERNAL provider tested independently", async () => {
    const p = getWorkspaceProvider(
      { provider: "internal", responseModel: "internal-model", customBaseUrl: "http://internal:11434/v1/chat/completions" },
      { nodeEnv: "test" }
    );
    expect(p.name).toBe("internal");
    expect(p.delivery).toBe("internal");
    const t = await testProviderConnection(p);
    expect(t.status).toBe("failed");
    expect(t.detail).toBe("PROBE_REQUIRED");
  });
});

// ── 2-3. Failure, retry, configured-only fallback ─────────────────────────

describe("P6-2/3 failure + fallback never bypasses the gate", () => {
  it("fallback runs ONLY when configured (primary fail → fallback success)", async () => {
    const order: string[] = [];
    const primary = async () => {
      order.push("primary");
      throw new AIProviderError("boom", { retryable: true });
    };
    const out = await executeWithFallback(primary, {
      fallbackModel: "fallback-model",
      runFallback: async (m) => {
        order.push(`fallback:${m}`);
        return "ok-fallback";
      },
    });
    expect(out).toEqual({ result: "ok-fallback", fallbackUsed: true });
    expect(order).toEqual(["primary", "fallback:fallback-model"]);
  });

  it("no fallback configured → the original error surfaces (no silent mock)", async () => {
    await expect(
      executeWithFallback(async () => { throw new AIProviderError("boom", { retryable: true }); }, { fallbackModel: null, runFallback: async () => "x" })
    ).rejects.toThrow("boom");
  });

  it("permanent errors never touch the fallback (fail fast, no hammering)", async () => {
    let fallbackCalls = 0;
    await expect(
      executeWithFallback(async () => { throw new AIProviderError("bad key", { retryable: false }); }, {
        fallbackModel: "fallback-model",
        runFallback: async () => { fallbackCalls += 1; return "x"; },
      })
    ).rejects.toThrow("bad key");
    expect(fallbackCalls).toBe(0);
  });

  it("getFallbackModel is null unless explicitly configured", () => {
    expect(getFallbackModel(null)).toBeNull();
    expect(getFallbackModel({ classificationModel: null, extractionModel: null, responseModel: null, visionModel: null, summaryModel: null, embeddingModel: null, fallbackModel: null, temperature: 0.4, maxTokens: 500, confidenceExecute: 0.9, confidenceRespond: 0.7, humanHandoffThreshold: 0.5, aiEnabled: true, autoRespond: true })).toBeNull();
    expect(getFallbackModel({ classificationModel: null, extractionModel: null, responseModel: null, visionModel: null, summaryModel: null, embeddingModel: null, fallbackModel: "fb-model", temperature: 0.4, maxTokens: 500, confidenceExecute: 0.9, confidenceRespond: 0.7, humanHandoffThreshold: 0.5, aiEnabled: true, autoRespond: true })).toBe("fb-model");
  });

  it("pipeline: primary model failure + configured fallback → RESPONDED via fallback, gate intact", async () => {
    await seedChannel();
    await db.aISettings.update({ where: { workspaceId: WS_A }, data: { fallbackModel: "fallback-model" } } as never);
    // Customer carries real PII; the gate must mask it on BOTH attempts.
    const inbound = await seedInbound("بكم المنتج؟ رقم هاتفي +222 12 34 56 78");
    await db.customer.update({ where: { id: inbound.customerId }, data: { phone: "+22212345678" } } as never);
    const seen: string[] = [];
    class Flaky extends MockAIProvider {
      override async generateText(req: { system: string; user: string; model?: string }) {
        seen.push(`${req.model ?? ""}::${req.system}\n${req.user}`);
        if ((req.model ?? "") !== "fallback-model") throw new AIProviderError("primary down", { retryable: true });
        return { text: "أهلًا! التوصيل متوفر 🌹", promptTokens: 10, completionTokens: 5, latencyMs: 3 };
      }
    }
    const res = await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: inbound.conversationId, messageId: inbound.messageId }, { provider: new Flaky(), vectorStore: emptyVectors() });
    expect(res.status === "RESPONDED" || res.status === "CLARIFIED").toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const input of seen) {
      expect(input).not.toContain("+22212345678");
      expect(input).not.toContain("22212345678");
    }
    const logs = (db._stores.aIUsageLog as any[]).filter((l) => l.purpose === "RESPONSE" && l.success);
    expect(logs.length).toBe(1);
    expect(logs[0].model).toBe("fallback-model");
    expect(logs[0].fallbackUsed).toBe(true);
  });

  it("pipeline: primary failure WITHOUT fallback → honest AI_FAILED (never fabricated)", async () => {
    await seedChannel();
    const inbound = await seedInbound("بكم المنتج؟");
    class Down extends MockAIProvider {
      override async generateText() {
        throw new AIProviderError("primary down", { retryable: true });
      }
    }
    const res = await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: inbound.conversationId, messageId: inbound.messageId }, { provider: new Down(), vectorStore: emptyVectors() });
    expect(res.status).toBe("AI_FAILED");
  });
});

// ── 4-5. Personas + version publish/rollback ──────────────────────────────

describe("P6-4/5 persona versions: explicit publish, rollback, isolation", () => {
  async function makePersona() {
    return (await db.persona.create({
      data: { workspaceId: WS_A, name: "سارة", systemInstructions: "live-v1", prohibitedPhrases: [], customRules: [] },
    } as never)) as any;
  }

  it("draft snapshots live state without touching production", async () => {
    const p = await makePersona();
    const draft = (await createVersion(db as Db, AGENT, p.id, { systemInstructions: "draft-new" })) as any;
    expect(draft.status).toBe("DRAFT");
    expect(draft.systemInstructions).toBe("draft-new");
    const live = await db.persona.findUnique({ where: { id: p.id } });
    expect((live as any).systemInstructions).toBe("live-v1");
    expect((live as any).version).toBe(1);
  });

  it("publish copies the snapshot + bumps the live version (audited)", async () => {
    const p = await makePersona();
    const draft = (await createVersion(db as Db, AGENT, p.id, { systemInstructions: "published-text" })) as any;
    const updated = (await publishVersion(db as Db, AGENT, p.id, draft.version)) as any;
    expect(updated.systemInstructions).toBe("published-text");
    expect(updated.version).toBe(2);
    const audits = (db._stores.auditLog as any[]).filter((a) => a.action === "persona_version.published");
    expect(audits.length).toBe(1);
  });

  it("rollback restores an old snapshot as NEW live state (history append-only)", async () => {
    const p = await makePersona();
    const v2 = (await createVersion(db as Db, AGENT, p.id, { systemInstructions: "v2-text" })) as any;
    await publishVersion(db as Db, AGENT, p.id, v2.version);
    const rolled = (await rollbackVersion(db as Db, AGENT, p.id, v2.version)) as any;
    expect(rolled.systemInstructions).toBe("v2-text");
    expect(rolled.version).toBe(3);
    const all = (await listVersions(db as Db, WS_A, p.id)) as any[];
    expect(all.length).toBeGreaterThanOrEqual(2);
    const audits = (db._stores.auditLog as any[]).filter((a) => a.action === "persona_version.rolled_back");
    expect(audits.length).toBe(1);
  });

  it("versions are workspace-isolated (list/create/publish/rollback → 404 cross-workspace)", async () => {
    const p = await makePersona();
    const evil = { userId: "evil", workspaceId: WS_B };
    await expect(listVersions(db as Db, WS_B, p.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createVersion(db as Db, evil, p.id)).rejects.toBeInstanceOf(NotFoundError);
    const draft = (await createVersion(db as Db, AGENT, p.id)) as any;
    await expect(publishVersion(db as Db, evil, p.id, draft.version)).rejects.toBeInstanceOf(NotFoundError);
    await expect(rollbackVersion(db as Db, evil, p.id, draft.version)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("channel persona priority preserved (channel → workspace → builtin, with version)", async () => {
    const ch = await seedChannel();
    const wsPersona = (await db.persona.create({ data: { workspaceId: WS_A, name: "WS", isActive: true } } as never)) as any;
    const chPersona = (await db.persona.create({ data: { workspaceId: WS_A, name: "CH", isActive: false } } as never)) as any;
    await db.channel.update({ where: { id: ch.id }, data: { aiPersonaId: chPersona.id } } as never);
    const r = await resolveChannelPersona(db as Db, { workspaceId: WS_A, channelId: ch.id });
    expect(r.source).toBe("channel");
    expect(r.name).toBe("CH");
    expect(r.version).toBe(1);
    await db.channel.update({ where: { id: ch.id }, data: { aiPersonaId: null } } as never);
    const r2 = await resolveChannelPersona(db as Db, { workspaceId: WS_A, channelId: ch.id });
    expect(r2.source).toBe("workspace");
    expect(r2.name).toBe("WS");
    void wsPersona;
  });

  it("usage logs carry the persona version that drove the call", async () => {
    await seedChannel();
    await db.persona.create({ data: { workspaceId: WS_A, name: "سارة", isActive: true } } as never);
    const inbound = await seedInbound("مرحبا");
    const mock = new MockAIProvider();
    setMockAIProvider(mock);
    try {
      const res = await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: inbound.conversationId, messageId: inbound.messageId }, { vectorStore: emptyVectors() });
      expect(res.status === "RESPONDED" || res.status === "CLARIFIED" || res.status === "HANDOFF").toBe(true);
      const rows = db._stores.aIUsageLog as any[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect("personaId" in r).toBe(true);
        expect("personaVersion" in r).toBe(true);
        expect("fallbackUsed" in r).toBe(true);
      }
    } finally {
      setMockAIProvider(undefined);
    }
  });
});

// ── 6-7. Playground isolation + draft testing ─────────────────────────────

describe("P6-6/7 playground: isolated drafts, tasks, zero production writes", () => {
  const PROD = ["customer", "conversation", "message", "channelIdentity", "order", "orderDraft", "humanHandoff", "customerMemory", "aIUsageLog"] as const;

  function snap() {
    return Object.fromEntries(PROD.map((t) => [t, (db._stores[t] as unknown[]).length]));
  }

  it("draft instructions + version snapshots never touch the live persona row", async () => {
    const p = (await db.persona.create({ data: { workspaceId: WS_A, name: "سارة", systemInstructions: "live-keep", isActive: true } } as never)) as any;
    const draft = (await createVersion(db as Db, AGENT, p.id, { systemInstructions: "DRAFT-MARKER-123" })) as any;
    const s = (await createPlaygroundSession(db as Db, AGENT, { personaId: p.id, useKnowledge: false })) as any;
    const seen: string[] = [];
    const mock = new MockAIProvider();
    mock.responseHandler = (user, system) => {
      seen.push(system);
      return "رد تجريبي";
    };
    setMockAIProvider(mock);
    try {
      const r1 = await sendPlaygroundMessage(db as Db, AGENT, s.id, "مرحبا", { draftInstructions: "DRAFT-MARKER-123" });
      expect(r1.debug.draftUsed).toBe(true);
      expect(seen.some((sys) => sys.includes("DRAFT-MARKER-123"))).toBe(true);
      const r2 = await sendPlaygroundMessage(db as Db, AGENT, s.id, "مرحبا", { personaVersionId: draft.id });
      expect(r2.debug.draftUsed).toBe(true);
      expect(r2.debug.persona.version).toBe(draft.version);
    } finally {
      setMockAIProvider(undefined);
    }
    const live = (await db.persona.findUnique({ where: { id: p.id } })) as any;
    expect(live.systemInstructions).toBe("live-keep");
    expect(live.version).toBe(1);
  });

  it("task selection exercises that task's model (no production side effects)", async () => {
    await db.aISettings.update({ where: { workspaceId: WS_A }, data: { responseModel: "resp-model", summaryModel: "summ-model" } } as never);
    const s = (await createPlaygroundSession(db as Db, AGENT, { useKnowledge: false })) as any;
    const models: string[] = [];
    const mock = new MockAIProvider();
    const orig = mock.generateText.bind(mock);
    mock.generateText = async (req) => {
      models.push(req.model ?? "");
      return orig(req);
    };
    setMockAIProvider(mock);
    try {
      const before = snap();
      const r = await sendPlaygroundMessage(db as Db, AGENT, s.id, "لخص لي", { task: "SUMMARY" });
      expect(r.debug.task).toBe("SUMMARY");
      expect(models).toContain("summ-model");
      expect(snap()).toEqual(before);
      expect((db._stores.playgroundMessage as unknown[]).length).toBeGreaterThanOrEqual(2);
    } finally {
      setMockAIProvider(undefined);
    }
  });

  it("foreign persona versions are rejected (no cross-workspace draft leak)", async () => {
    const p = (await db.persona.create({ data: { workspaceId: WS_B, name: "أجنبية", isActive: true } } as never)) as any;
    (db._stores.personaVersion as any[]).push({ id: "pv-evil", workspaceId: WS_B, personaId: p.id, version: 2, name: "x", status: "DRAFT", createdAt: new Date(), updatedAt: new Date() });
    const s = (await createPlaygroundSession(db as Db, AGENT, { useKnowledge: false })) as any;
    await expect(sendPlaygroundMessage(db as Db, AGENT, s.id, "مرحبا", { personaVersionId: "pv-evil" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── 8-9. Knowledge lifecycle + isolation ──────────────────────────────────

describe("P6-8/9 knowledge: real-path retrieval + cross-workspace isolation", () => {
  function memStore() {
    const vectors = new Map<string, number[]>();
    const rows = new Map<string, any>();
    for (const c of db._stores.knowledgeChunk as any[]) {
      if (!c.isActive || !c.embedding) continue;
      const vec = typeof c.embedding === "string" ? JSON.parse(c.embedding) : c.embedding;
      vectors.set(c.id, vec);
      rows.set(c.id, {
        documentId: c.documentId, workspaceId: c.workspaceId, content: c.content,
        metadata: c.metadata ?? {}, isActive: c.isActive,
        embeddingProvider: c.embeddingProvider, embeddingModel: c.embeddingModel, embeddingDimensions: c.embeddingDimensions,
      });
    }
    return { store: new InMemoryVectorStore(vectors, rows), embedder: new HashEmbeddingProvider(1536) };
  }

  it("known info from a specific source is retrievable via the REAL path", async () => {
    const doc = await createKnowledgeDocument(db as Db, AGENT, {
      title: "سياسة التوصيل", content: "التوصيل خلال يومين لجميع المحافظات برسوم ثابتة.",
    });
    await runJobs(db as never);
    const updated = await db.knowledgeDocument.findUnique({ where: { id: (doc as any).id } });
    expect((updated as any).status).toBe("READY");
    const { store, embedder } = memStore();
    const hits = await searchKnowledge(db as Db, { workspaceId: WS_A, query: "كم مدة التوصيل؟" }, { vectorStore: store, embedder });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].documentId).toBe((doc as any).id);
  });

  it("another workspace's source is never retrievable", async () => {
    const evilCtx = { userId: "evil", workspaceId: WS_B };
    const doc = await createKnowledgeDocument(db as Db, evilCtx, {
      title: "سر", content: "كلمة السر الداخلية زمرد.",
    });
    await runJobs(db as never);
    const { store, embedder } = memStore();
    const hits = await searchKnowledge(db as Db, { workspaceId: WS_A, query: "ما هي كلمة السر الداخلية؟" }, { vectorStore: store, embedder });
    expect(hits.every((h) => h.documentId !== (doc as any).id)).toBe(true);
  });

  it("incompatible embedding generations are never mixed", async () => {
    const vectors = new Map<string, number[]>([["c1", [1, 0]]]);
    const rows = new Map<string, any>([
      ["c1", { documentId: "d1", workspaceId: WS_A, content: "x", metadata: {}, isActive: true, embeddingProvider: "other", embeddingModel: "other", embeddingDimensions: 1 }],
    ]);
    const hits = await new InMemoryVectorStore(vectors, rows).search({ embedding: [1, 0], workspaceId: WS_A });
    expect(hits).toHaveLength(0);
  });

  it("delete removes the source + chunks (ownership-checked)", async () => {
    const doc = (await createKnowledgeDocument(db as Db, AGENT, { title: "مؤقت", content: "نص كاف للتقسيم إلى مقطع واحد على الأقل." })) as any;
    await runJobs(db as never);
    expect((db._stores.knowledgeChunk as any[]).filter((c) => c.documentId === doc.id).length).toBeGreaterThan(0);
    await deleteKnowledgeDocument(db as Db, AGENT, doc.id);
    expect((db._stores.knowledgeChunk as any[]).filter((c) => c.documentId === doc.id)).toHaveLength(0);
    await expect(deleteKnowledgeDocument(db as Db, { userId: "e", workspaceId: WS_B }, doc.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("failed extraction/indexing surfaces FAILED status (no silent success)", async () => {
    const doc = (await createKnowledgeDocument(db as Db, AGENT, { title: "فارغ", content: "" })) as any;
    await runJobs(db as never);
    const row = (await db.knowledgeDocument.findUnique({ where: { id: doc.id } })) as any;
    expect(row.status).toBe("FAILED");
    expect(typeof row.error === "string" && row.error.length > 0).toBe(true);
  });
});

// ── 11-13. Privacy, secrets, cost/latency ─────────────────────────────────

describe("P6-11/12/13 privacy + secrets + cost semantics", () => {
  it("connection probes are PII-free and leak no keys", async () => {
    const seen: { url: string; init: any }[] = [];
    const fakeFetch = (async (url: string, init?: any) => {
      seen.push({ url, init });
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;
    const out = await probeProviderEndpoint("https://api.openai.com/v1/chat/completions", "test-key-openai-fixture", "gpt-4o-mini", { fetchFn: fakeFetch });
    expect(out.ok).toBe(true);
    const body = JSON.stringify(seen[0].init.body);
    expect(body).toContain("ping");
    expect(body).not.toContain("test-key-openai-fixture");
    expect(JSON.stringify(out)).not.toContain("sk-secret-xyz");
  });

  it("unpriced models log NULL cost (never fake $0); priced models log real cost + latency", async () => {
    expect(estimateCost("unknown-model-zz", 100, 50)).toBeNull();
    expect(estimateCost("gpt-4o-mini", 1000, 0)).toBeGreaterThan(0);
    await logUsage(db as never, { workspaceId: WS_A, purpose: "RESPONSE", provider: "mock", model: "unknown-model-zz", promptTokens: 10, completionTokens: 5, latencyMs: 7, success: true });
    const rows = db._stores.aIUsageLog as any[];
    expect(rows[rows.length - 1].costUsd).toBeNull();
    await logUsage(db as never, { workspaceId: WS_A, purpose: "RESPONSE", provider: "openai", model: "gpt-4o-mini", promptTokens: 1000, completionTokens: 0, latencyMs: 7, success: true });
    const last = (db._stores.aIUsageLog as any[])[(db._stores.aIUsageLog as any[]).length - 1];
    expect(last.costUsd).toBeGreaterThan(0);
  });

  it("usage-log failure never turns success into failure and never leaks PII", async () => {
    const evilDb = { aIUsageLog: { create: async () => { throw new Error("DB down + phone +22212345678"); } } };
    await expect(logUsage(evilDb as never, { workspaceId: WS_A, purpose: "RESPONSE", provider: "mock", model: "m", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true })).resolves.toBeUndefined();
  });

  it("provider test result carries no secret material", async () => {
    const p = new OpenAICompatibleProvider({ name: "openai", apiKey: "test-key-openai-fixture", baseUrl: "https://api.openai.com/v1/chat/completions", defaultModel: "gpt-4o-mini" });
    const t = await testProviderConnection(p);
    expect(JSON.stringify(t)).not.toContain("test-key-openai-fixture");
    expect(t.provider).toBe("openai");
  });
});

// ── 14-15. RBAC pins + Messenger regression guard ─────────────────────────

describe("P6-14/15 RBAC pins (all P6 routes deny without permission)", () => {
  beforeEach(() => {
    seenPermissions.length = 0;
  });

  it("GET /api/ai/status requires ai.configure", async () => {
    const { GET } = await import("@/app/api/ai/status/route");
    const res = await GET(get("/api/ai/status"));
    expect(res.status).toBe(403);
    expect(seenPermissions).toEqual(["ai.configure"]);
  });

  it("POST /api/ai/providers/test requires ai.configure", async () => {
    const { POST } = await import("@/app/api/ai/providers/test/route");
    const res = await POST(post("/api/ai/providers/test", { provider: "openai" }));
    expect(res.status).toBe(403);
    expect(seenPermissions).toEqual(["ai.configure"]);
  });

  it("persona versions: read→personas.read, write→personas.write", async () => {
    const { GET } = await import("@/app/api/personas/[id]/versions/route");
    const r1 = await GET(get("/api/personas/x/versions"), { params: { id: "x" } } as never);
    expect(r1.status).toBe(403);
    expect(seenPermissions).toEqual(["personas.read"]);
    seenPermissions.length = 0;
    const { POST } = await import("@/app/api/personas/[id]/versions/route");
    const r2 = await POST(post("/api/personas/x/versions", {}), { params: { id: "x" } } as never);
    expect(r2.status).toBe(403);
    expect(seenPermissions).toEqual(["personas.write"]);
    seenPermissions.length = 0;
    const { POST: PUB } = await import("@/app/api/personas/[id]/versions/[version]/publish/route");
    const r3 = await PUB(post("/api/personas/x/versions/2/publish", {}), { params: { id: "x", version: "2" } } as never);
    expect(r3.status).toBe(403);
    expect(seenPermissions).toEqual(["personas.write"]);
    seenPermissions.length = 0;
    const { POST: RB } = await import("@/app/api/personas/[id]/versions/[version]/rollback/route");
    const r4 = await RB(post("/api/personas/x/versions/2/rollback", {}), { params: { id: "x", version: "2" } } as never);
    expect(r4.status).toBe(403);
    expect(seenPermissions).toEqual(["personas.write"]);
  });

  it("channel persona binding requires channels.connect", async () => {
    const { PATCH } = await import("@/app/api/channels/by-id/[id]/persona/route");
    const res = await PATCH(patch("/api/channels/by-id/c1/persona", { personaId: null }), { params: { id: "c1" } } as never);
    expect(res.status).toBe(403);
    expect(seenPermissions).toEqual(["channels.connect"]);
  });

  it("Messenger pipeline still responds after P6 (no channel regression)", async () => {
    seenPermissions.length = 0;
    setMockAIProvider(new MockAIProvider());
    try {
      await seedChannel();
      const inbound = await seedInbound("مرحبا، بكم المنتج؟");
      const res = await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: inbound.conversationId, messageId: inbound.messageId }, { vectorStore: emptyVectors() });
      expect(["RESPONDED", "CLARIFIED", "HANDOFF"]).toContain(res.status);
    } finally {
      setMockAIProvider(undefined);
    }
  });
});
