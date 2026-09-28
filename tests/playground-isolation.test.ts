import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import {
  createPlaygroundSession,
  getPlaygroundSession,
  deletePlaygroundSession,
  sendPlaygroundMessage,
} from "@/modules/ai/playground-service";
import { createKnowledgeDocument } from "@/modules/knowledge/service";
import { HashEmbeddingProvider } from "@/modules/knowledge/embeddings";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { MockAIProvider, setMockAIProvider, resolveAIProvider } from "@/modules/ai/provider";
import { resetEnvCache } from "@/core/env";
import { createProduct } from "@/modules/products/service";
import { runJobs } from "@/modules/jobs/handlers";
import { NotFoundError } from "@/core/errors";

const WS_A = "ws-pg-a";
const WS_B = "ws-pg-b";
const ctxA = { userId: "user-1", workspaceId: WS_A };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

const PROD_TABLES = [
  "customer", "conversation", "message", "channelIdentity", "order", "orderDraft",
  "humanHandoff", "customerMemory", "aIUsageLog",
] as const;

function snapshot() {
  return Object.fromEntries(PROD_TABLES.map((t) => [t, (db._stores[t] as unknown[]).length]));
}

function sessionInput(over: Record<string, unknown> = {}) {
  return { useKnowledge: false, ...over };
}

async function memoryStore() {
  const vectors = new Map<string, number[]>();
  const rows = new Map<string, { documentId: string; workspaceId: string; content: string; metadata: Record<string, unknown>; isActive: boolean; embeddingProvider?: string; embeddingModel?: string; embeddingDimensions?: number }>();
  const embedder = new HashEmbeddingProvider(1536);
  for (const c of db._stores.knowledgeChunk as Array<{ id: string; documentId: string; content: string; workspaceId: string; isActive: boolean; embeddingProvider?: string; embeddingModel?: string; embeddingDimensions?: number }>) {
    if (!c.isActive) continue;
    vectors.set(c.id, await embedder.embed(c.content));
    rows.set(c.id, { 
      documentId: c.documentId, 
      workspaceId: c.workspaceId, 
      content: c.content, 
      metadata: {}, 
      isActive: true,
      embeddingProvider: c.embeddingProvider,
      embeddingModel: c.embeddingModel,
      embeddingDimensions: c.embeddingDimensions,
    });
  }
  return { store: new InMemoryVectorStore(vectors, rows), embedder };
}

beforeEach(() => {
  db = createFakeDb();
});

describe("PLAYGROUND isolation — sessions", () => {
  it("17. creates a session with config + 25. new session starts empty", async () => {
    const s = (await createPlaygroundSession(db as Db, ctxA, sessionInput())) as unknown as { id: string };
    const got = (await getPlaygroundSession(db as Db, ctxA, s.id)) as unknown as { messages: unknown[] };
    expect(got.messages).toHaveLength(0);
  });

  it("32. workspace isolation: foreign session is invisible", async () => {
    const s = (await createPlaygroundSession(db as Db, ctxA, sessionInput())) as unknown as { id: string };
    await expect(getPlaygroundSession(db as Db, { ...ctxA, workspaceId: WS_B }, s.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deletePlaygroundSession(db as Db, { ...ctxA, workspaceId: WS_B }, s.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deletes session + messages", async () => {
    const s = (await createPlaygroundSession(db as Db, ctxA, sessionInput())) as unknown as { id: string };
    await sendPlaygroundMessage(db as Db, ctxA, s.id, "مرحبا");
    await deletePlaygroundSession(db as Db, ctxA, s.id);
    expect((db._stores.playgroundSession as unknown[])).toHaveLength(0);
    expect((db._stores.playgroundMessage as unknown[])).toHaveLength(0);
  });
});

describe("PLAYGROUND isolation — sending never touches production", () => {
  it("18+26+27+28+29. reply works with zero production writes and zero Facebook calls", async () => {
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async () => {
            throw new Error("Facebook sender must never be called from playground");
          }) as typeof fetch,
        })
    );
    try {
      const before = snapshot();
      const s = (await createPlaygroundSession(db as Db, ctxA, sessionInput())) as unknown as { id: string };
      const reply = await sendPlaygroundMessage(db as Db, ctxA, s.id, "بكم التوصيل؟");
      expect(reply.response.length).toBeGreaterThan(0);
      expect(reply.debug.provider).not.toBe("");
      expect(snapshot()).toEqual(before);
      // Only playground tables grew (2 messages: user + assistant).
      expect((db._stores.playgroundMessage as unknown[])).toHaveLength(2);
    } finally {
      setFacebookClientFactory(undefined as never);
    }
  });

  it("24. sessions are isolated from each other", async () => {
    const a = (await createPlaygroundSession(db as Db, ctxA, sessionInput())) as unknown as { id: string };
    const b = (await createPlaygroundSession(db as Db, ctxA, sessionInput())) as unknown as { id: string };
    await sendPlaygroundMessage(db as Db, ctxA, a.id, "اسمي محمد");
    const gotB = (await getPlaygroundSession(db as Db, ctxA, b.id)) as unknown as { messages: unknown[] };
    expect(gotB.messages).toHaveLength(0);
  });

  it("24b. multi-turn context stays inside the session", async () => {
    const seen: string[] = [];
    const mock = new MockAIProvider();
    mock.responseHandler = (user) => {
      seen.push(user);
      return "أهلًا بك 🌹";
    };
    setMockAIProvider(mock);
    try {
      const s = (await createPlaygroundSession(db as Db, ctxA, sessionInput())) as unknown as { id: string };
      await sendPlaygroundMessage(db as Db, ctxA, s.id, "اسمي محمد");
      await sendPlaygroundMessage(db as Db, ctxA, s.id, "ما اسمي؟");
      expect(seen).toHaveLength(2);
      expect(seen[1]).toContain("اسمي محمد");
    } finally {
      setMockAIProvider(undefined);
    }
  });
});

describe("PLAYGROUND — persona / page / knowledge / product", () => {
  it("20. explicit persona override is used and reported", async () => {
    const persona = (await (db as { persona: { create: (a: unknown) => Promise<{ id: string }> } }).persona.create({
      data: { workspaceId: WS_A, name: "مساعد المبيعات" },
    })) as unknown as { id: string; name: string };
    const s = (await createPlaygroundSession(db as Db, ctxA, sessionInput({ personaId: persona.id }))) as unknown as { id: string };
    const reply = await sendPlaygroundMessage(db as Db, ctxA, s.id, "مرحبا");
    expect(reply.debug.persona.name).toBe("مساعد المبيعات");
  });

  it("21. page assignment resolves the page persona (never sends)", async () => {
    const persona = (await (db as { persona: { create: (a: unknown) => Promise<{ id: string }> } }).persona.create({
      data: { workspaceId: WS_A, name: "شخصية الصفحة" },
    })) as unknown as { id: string };
    const ch = (await db.channel.create({
      data: { workspaceId: WS_A, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", externalId: "page-1", aiPersonaId: persona.id },
    } as never)) as unknown as { id: string };
    const s = (await createPlaygroundSession(db as Db, ctxA, sessionInput({ channelId: ch.id }))) as unknown as { id: string };
    const reply = await sendPlaygroundMessage(db as Db, ctxA, s.id, "مرحبا");
    expect(reply.debug.persona.name).toBe("شخصية الصفحة");
    expect(reply.debug.persona.source).toBe("channel");
    expect(reply.debug.page?.id).toBe(ch.id);
  });

  it("22. knowledge retrieval feeds sources when enabled", async () => {
    await createKnowledgeDocument(db as Db, ctxA, {
      title: "الأسعار",
      content: "سعر ماء الكمأة 150000 ليرة سورية والدفع عند الاستلام.",
    });
    await runJobs(db as Db);
    const { store, embedder } = await memoryStore();
    const s = (await createPlaygroundSession(db as Db, ctxA, sessionInput({ useKnowledge: true }))) as unknown as { id: string };
    const reply = await sendPlaygroundMessage(db as Db, ctxA, s.id, "بكم ماء الكمأة؟", { vectorStore: store, embedder });
    expect(reply.debug.knowledgeUsed).toBe(true);
    expect(reply.sources.some((x) => x.kind === "document")).toBe(true);
  });

  it("23. selected product is used as trusted context (real DB price)", async () => {
    const product = (await createProduct(db as Db, ctxA, { name: "ماء الكمأة", sku: "TW-1", price: 150000, currency: "SYP" })) as unknown as { id: string };
    const s = (await createPlaygroundSession(db as Db, ctxA, sessionInput({ productId: product.id }))) as unknown as { id: string };
    const reply = await sendPlaygroundMessage(db as Db, ctxA, s.id, "بكم ماء الكمأة؟");
    expect(reply.debug.productUsed).toBe(true);
    expect(reply.sources.some((x) => x.kind === "product" && x.id === product.id)).toBe(true);
    expect(reply.response).toContain("150000");
  });
});

describe("PLAYGROUND — order dry-run + provider safety", () => {
  it("30. order proposal never creates a real Order/OrderDraft", async () => {
    const s = (await createPlaygroundSession(db as Db, ctxA, sessionInput())) as unknown as { id: string };
    const reply = await sendPlaygroundMessage(db as Db, ctxA, s.id, "بدي 2 من ماء الكمأة", { withOrderProposal: true });
    expect((db._stores.order as unknown[])).toHaveLength(0);
    expect((db._stores.orderDraft as unknown[])).toHaveLength(0);
    if (reply.orderProposal) {
      expect(reply.orderProposal.entities).toBeTruthy();
    }
  });

  it("31. mock provider is refused in production; unconfigured provider surfaces a safe message", async () => {
    expect(() => resolveAIProvider({ nodeEnv: "production" })).toThrow(/AI_NOT_CONFIGURED/);
    const prev = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = "openrouter";
    resetEnvCache();
    try {
      const s = (await createPlaygroundSession(db as Db, ctxA, sessionInput())) as unknown as { id: string };
      await expect(sendPlaygroundMessage(db as Db, ctxA, s.id, "مرحبا")).rejects.toMatchObject({
        message: "الذكاء الاصطناعي غير مهيأ",
      });
      expect((db._stores.playgroundMessage as unknown[])).toHaveLength(1); // user turn only
    } finally {
      if (prev === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = prev;
      resetEnvCache();
    }
  });
});
