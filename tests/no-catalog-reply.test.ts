/**
 * P26 incident regression — a page with NO catalog must still be able to send
 * a general reply. The strict catalog blocks products/orders, never the reply
 * itself (unless HUMAN_ACTIVE / COLLECTION_ONLY explicitly blocks sending).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";
import { enqueueJob } from "@/modules/jobs/service";
import { runJobs } from "@/modules/jobs/handlers";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;
const WS = "ws-no-catalog";
let db: FakeDb;
let conversationId: string;
let messageId: string;

async function seed() {
  db = createFakeDb() as FakeDb;
  const customer = (await db.customer.create({
    data: { workspaceId: WS, name: "زبون", phone: "0791234567" },
  } as never)) as { id: string };
  const channel = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "P", externalId: "page-no-cat", sendMode: "AUTO_REPLY" },
  } as never)) as { id: string };
  await db.channelAccount.create({
    data: { channelId: channel.id, provider: "FACEBOOK", externalAccountId: "page-no-cat", pageName: "P", encryptedCredentials: encryptSecret("token") },
  } as never);
  const conv = (await db.conversation.create({
    data: {
      workspaceId: WS,
      customerId: customer.id,
      channelId: channel.id,
      channelConversationId: "c-no-cat",
      lastCustomerMessageAt: new Date(),
    },
  } as never)) as { id: string };
  conversationId = conv.id;
  await db.channelIdentity.create({
    data: { workspaceId: WS, customerId: customer.id, channelType: "FACEBOOK", channelExternalId: "c-no-cat" },
  } as never);
  const msg = (await db.message.create({
    data: { workspaceId: WS, conversationId, senderType: "CUSTOMER", direction: "INBOUND", type: "TEXT", text: "مرحبا" },
  } as never)) as { id: string };
  messageId = msg.id;
}

beforeEach(async () => {
  await seed();
  const mock = new MockAIProvider();
  mock.intentHandler = () => ({
    intent: "GREETING",
    confidence: 0.95,
    language: "ar",
    entities: {},
    missingFields: [],
    memories: [],
    requestedAction: "ANSWER",
  } as never);
  mock.responseHandler = () => "أهلاً وسهلاً 🌹";
  setMockAIProvider(mock);
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async () =>
          Response.json({ recipient_id: "psid", message_id: `mid-${Date.now()}` })) as typeof fetch,
      })
  );
});

describe("P26 — no catalog still replies", () => {
  it("general greeting is answered and sent even when the page has no catalog", async () => {
    const res = await processAIMessage(
      db as unknown as Db,
      { workspaceId: WS, conversationId, messageId },
      { vectorStore: { search: async () => [] } as never }
    );
    expect(res.status).toBe("RESPONDED");
    const outbound = (db._stores.message as any[]).filter(
      (m) => m.conversationId === conversationId && m.direction === "OUTBOUND"
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0].text).toContain("أهلاً");
    // No products / no order created.
    expect(db._stores.orderDraft as any[]).toHaveLength(0);
    expect(db._stores.order as any[]).toHaveLength(0);
  });

  it("worker picks the queued AI job and sends the reply", async () => {
    await enqueueJob(db as unknown as Db, {
      workspaceId: WS,
      type: "process_ai_message",
      payload: { conversationId, messageId },
      idempotencyKey: `p26:${messageId}`,
    });
    const run = await runJobs(db as unknown as Db);
    expect(run.failed).toBe(0);
    const outbound = (db._stores.message as any[]).filter(
      (m) => m.conversationId === conversationId && m.direction === "OUTBOUND"
    );
    expect(outbound).toHaveLength(1);
    const job = (db._stores.backgroundJob as any[]).find((j) => j.type === "process_ai_message");
    expect(job?.status).toBe("DONE");
  });
});
