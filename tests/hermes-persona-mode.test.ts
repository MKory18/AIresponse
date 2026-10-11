import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { MockAIProvider, setMockAIProvider } from "@/modules/ai/provider";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { processIncomingMessage } from "@/modules/conversations/service";
import { createProduct } from "@/modules/products/service";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

/**
 * Hermes external-persona mode — mandatory coverage through the REAL reply
 * path (processAIMessage with the workspace AISettings.provider=hermes, no
 * injected provider double). Hermes owns reply personality; Zaki AI keeps
 * privacy, prices, orders, and workspace isolation.
 */

const WS = "ws-hermes-persona";
const WS_OTHER = "ws-hermes-other";
const HERMES_BASE = "http://127.0.0.1:8642/v1";
const HERMES_KEY = "zz-hermes-e2e-key-451";
const HERMES_ENDPOINT = "http://127.0.0.1:8642/v1/chat/completions";

type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
let fetchCalls: { url: string; init: RequestInit; body: any }[] = [];
let extractionResponder: ((body: any) => Record<string, unknown>) | null = null;
let replyResponder: string | { throw: unknown } = "أهلًا فيك 🌹 كيف فيني ساعدك؟";
const origFetch = globalThis.fetch;

function okChat(text: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 20, completion_tokens: 8 } }),
    { status: 200 }
  );
}

const DEFAULT_EXTRACTION = {
  intent: "GREETING",
  confidence: 0.95,
  entities: {},
  missingFields: [],
  memories: [],
  requestedAction: "ANSWER",
};

function stubHermesFetch() {
  (globalThis as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => {
    let body: any = null;
    try {
      body = JSON.parse(String((init as any)?.body ?? ""));
    } catch {
      /* ignore */
    }
    fetchCalls.push({ url: String(url), init, body });
    const system: string = body?.messages?.[0]?.content ?? "";
    if (system.includes("JSON")) {
      const value = extractionResponder ? extractionResponder(body) : DEFAULT_EXTRACTION;
      return okChat(JSON.stringify(value));
    }
    if (typeof replyResponder === "object" && replyResponder !== null && "throw" in replyResponder) {
      throw (replyResponder as { throw: unknown }).throw;
    }
    return okChat(replyResponder as string);
  };
}

function authzOf(call: { init: RequestInit }) {
  return ((call.init.headers ?? {}) as Record<string, string>).Authorization ?? "";
}

function systemsOf() {
  return fetchCalls.map((c) => String(c.body?.messages?.[0]?.content ?? ""));
}

async function seedConversation(text: string, suffix: string, workspaceId = WS) {
  return processIncomingMessage(db as Db, {
    workspaceId,
    channelType: "FACEBOOK",
    externalUserId: `fb-hermes-user-${suffix}`,
    externalConversationId: `fb-hermes-conv-${suffix}`,
    externalMessageId: `fb-hermes-msg-${suffix}`,
    externalEventId: `fb-hermes-evt-${suffix}`,
    provider: "mock",
    type: "TEXT",
    text,
  });
}

async function runReply(conversationId: string, messageId: string, workspaceId = WS) {
  return processAIMessage(
    db as Db,
    { conversationId, messageId, workspaceId },
    { vectorStore: { search: async () => [] } as never }
  );
}

const outboundTexts = () =>
  (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND").map((m) => m.text);
const handoffCount = () => (db._stores.humanHandoff as any[]).length;
const usageFor = (messageId: string) =>
  (db as any).aIUsageLog.findMany({ where: { messageId } }) as any[];
const conversationOf = (id: string) =>
  (db as any).conversation.findUnique({ where: { id } }) as any;

async function seedHermesWorkspace() {
  await db.aISettings.create({
    data: {
      workspaceId: WS,
      provider: "hermes",
      responseModel: "hermes-agent",
      temperature: 0.4,
      maxTokens: 500,
      aiEnabled: true,
      autoRespond: true,
      // Suspended in Hermes mode — set aggressively to prove they are ignored.
      humanHandoffThreshold: 0.99,
      fallbackModel: "should-never-be-used",
    },
  } as never);
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "Demo Page", externalId: "page-hermes" },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-hermes", pageName: "Demo Page",
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
          return Response.json({ id: "page-hermes", name: "Demo Page" });
        }) as typeof fetch,
      })
  );
}

let prevEnv: Record<string, string | undefined>;
beforeEach(async () => {
  db = createFakeDb();
  (db._stores.workspaceMember as any[]).push({ id: "m-hermes", workspaceId: WS, userId: "agent-hermes", status: "ACTIVE" });
  prevEnv = {
    HERMES_BASE_URL: process.env.HERMES_BASE_URL,
    HERMES_API_KEY: process.env.HERMES_API_KEY,
    HERMES_MODEL: process.env.HERMES_MODEL,
  };
  process.env.HERMES_BASE_URL = HERMES_BASE;
  process.env.HERMES_API_KEY = HERMES_KEY;
  delete process.env.HERMES_MODEL;
  setMockAIProvider(undefined);
  fetchCalls = [];
  extractionResponder = null;
  replyResponder = "أهلًا فيك 🌹 كيف فيني ساعدك؟";
  stubHermesFetch();
  await seedHermesWorkspace();
});

afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = origFetch;
  setMockAIProvider(undefined);
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("Hermes persona mode — actual reply path uses Hermes", () => {
  it("1+5+8+15. Hermes generates the reply; conversation stays OPEN/AI_ACTIVE; usage proves the provider", async () => {
    const { conversationId, messageId } = await seedConversation("مرحبا", "t1");
    const res = await runReply(conversationId, messageId);
    expect(res.status).toBe("RESPONDED");
    // The real Hermes endpoint received the call with the server key.
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const c of fetchCalls) {
      expect(c.url).toBe(HERMES_ENDPOINT);
      expect(authzOf(c)).toBe(`Bearer ${HERMES_KEY}`);
      expect(c.body?.model).toBe("hermes-agent");
    }
    // Customer received exactly the Hermes text.
    expect(outboundTexts()).toEqual(["أهلًا فيك 🌹 كيف فيني ساعدك؟"]);
    // Conversation untouched: OPEN, AI_ACTIVE, never closed or taken over.
    const conv = await conversationOf(conversationId);
    expect(conv.status).toBe("OPEN");
    expect(conv.aiState).toBe("AI_ACTIVE");
    // Telemetry: hermes provider, no local persona, no fallback.
    const rows = await usageFor(messageId);
    const resp = rows.find((r) => r.purpose === "RESPONSE" && r.status === "SUCCESS");
    expect(resp.provider).toBe("hermes");
    expect(resp.model).toBe("hermes-agent");
    expect(resp.personaId).toBeNull();
    expect(resp.personaVersion).toBeNull();
    expect(resp.fallbackUsed).toBe(false);
    expect(handoffCount()).toBe(0);
  });

  it("2+3. no local persona or version leaks into Hermes requests", async () => {
    const persona = (await db.persona.create({
      data: {
        workspaceId: WS, name: "بائع-زقزوق-UNIQUE", language: "ar", dialect: "مريخية-UNIQUE",
        tone: "t", formality: "informal", responseLength: "short", emojiLevel: 1, salesStyle: "s",
        systemInstructions: "MARKER-UNIQUE-123", prohibitedPhrases: ["عبارة-UNIQUE-456"], customRules: [],
        isActive: true, version: 5,
      },
    } as never)) as any;
    const ch = (db._stores.channel as any[])[0];
    await (db as any).channel.update({ where: { id: ch.id }, data: { aiPersonaId: persona.id } });
    const { conversationId, messageId } = await seedConversation("مرحبا", "t2");
    const res = await runReply(conversationId, messageId);
    expect(res.status).toBe("RESPONDED");
    const blob = systemsOf().join("\n");
    for (const marker of ["زقزوق-UNIQUE", "MARKER-UNIQUE-123", "مريخية-UNIQUE", "عبارة-UNIQUE-456"]) {
      expect(blob).not.toContain(marker);
    }
    const rows = await usageFor(messageId);
    for (const r of rows) {
      expect(r.personaId).toBeNull();
      expect(r.personaVersion).toBeNull();
    }
  });

  it("4. configured fallback model is never used behind Hermes", async () => {
    replyResponder = { throw: new Error("hermes down") };
    const { conversationId, messageId } = await seedConversation("مرحبا", "t4");
    const res = await runReply(conversationId, messageId);
    expect(res.status).toBe("AI_FAILED");
    // Every attempt targeted Hermes with the same model — no substitute.
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const c of fetchCalls) {
      expect(c.url).toBe(HERMES_ENDPOINT);
      expect(c.body?.model).toBe("hermes-agent");
    }
    const rows = await usageFor(messageId);
    expect(rows.some((r) => r.fallbackUsed)).toBe(false);
    expect(outboundTexts()).toEqual([]);
  });

  it("6+16. Hermes failure keeps OPEN, creates no handoff, sends nothing, mutates no orders", async () => {
    replyResponder = { throw: new Error("hermes down") };
    const { conversationId, messageId } = await seedConversation("مرحبا", "t6");
    const res = await runReply(conversationId, messageId);
    expect(res.status).toBe("AI_FAILED");
    const conv = await conversationOf(conversationId);
    expect(conv.status).toBe("OPEN");
    expect(conv.aiState).toBe("AI_ACTIVE");
    expect(handoffCount()).toBe(0);
    expect(outboundTexts()).toEqual([]);
    expect((db._stores.order as any[]).length).toBe(0);
    const rows = await usageFor(messageId);
    expect(rows.some((r) => r.status === "AI_FAILED")).toBe(true);
  });

  it("7. complaints and human requests are answered by Hermes — zero handoffs, no confidence gating", async () => {
    extractionResponder = () => ({
      intent: "COMPLAINT", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER",
    });
    const c1 = await seedConversation("الخدمة سيئة جدا والتوصيل تأخر كثيرا علي", "t7a");
    expect((await runReply(c1.conversationId, c1.messageId)).status).toBe("RESPONDED");
    extractionResponder = () => ({
      intent: "HUMAN_REQUEST", confidence: 0.95, entities: {}, missingFields: [], memories: [], requestedAction: "HANDOFF_HUMAN",
    });
    const c2 = await seedConversation("بدي احكي مع موظف حقيقي لو سمحت ضروري", "t7b");
    expect((await runReply(c2.conversationId, c2.messageId)).status).toBe("RESPONDED");
    extractionResponder = () => ({
      intent: "UNKNOWN", confidence: 0.05, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER",
    });
    const c3 = await seedConversation("هممم يعني ما بعرف شو بدي اسأل بالضبط عن هالموضوع", "t7c");
    // UNKNOWN → clarification question: still a Hermes reply, never a handoff.
    expect(["RESPONDED", "CLARIFIED"]).toContain((await runReply(c3.conversationId, c3.messageId)).status);
    expect(handoffCount()).toBe(0);
    expect(outboundTexts().length).toBe(3);
  });

  it("9. per-customer context isolation (no cross-talk)", async () => {
    const c1 = await seedConversation("عندي استفسار عن كلمة-ألفا-111 للمنتج", "t9a");
    await runReply(c1.conversationId, c1.messageId);
    const before = fetchCalls.length;
    const c2 = await seedConversation("مرحبا بدي اسأل عن كلمة-بيتا-222", "t9b");
    await runReply(c2.conversationId, c2.messageId);
    const blob = fetchCalls.slice(before).map((c) => JSON.stringify(c.body)).join("\n");
    expect(blob).toContain("بيتا-222");
    expect(blob).not.toContain("ألفا-111");
  });

  it("10. retrying the same message never sends twice", async () => {
    const { conversationId, messageId } = await seedConversation("مرحبا", "t10");
    expect((await runReply(conversationId, messageId)).status).toBe("RESPONDED");
    expect((await runReply(conversationId, messageId)).status).toBe("DUPLICATE");
    expect(outboundTexts()).toEqual(["أهلًا فيك 🌹 كيف فيني ساعدك؟"]);
  });

  it("11. every external call passes the privacy gate (PII masked, never raw)", async () => {
    const { conversationId, messageId, customerId } = await seedConversation("مرحبا رقمي 0930123456 للتواصل معي", "t11");
    await (db as any).customer.update({ where: { id: customerId }, data: { name: "زبون", phone: "0930123456" } });
    const res = await runReply(conversationId, messageId);
    expect(res.status).toBe("RESPONDED");
    const blob = fetchCalls.map((c) => JSON.stringify(c.body)).join("\n");
    expect(blob).not.toContain("0930123456");
    expect(blob).toMatch(/\[PII-\d+\]/);
  });

  it("12. invented prices are rejected (nothing sent); trusted prices pass", async () => {
    await createProduct(db as Db, { userId: "agent-hermes", workspaceId: WS }, {
      name: "عطر", sku: "SKU-ATR", price: 50000, currency: "ل.س", stockStatus: "IN_STOCK", isActive: true,
    });
    extractionResponder = () => ({
      intent: "PRICE_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER",
    });
    replyResponder = "سعر العطر 75000 ل.س والتوصيل سريع";
    const bad = await seedConversation("بكم سعر العطر عندكم بالتفصيل", "t12a");
    expect((await runReply(bad.conversationId, bad.messageId)).status).toBe("AI_FAILED");
    expect(outboundTexts()).toEqual([]);
    replyResponder = "سعر العطر 50000 ل.س، تحب سجّل طلب؟";
    const good = await seedConversation("وبكم سعر العطر مرة ثانية لو سمحت", "t12b");
    expect((await runReply(good.conversationId, good.messageId)).status).toBe("RESPONDED");
    expect(outboundTexts()).toEqual(["سعر العطر 50000 ل.س، تحب سجّل طلب؟"]);
  });

  it("13. extraction and order drafts keep working under Hermes", async () => {
    await createProduct(db as Db, { userId: "agent-hermes", workspaceId: WS }, {
      name: "عطر", sku: "SKU-ATR2", price: 50000, currency: "ل.س", stockStatus: "IN_STOCK", isActive: true,
    });
    extractionResponder = () => ({
      intent: "ORDER_CREATE", confidence: 0.9,
      entities: { product: "عطر", quantity: 2 }, missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
    });
    replyResponder = "تمام، سجلت طلبك وسأؤكد التفاصيل معك";
    const { conversationId, messageId } = await seedConversation("بدي اطلب عطرين لو سمحت من فضلك", "t13");
    const res = await runReply(conversationId, messageId);
    expect(["RESPONDED", "CLARIFIED"]).toContain(res.status);
    const drafts = (db._stores.orderDraft as any[]).filter((d) => d.conversationId === conversationId);
    expect(drafts.length).toBe(1);
    expect(drafts[0].productId).toBeTruthy();
    expect((db._stores.order as any[]).length).toBe(0);
    expect(outboundTexts()).toEqual(["تمام، سجلت طلبك وسأؤكد التفاصيل معك"]);
  });

  it("14. secrets never leak into bodies, usage rows, or results", async () => {
    const { conversationId, messageId } = await seedConversation("مرحبا", "t14");
    const res = await runReply(conversationId, messageId);
    expect(res.status).toBe("RESPONDED");
    const bodies = fetchCalls.map((c) => JSON.stringify(c.body)).join("\n");
    expect(bodies).not.toContain(HERMES_KEY);
    // …but the key IS transported as a Bearer header (proof of the real call).
    expect(fetchCalls.every((c) => authzOf(c) === `Bearer ${HERMES_KEY}`)).toBe(true);
    const rows = await usageFor(messageId);
    expect(JSON.stringify(rows)).not.toContain(HERMES_KEY);
    expect(JSON.stringify(res)).not.toContain(HERMES_KEY);
  });

  it("15. cross-workspace processing is refused without any Hermes call", async () => {
    const { conversationId, messageId } = await seedConversation("مرحبا", "t15");
    const before = fetchCalls.length;
    const res = await runReply(conversationId, messageId, WS_OTHER);
    expect(res.status).toBe("SKIPPED");
    expect(fetchCalls.length).toBe(before);
    expect(outboundTexts()).toEqual([]);
  });
});

describe("legacy (non-Hermes) reply path preserved", () => {
  it("mock provider still auto-handoffs complaints (existing behavior untouched)", async () => {
    await (db as any).aISettings.update({ where: { workspaceId: WS }, data: { provider: "mock" } });
    setMockAIProvider(new MockAIProvider());
    const { conversationId, messageId } = await seedConversation("عندي شكوى كبيرة من التوصيل السيء جدا", "legacy");
    const res = await runReply(conversationId, messageId);
    expect(res.status).toBe("HANDOFF");
    expect(handoffCount()).toBe(1);
  });
});
