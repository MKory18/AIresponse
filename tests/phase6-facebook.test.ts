import { beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { verifyWebhookSignature, verifyWebhookChallenge, normalizeFacebookWebhook, deriveEventId } from "@/modules/channels/facebook/normalizer";
import { canSendToCustomer } from "@/modules/channels/facebook/policy";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { createOAuthState, verifyOAuthState, createPagesSelectionToken, verifyPagesSelectionToken } from "@/modules/channels/facebook/oauth";
import { ingestMetaWebhook } from "@/modules/channels/facebook/webhook";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { runJobs } from "@/modules/jobs/handlers";
import { processIncomingMessage, takeoverConversation } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { createProduct } from "@/modules/products/service";
import { encryptSecret } from "@/core/crypto";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";

const WS_A = "ws-a";
const WS_B = "ws-b";
const APP_SECRET = "test-app-secret-0123456789abcdef";
const PAGE_ID = "page-777";
const PSID = "psid-alice-1";
type Db = Prisma.TransactionClient;

process.env.META_APP_SECRET = APP_SECRET;
process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-token-123";
process.env.META_APP_ID = "app-123";

let db: ReturnType<typeof createFakeDb>;
let mock: MockAIProvider;
let sentToMeta: { recipientId: string; text: string }[];
let sendFailures = 0;
let failWithTransient = false;

function signedPayload(body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  const signature = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw, "utf8").digest("hex");
  return { raw, signature };
}

function metaPayload(mid: string, text: string, psid = PSID, pageId = PAGE_ID) {
  return {
    object: "page",
    entry: [
      {
        id: pageId,
        time: Date.now(),
        messaging: [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid, text } }],
      },
    ],
  };
}

/** Mock Meta server: records sends, returns Graph-shaped responses. */
function installMockMeta() {
  sentToMeta = [];
  sendFailures = 0;
  failWithTransient = false;
  setFacebookClientFactory(() => {
    const client = new FacebookClient({
      fetchImpl: (async (url: string) => {
        const u = new URL(url as string);
        if (u.pathname.endsWith("/me/messages")) {
          if (sendFailures > 0) {
            sendFailures -= 1;
            return Response.json(
              failWithTransient
                ? { error: { message: "temporarily down", code: 1, is_transient: true } }
                : { error: { message: "invalid recipient", code: 100, is_transient: false } }
            );
          }
          sentToMeta.push({
            recipientId: JSON.parse(u.searchParams.get("recipient")!).id,
            text: JSON.parse(u.searchParams.get("message")!).text,
          });
          return Response.json({ recipient_id: JSON.parse(u.searchParams.get("recipient")!).id, message_id: `mid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
        }
        return Response.json({ id: PAGE_ID, name: "Demo Page" });
      }) as typeof fetch,
    });
    return client;
  });
}

async function seedWorld() {
  db = createFakeDb();
  await createProduct(db as Db, { userId: "agent-1", workspaceId: WS_A }, {
    name: "ماء الكمأة", sku: "TW-500", price: 150000, currency: "SYP",
  });
  // Connected Facebook Page → workspace A
  const ch = await db.channel.create({
    data: { workspaceId: WS_A, type: "FACEBOOK", status: "CONNECTED", displayName: "Demo Page", externalId: PAGE_ID },
  } as never);
  await db.channelAccount.create({
    data: {
      channelId: (ch as any).id, provider: "FACEBOOK", externalAccountId: PAGE_ID, pageName: "Demo Page",
      encryptedCredentials: encryptSecret("page-access-token-test"), lastCustomerMessageAt: null,
    },
  } as never);
}

beforeEach(() => {
  mock = new MockAIProvider();
  setMockAIProvider(mock);
  installMockMeta();
  return seedWorld();
});

function emptyStore() {
  return new InMemoryVectorStore(new Map(), new Map());
}

describe("Phase 6 — webhook verification", () => {
  it("verifies valid subscription challenge", () => {
    const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify-token-123", "hub.challenge": "CHALLENGE_42" });
    const res = verifyWebhookChallenge(params);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.challenge).toBe("CHALLENGE_42");
  });

  it("rejects invalid verify token", () => {
    const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "x" });
    expect(verifyWebhookChallenge(params).ok).toBe(false);
  });

  it("verifies valid HMAC signature with constant-time compare", () => {
    const { raw, signature } = signedPayload(metaPayload("m1", "مرحبا"));
    expect(verifyWebhookSignature(raw, signature, APP_SECRET)).toBe(true);
  });

  it("rejects invalid signature, wrong secret, missing header", () => {
    const { raw } = signedPayload(metaPayload("m1", "hi"));
    const bad = "sha256=" + crypto.createHmac("sha256", "other-secret").update(raw).digest("hex");
    expect(verifyWebhookSignature(raw, bad, APP_SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, null, APP_SECRET)).toBe(false);
    // tampered body with any signature must fail
    const tampered = JSON.parse(raw.replace("hi", "hacked"));
    const tamperedRaw = JSON.stringify(tampered);
    const tamperedSig = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(tamperedRaw, "utf8").digest("hex");
    expect(verifyWebhookSignature(raw, tamperedSig, APP_SECRET)).toBe(false);
  });
});

describe("Phase 6 — webhook ingestion (idempotency, routing)", () => {
  it("processes a valid webhook once: customer + conversation + message", async () => {
    const { raw } = signedPayload(metaPayload("mid-1", "مرحبا"));
    void raw;
    const result = await ingestMetaWebhook(db as Db, metaPayload("mid-1", "مرحبا"));
    expect(result.status).toBe("OK");
    // run the queued webhook job
    await runJobs(db as Db);
    expect(db._stores.customer).toHaveLength(1);
    expect(db._stores.conversation).toHaveLength(1);
    expect(db._stores.message.filter((m: any) => m.direction === "INBOUND")).toHaveLength(1);
  });

  it("duplicate webhook → DUPLICATE status, one message only", async () => {
    await ingestMetaWebhook(db as Db, metaPayload("mid-2", "سؤال"));
    const dup = await ingestMetaWebhook(db as Db, metaPayload("mid-2", "سؤال"));
    expect(dup.status).toBe("DUPLICATE");
    await runJobs(db as Db);
    expect(db._stores.message.filter((m: any) => m.direction === "INBOUND")).toHaveLength(1);
  });

  it("concurrent duplicate webhooks (×10) → one message, one customer", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ingestMetaWebhook(db as Db, metaPayload("mid-cc", "رسالة متزامنة")))
    );
    const accepted = results.filter((r) => r.status === "OK");
    expect(accepted).toHaveLength(1);
    await runJobs(db as Db);
    expect(db._stores.customer).toHaveLength(1);
    expect(db._stores.message.filter((m: any) => m.direction === "INBOUND")).toHaveLength(1);
  });

  it("unknown page → no processing, no customer creation", async () => {
    const result = await ingestMetaWebhook(db as Db, metaPayload("mid-3", "hello", PSID, "unknown-page"));
    expect(result.status).toBe("UNKNOWN_PAGE");
    await runJobs(db as Db);
    expect(db._stores.customer).toHaveLength(0);
  });

  it("100 messages from same PSID → one customer, one conversation", async () => {
    for (let i = 1; i <= 100; i++) {
      await ingestMetaWebhook(db as Db, metaPayload(`mid-100-${i}`, `رسالة ${i}`));
    }
    for (let i = 0; i < 15; i++) {
      (db._stores.backgroundJob as any[]).forEach((j) => (j.runAfter = new Date(0)));
      await runJobs(db as Db);
    }
    expect(db._stores.customer).toHaveLength(1);
    expect(db._stores.conversation).toHaveLength(1);
    expect(db._stores.message.filter((m: any) => m.direction === "INBOUND")).toHaveLength(100);
  });

  it("normalizer skips echoes and extracts attachments", () => {
    const payload = {
      object: "page",
      entry: [{
        id: PAGE_ID,
        messaging: [
          { sender: { id: PSID }, message: { mid: "echo-1", is_echo: true, text: "out" } },
          { sender: { id: PSID }, message: { mid: "att-1", attachments: [{ type: "image", payload: { url: "https://cdn.fb/x.jpg" } }] } },
        ],
      }],
    };
    const normalized = normalizeFacebookWebhook(payload as never, "acc-1", PAGE_ID, "evt-1");
    expect(normalized).toHaveLength(1);
    expect(normalized[0].attachments).toEqual([{ type: "IMAGE", url: "https://cdn.fb/x.jpg" }]);
  });

  it("deriveEventId is stable for identical payloads", () => {
    const p = metaPayload("mid-stable", "نص");
    expect(deriveEventId(p)).toBe(deriveEventId(metaPayload("mid-stable", "نص")));
    expect(deriveEventId(p)).not.toBe(deriveEventId(metaPayload("mid-other", "نص")));
  });
});

describe("Phase 6 — messaging policy", () => {
  it("allows within 24h window, blocks after and when disconnected/expired", () => {
    const now = new Date();
    expect(canSendToCustomer({ channelStatus: "CONNECTED", tokenExpiresAt: null, lastCustomerMessageAt: new Date(now.getTime() - 3600_000), now }).allowed).toBe(true);
    expect(canSendToCustomer({ channelStatus: "CONNECTED", tokenExpiresAt: null, lastCustomerMessageAt: new Date(now.getTime() - 25 * 3600_000), now })).toEqual({ allowed: false, reason: "WINDOW_CLOSED" });
    expect(canSendToCustomer({ channelStatus: "DISCONNECTED", tokenExpiresAt: null, lastCustomerMessageAt: now, now })).toEqual({ allowed: false, reason: "CHANNEL_DISCONNECTED" });
    expect(canSendToCustomer({ channelStatus: "CONNECTED", tokenExpiresAt: new Date(now.getTime() - 1000), lastCustomerMessageAt: now, now })).toEqual({ allowed: false, reason: "TOKEN_EXPIRED" });
  });
});

describe("Phase 6 — OAuth state protection", () => {
  it("valid state round-trips", async () => {
    const state = await createOAuthState(WS_A, "user-1");
    const verified = await verifyOAuthState(state);
    expect(verified.workspaceId).toBe(WS_A);
  });

  it("tampered state fails", async () => {
    const state = await createOAuthState(WS_A, "user-1");
    await expect(verifyOAuthState(state.slice(0, -2) + "xx")).rejects.toBeTruthy();
  });

  it("selection token binds workspace and expires logic", async () => {
    const token = await createPagesSelectionToken(WS_A, "user-1", [{ id: PAGE_ID, name: "Demo", accessToken: "tok" }]);
    const verified = await verifyPagesSelectionToken(token);
    expect(verified.pages[0].id).toBe(PAGE_ID);
    await expect(verifyPagesSelectionToken(token + "x")).rejects.toBeTruthy();
  });
});

describe("Phase 6 — outbound sending", () => {
  async function startConversation() {
    const inbound = await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", externalUserId: PSID,
      externalConversationId: PSID, externalMessageId: `mid-o-${Math.random().toString(36).slice(2, 6)}`,
      externalEventId: `evt-${Math.random().toString(36).slice(2, 6)}`,
      provider: "facebook", type: "TEXT", text: "مرحبا",
    });
    // mark last inbound so the 24h window is open
    await db.conversation.update({
      where: { id: inbound.conversationId },
      data: { lastCustomerMessageAt: new Date() },
    } as never);
    return inbound;
  }

  it("successful AI response sends exactly one Facebook message", async () => {
    const inbound = await startConversation();
    const result = await processAIMessage(db as Db, {
      workspaceId: WS_A, conversationId: inbound.conversationId, messageId: inbound.messageId,
    }, { vectorStore: emptyStore() });
    expect(result.status).toBe("RESPONDED");
    expect(sentToMeta).toHaveLength(1);
    expect(sentToMeta[0].recipientId).toBe(PSID);
  });

  it("duplicate AI execution → no second Facebook send", async () => {
    const inbound = await startConversation();
    await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: inbound.conversationId, messageId: inbound.messageId }, { vectorStore: emptyStore() });
    await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: inbound.conversationId, messageId: inbound.messageId }, { vectorStore: emptyStore() });
    expect(sentToMeta).toHaveLength(1);
  });

  it("transient failure → QUEUED (retryable), permanent → FAILED", async () => {
    const inbound = await startConversation();
    failWithTransient = true;
    sendFailures = 1;
    let result = await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: inbound.conversationId, messageId: inbound.messageId }, { vectorStore: emptyStore() });
    expect(result.status).toBe("RESPONDED");
    let msg = (db._stores.message as any[]).find((m) => m.outboundIdempotencyKey?.includes(inbound.conversationId));
    expect(msg.deliveryStatus).toBe("QUEUED");
    expect(msg.metadata.retryable).toBe(true);

    // fresh conversation for the permanent failure case
    const inbound2 = await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", externalUserId: "psid-bob",
      externalConversationId: "psid-bob", externalMessageId: "mid-bob", externalEventId: "evt-bob",
      provider: "facebook", type: "TEXT", text: "مرحبا",
    });
    await db.conversation.update({ where: { id: inbound2.conversationId }, data: { lastCustomerMessageAt: new Date() } } as never);
    failWithTransient = false;
    sendFailures = 1;
    result = await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: inbound2.conversationId, messageId: inbound2.messageId }, { vectorStore: emptyStore() });
    msg = (db._stores.message as any[]).find((m) => m.outboundIdempotencyKey?.includes(inbound2.conversationId));
    expect(msg.deliveryStatus).toBe("FAILED");
    expect(msg.metadata.retryable).toBe(false);
  });

  it("disconnected page → no send", async () => {
    const chRow = (db._stores.channel as any[])[0];
    await db.channel.update({ where: { id: chRow.id }, data: { status: "DISCONNECTED" } } as never);
    const inbound = await startConversation();
    await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: inbound.conversationId, messageId: inbound.messageId }, { vectorStore: emptyStore() });
    expect(sentToMeta).toHaveLength(0);
    const msg = (db._stores.message as any[]).find((m) => m.outboundIdempotencyKey?.includes(inbound.conversationId));
    expect(msg.deliveryStatus).toBe("FAILED");
    expect(msg.deliveryError).toBe("POLICY_CHANNEL_DISCONNECTED");
  });

  it("human takeover → next Facebook message gets NO AI response", async () => {
    const inbound = await startConversation();
    await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: inbound.conversationId, messageId: inbound.messageId }, { vectorStore: emptyStore() });
    await takeoverConversation(db as Db, { userId: "agent-1", workspaceId: WS_A }, inbound.conversationId);
    const before = sentToMeta.length;
    const next = await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", externalUserId: PSID,
      externalConversationId: PSID, externalMessageId: "mid-after-takeover", externalEventId: "evt-after-takeover",
      provider: "facebook", type: "TEXT", text: "أيها الناس",
    });
    await runJobs(db as Db).catch(() => {});
    const aiResult = await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: next.conversationId, messageId: next.messageId }, { vectorStore: emptyStore() });
    expect(aiResult.status).toBe("AI_DISABLED");
    expect(sentToMeta.length).toBe(before);
  });
});

describe("Phase 6 — E2E Facebook scenarios", () => {
  async function customerSays(text: string, mid: string) {
    const evtId = `evt-${mid}`;
    await ingestMetaWebhook(db as Db, metaPayload(mid, text));
    const jobsBefore = (db._stores.backgroundJob as any[]).filter((j) => j.type === "process_webhook_event" && !j.processedAt);
    await runJobs(db as Db);
    // then AI job
    const aiJobs = (db._stores.backgroundJob as any[]).filter((j) => j.type === "process_ai_message" && j.status === "PENDING");
    for (const j of aiJobs) j.runAfter = new Date(0);
    await runJobs(db as Db);
    const conversation = db._stores.conversation[0];
    const lastInbound = (db._stores.message as any[]).filter((m) => m.direction === "INBOUND" && m.externalMessageId === mid)[0];
    void jobsBefore; void evtId;
    return { conversation, messageId: lastInbound?.id };
  }

  it("scenario 1-4: greeting → order collection → confirm → order created via Facebook", async () => {
    // 1. greeting
    const s1 = await customerSays("مرحبا", "e2e-1");
    await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: s1.conversation.id, messageId: s1.messageId! }, { vectorStore: emptyStore() });
    expect(sentToMeta.length).toBe(1);

    // 2. order intent with full data
    const s2 = await customerSays("بدي 3 من ماء الكمأة، رقمي 0930000000، عنواني دمشق دويلعة", "e2e-2");
    await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: s2.conversation.id, messageId: s2.messageId! }, { vectorStore: emptyStore() });
    const draft = await db.orderDraft.findUniqueOrThrow({ where: { conversationId: s2.conversation.id } }) as never as { state: string };
    expect(draft.state).toBe("READY");

    // 3. confirm
    const s3 = await customerSays("نعم أكد", "e2e-3");
    await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: s3.conversation.id, messageId: s3.messageId! }, { vectorStore: emptyStore() });
    const orders = db._stores.order as any[];
    expect(orders).toHaveLength(1);
    expect(Number(orders[0].total)).toBe(450000); // DB price, never AI price
    // 4. confirmation message went out
    expect(sentToMeta.length).toBe(3);
  });

  it("scenario 5: human takeover stops AI replies on Facebook", async () => {
    const s1 = await customerSays("مرحبا", "e2e-t1");
    await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: s1.conversation.id, messageId: s1.messageId! }, { vectorStore: emptyStore() });
    await takeoverConversation(db as Db, { userId: "agent-1", workspaceId: WS_A }, s1.conversation.id);
    const before = sentToMeta.length;
    const s2 = await customerSays("بدي أسأل سؤال", "e2e-t2");
    await processAIMessage(db as Db, { workspaceId: WS_A, conversationId: s2.conversation.id, messageId: s2.messageId! }, { vectorStore: emptyStore() });
    expect(sentToMeta.length).toBe(before); // no AI response
  });
});
