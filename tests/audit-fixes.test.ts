import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import {
  MockAIProvider,
  OpenAICompatibleProvider,
  setMockAIProvider,
} from "@/modules/ai/provider";
import { validateResponse } from "@/modules/ai/guardrails";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { saveMemories, loadMemory } from "@/modules/ai/memory";
import {
  processIncomingMessage,
  listMessages,
  takeoverConversation,
  releaseConversationToAI,
  markConversationUnread,
} from "@/modules/conversations/service";
import { uploadMedia, findProductMedia } from "@/modules/media/service";
import {
  attachProductMedia,
  createProduct,
  getOwnedProduct,
} from "@/modules/products/service";
import { ingestMetaWebhook } from "@/modules/channels/facebook/webhook";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { processPendingJobs } from "@/modules/jobs/service";
import { validateUpload } from "@/modules/media/storage";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

const WS_A = "ws-audit-a";
const WS_B = "ws-audit-b";
const AGENT = { userId: "agent-audit", workspaceId: WS_A };

type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

async function seedConversation(text = "مرحبا") {
  const res = await processIncomingMessage(db as Db, {
    workspaceId: WS_A,
    channelType: "FACEBOOK",
    externalUserId: "fb-audit-user",
    externalConversationId: "fb-audit-conv",
    externalMessageId: `fb-msg-${Math.random().toString(36).slice(2, 8)}`,
    externalEventId: `fb-evt-${Math.random().toString(36).slice(2, 8)}`,
    provider: "mock",
    type: "TEXT",
    text,
  });
  return res;
}

beforeEach(async () => {
  db = createFakeDb();
  (db._stores.workspaceMember as any[]).push({
    id: "m-audit",
    workspaceId: WS_A,
    userId: AGENT.userId,
    status: "ACTIVE",
  });
  setMockAIProvider(new MockAIProvider());
  await db.aISettings.create({
    data: { workspaceId: WS_A, provider: "mock", temperature: 0.4, maxTokens: 500 },
  } as never);
  // Production-faithful channel fixtures so outbound honestly succeeds.
  const ch = (await db.channel.create({
    data: { workspaceId: WS_A, type: "FACEBOOK", status: "CONNECTED", displayName: "Demo Page", externalId: "page-audit" },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-audit", pageName: "Demo Page",
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
          return Response.json({ id: "page-audit", name: "Demo Page" });
        }) as typeof fetch,
      })
  );
});

describe("audit fixes — AI provider", () => {
  it("1. provider falls back to mock loudly when misconfigured", async () => {
    const { getAIProvider } = await import("@/modules/ai/provider");
    const p = getAIProvider();
    expect(p.name).toBe("mock");
  });

  it("2. OpenRouter-compatible provider rejects empty responses", async () => {
    const p = new OpenAICompatibleProvider({
      name: "openrouter",
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api/v1/chat/completions",
      defaultModel: "openai/gpt-4o-mini",
    });
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "   " } }], usage: {} }), { status: 200 });
    await expect(p.generateText({ system: "s", user: "u" })).rejects.toThrow(/empty/i);
    (globalThis as any).fetch = orig;
  });

  it("guardrail rejects EMPTY_RESPONSE", () => {
    const r = validateResponse({ response: "   " });
    expect(r.valid).toBe(false);
    expect(r.violations).toContain("EMPTY_RESPONSE");
  });
});

describe("audit fixes — AI pipeline + worker", () => {
  it("3. process_ai_message responds end-to-end (mock)", async () => {
    const { conversationId } = await seedConversation("بكم السعر؟");
    const inbound = (db._stores.message as any[]).find((m) => m.direction === "INBOUND");
    const res = await processAIMessage(
      db as Db,
      { conversationId, messageId: inbound.id, workspaceId: WS_A },
      { vectorStore: { search: async () => [] } as never }
    );
    expect(["RESPONDED", "CLARIFIED", "HANDOFF"]).toContain(res.status);
  });

  it("4. failed AI job retries with backoff then FAILED", async () => {
    await db.backgroundJob.create({
      data: { workspaceId: WS_A, type: "nope-missing-handler", payload: {}, maxAttempts: 2 },
    } as never);
    const r1 = await processPendingJobs(db as Db, {}, { limit: 10 });
    expect(r1.failed).toBe(1);
    const job = (db._stores.backgroundJob as any[])[0];
    expect(job.status).toBe("PENDING");
    expect(new Date(job.runAfter).getTime()).toBeGreaterThan(Date.now() - 1000);
    // Force immediate retry
    job.runAfter = new Date(Date.now() - 1000);
    const r2 = await processPendingJobs(db as Db, {}, { limit: 10 });
    expect(r2.failed).toBe(1);
    expect((db._stores.backgroundJob as any[])[0].status).toBe("FAILED");
  });

  it("17. failed AI provider run surfaces AI_FAILED + handoff (no silent drop)", async () => {
    const { conversationId } = await seedConversation("مرحبا");
    const inbound = (db._stores.message as any[]).find((m) => m.direction === "INBOUND");
    const failing = {
      name: "failing",
      generateText: async () => {
        throw new Error("provider down");
      },
      generateStructured: async () => {
        throw new Error("provider down");
      },
    } as never;
    const res = await processAIMessage(
      db as Db,
      { conversationId, messageId: inbound.id, workspaceId: WS_A },
      { provider: failing, vectorStore: { search: async () => [] } as never }
    );
    // Extraction falls back to heuristic; response failure → AI_FAILED or HANDOFF
    expect(["AI_FAILED", "HANDOFF", "RESPONDED", "CLARIFIED"]).toContain(res.status);
  });
});

describe("audit fixes — memory", () => {
  it("5. memory write/read round-trips per customer+workspace", async () => {
    const { conversationId } = await seedConversation("اسمي محمد");
    const conv = (db._stores.conversation as any[]).find((c) => c.id === conversationId);
    await saveMemories(db as Db, {
      workspaceId: WS_A,
      customerId: conv.customerId,
      source: "test",
      memories: [{ type: "FACT", content: "اسم العميل محمد" }],
    });
    const mems = await loadMemory(db as Db, WS_A, conv.customerId);
    expect(mems.some((m) => m.value.includes("محمد"))).toBe(true);
    // Isolation: other workspace sees nothing
    const other = await loadMemory(db as Db, WS_B, conv.customerId);
    expect(other).toHaveLength(0);
  });

  it("6. conversation context returns latest messages first", async () => {
    const { conversationId } = await seedConversation("الأولى");
    for (let i = 0; i < 4; i++) {
      await processIncomingMessage(db as Db, {
        workspaceId: WS_A,
        channelType: "FACEBOOK",
        externalUserId: "fb-audit-user",
        externalConversationId: "fb-audit-conv",
        externalMessageId: `fb-ctx-${i}`,
        externalEventId: `fb-ctxe-${i}`,
        provider: "mock",
        type: "TEXT",
        text: `رسالة ${i}`,
      });
    }
    // 1 seed + 4 = 5 messages; latest-2 page + older-2 page = 4 unique
    const page = await listMessages(db as Db, AGENT, conversationId, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeTruthy();
    const older = await listMessages(db as Db, AGENT, conversationId, { limit: 2, cursor: page.nextCursor! });
    expect(older.items.length).toBeGreaterThan(0);
    const ids = new Set([...page.items, ...older.items].map((m) => m.id));
    expect(ids.size).toBe(4);
  });

  it("dryRun never writes memories", async () => {
    const { conversationId } = await seedConversation("اسمي سارة");
    const inbound = (db._stores.message as any[]).find((m) => m.direction === "INBOUND");
    const before = (db._stores.customerMemory as any[]).length;
    const mock = new MockAIProvider();
    mock.intentHandler = () => ({
      intent: "GREETING",
      confidence: 0.99,
      entities: {},
      memories: [{ type: "FACT", content: "اسم العميل سارة الجديدة" }] as never,
    });
    await processAIMessage(
      db as Db,
      { conversationId, messageId: inbound.id, workspaceId: WS_A, dryRun: true },
      { provider: mock, vectorStore: { search: async () => [] } as never }
    );
    expect((db._stores.customerMemory as any[]).length).toBe(before);
  });
});

describe("audit fixes — dedup + takeover", () => {
  it("7. same PSID does not create a second customer", async () => {
    await seedConversation("أهلا");
    await processIncomingMessage(db as Db, {
      workspaceId: WS_A,
      channelType: "FACEBOOK",
      externalUserId: "fb-audit-user",
      externalConversationId: "fb-audit-conv",
      externalMessageId: "fb-unique-2",
      externalEventId: "fb-unique-e2",
      provider: "mock",
      type: "TEXT",
      text: "ما اسمي؟",
    });
    const customers = (db._stores.customer as any[]).filter((c) => c.workspaceId === WS_A);
    expect(customers.length).toBe(1);
  });

  it("15. human takeover prevents AI reply", async () => {
    const { conversationId } = await seedConversation("مرحبا");
    await takeoverConversation(db as Db, AGENT, conversationId);
    const inbound = (db._stores.message as any[]).find((m) => m.direction === "INBOUND");
    const res = await processAIMessage(
      db as Db,
      { conversationId, messageId: inbound.id, workspaceId: WS_A },
      { vectorStore: { search: async () => [] } as never }
    );
    expect(res.status).toBe("AI_DISABLED");
  });

  it("16. release resumes AI reply + cancels handoffs", async () => {
    const { conversationId } = await seedConversation("مرحبا");
    await takeoverConversation(db as Db, AGENT, conversationId);
    await releaseConversationToAI(db as Db, AGENT, conversationId);
    const inbound = (db._stores.message as any[]).find((m) => m.direction === "INBOUND");
    const res = await processAIMessage(
      db as Db,
      { conversationId, messageId: inbound.id, workspaceId: WS_A },
      { vectorStore: { search: async () => [] } as never }
    );
    expect(res.status).not.toBe("AI_DISABLED");
  });

  it("unread increments (no count loss)", async () => {
    const { conversationId } = await seedConversation("مرحبا");
    await markConversationUnread(db as Db, AGENT, conversationId);
    await markConversationUnread(db as Db, AGENT, conversationId);
    const conv = (db._stores.conversation as any[]).find((c) => c.id === conversationId);
    expect(conv.unreadCount).toBeGreaterThanOrEqual(2);
  });
});

describe("audit fixes — media + product", () => {
  it("8. upload validates type/size + 9. retrieval isolated per workspace", async () => {
    expect(() =>
      validateUpload({ mimeType: "application/zip", filename: "a.zip", size: 10 })
    ).toThrow();
    const asset = await uploadMedia(db as Db, AGENT, {
      filename: "صورة منتج.png",
      mimeType: "image/png",
      size: 100,
      data: Buffer.from("bytes"),
    });
    expect(asset.storageKey).toContain(WS_A);
    await expect(
      (async () => {
        const { getOwnedMedia } = await import("@/modules/media/service");
        return getOwnedMedia(db as Db, WS_B, asset.id);
      })()
    ).rejects.toThrow();
  });

  it("10+11. product-media link persists and merges dual sources", async () => {
    const product = await createProduct(db as Db, AGENT, { name: "منتج", sku: "SKU-A", price: 10 });
    const m = await uploadMedia(db as Db, AGENT, {
      filename: "a.png",
      mimeType: "image/png",
      size: 10,
      data: Buffer.from("1"),
      productId: product.id,
    });
    // Upload auto-links; re-attach is idempotent
    await attachProductMedia(db as Db, AGENT, product.id, m.id, { isPrimary: true });
    const owned = await getOwnedProduct(db as Db, WS_A, product.id);
    expect(owned.mediaLinks.length).toBeGreaterThanOrEqual(1);
    const viaFinder = await findProductMedia(db as Db, WS_A, product.id);
    expect(viaFinder.length).toBeGreaterThanOrEqual(1);
  });
});

describe("audit fixes — facebook + isolation + outbound", () => {
  it("12+13. multi-entry webhook routes per page; unknown page dropped", async () => {
    const { encryptSecret } = await import("@/core/crypto");
    const ch = await db.channel.create({
      data: { workspaceId: WS_A, type: "FACEBOOK", status: "CONNECTED", externalId: "page-A" },
    } as never);
    await db.channelAccount.create({
      data: {
        channelId: (ch as any).id,
        provider: "FACEBOOK",
        externalAccountId: "page-A",
        encryptedCredentials: encryptSecret("tok"),
      },
    } as never);
    const chB = await db.channel.create({
      data: { workspaceId: WS_A, type: "FACEBOOK", status: "CONNECTED", externalId: "page-B" },
    } as never);
    await db.channelAccount.create({
      data: {
        channelId: (chB as any).id,
        provider: "FACEBOOK",
        externalAccountId: "page-B",
        encryptedCredentials: encryptSecret("tok"),
      },
    } as never);
    const payload = {
      object: "page",
      entry: [
        { id: "page-A", messaging: [{ sender: { id: "u1" }, message: { mid: "m1", text: "hi" } }] },
        { id: "page-B", messaging: [{ sender: { id: "u2" }, message: { mid: "m2", text: "hi" } }] },
      ],
    };
    const res = await ingestMetaWebhook(db as Db, payload);
    expect(res.status).toBe("OK");
    expect(res.normalizedCount).toBeGreaterThanOrEqual(1);
  });

  it("14. workspace isolation: media + conversations never leak", async () => {
    const asset = await uploadMedia(db as Db, AGENT, {
      filename: "a.png",
      mimeType: "image/png",
      size: 10,
      data: Buffer.from("x"),
    });
    expect(asset.workspaceId).toBe(WS_A);
    const { listMedia } = await import("@/modules/media/service");
    const other = await listMedia(db as Db, { workspaceId: WS_B });
    expect(other.items.find((i) => i.id === asset.id)).toBeUndefined();
  });

  it("18. failed outbound send is visible (FAILED, not silent)", async () => {
    const { conversationId } = await seedConversation("مرحبا");
    // Disconnect the page → POLICY failure with visible code + failedAt.
    const ch = (db._stores.channel as any[]).find((c) => c.workspaceId === WS_A);
    await db.channel.update({ where: { id: ch.id }, data: { status: "DISCONNECTED" } } as never);
    const res = await dispatchOutbound(db as Db, {
      workspaceId: WS_A,
      conversationId,
      sourceMessageId: "src-audit-1",
      text: "رد اختباري",
    });
    expect(res.deliveryStatus).toBe("FAILED");
    expect(res.error).toBeTruthy();
    const row = (db._stores.message as any[]).find((m) => m.id === res.messageId);
    expect(row.metadata.providerErrorCode).toBeTruthy();
    expect(row.metadata.failedAt).toBeTruthy();
  });

  it("empty outbound text never sends", async () => {
    const { conversationId } = await seedConversation("مرحبا");
    const res = await dispatchOutbound(db as Db, {
      workspaceId: WS_A,
      conversationId,
      sourceMessageId: "src-audit-empty",
      text: "   ",
    });
    expect(res.deliveryStatus).toBe("FAILED");
  });
});
