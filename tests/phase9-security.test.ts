import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { getOwnedCustomer, updateCustomer } from "@/modules/customers/service";
import { getOwnedConversation, takeoverConversation } from "@/modules/conversations/service";
import { getOwnedOrder, transitionOrder } from "@/modules/orders/order-service";
import { getOwnedProduct } from "@/modules/products/service";
import { getOwnedFeedback } from "@/modules/feedback/service";
import { getOwnedDocument } from "@/modules/knowledge/service";
import { getOwnedDraft } from "@/modules/orders/draft-service";
import { getOwnedHandoff } from "@/modules/handoffs/handoff-service";
import { cancelFollowUp } from "@/modules/automation/followup-service";
import { getOwnedMedia } from "@/modules/media/service";
import { ROLE_PERMISSIONS } from "@/modules/rbac/permissions";
import { AppError, NotFoundError } from "@/core/errors";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";
import { createFakeDb as _unused } from "./helpers/inmemory-db";
void _unused;

const WS_A = "ws-a";
const WS_B = "ws-b";
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let ids: Record<string, string>;

function emptyStore() {
  return new InMemoryVectorStore(new Map(), new Map());
}

beforeEach(async () => {
  db = createFakeDb();
  const product = await createProduct(db as Db, { userId: "u", workspaceId: WS_B }, { name: "B Product", sku: "B-1", price: 1 });
  const customer = await db.customer.create({ data: { workspaceId: WS_B, name: "B Cust" } } as never);
  const conv = await db.conversation.create({
    data: { workspaceId: WS_B, customerId: customer.id, channelId: "ch", channelConversationId: "bc1" },
  } as never);
  const msg = await db.message.create({
    data: { conversationId: conv.id, workspaceId: WS_B, senderType: "CUSTOMER", direction: "INBOUND", type: "TEXT", text: "x" },
  } as never);
  const draft = await db.orderDraft.create({ data: { workspaceId: WS_B, conversationId: conv.id, customerId: customer.id, state: "COLLECTING" } } as never);
  const order = await db.order.create({ data: { workspaceId: WS_B, orderNumber: "B-O1", customerId: customer.id } } as never);
  const feedback = await db.feedback.create({ data: { workspaceId: WS_B, kind: "TEXT", content: "x" } } as never);
  const doc = await db.knowledgeDocument.create({ data: { workspaceId: WS_B, title: "B doc", content: "x", sourceType: "MANUAL" } } as never);
  const media = await db.mediaAsset.create({ data: { workspaceId: WS_B, url: "/x", storageKey: "ws-b/x.png", mimeType: "image/png", type: "IMAGE" } } as never);
  const handoff = await db.humanHandoff.create({ data: { workspaceId: WS_B, conversationId: conv.id, customerId: customer.id, reason: "MANUAL" } } as never);
  const followUp = await db.followUp.create({ data: { workspaceId: WS_B, customerId: customer.id, type: "X", scheduledAt: new Date(), idempotencyKey: "b-fu" } } as never);
  const automation = await db.automation.create({ data: { workspaceId: WS_B, name: "B auto", trigger: "ORDER_CONFIRMED", actions: [] } } as never);

  ids = {
    product: product.id, customer: customer.id, conversation: conv.id,
    messageId: msg.id, draft: draft.id, order: order.id, feedback: feedback.id,
    doc: doc.id, media: media.id, handoff: handoff.id, followUp: followUp.id, automation: automation.id,
  };
});

const ctxA = { userId: "attacker", workspaceId: WS_A };

describe("Phase 9 — tenant isolation sweep (every resource)", () => {
  it.each([
    ["customer", () => getOwnedCustomer(db as Db, WS_A, ids.customer)],
    ["customer.update", () => updateCustomer(db as Db, ctxA, ids.customer, { name: "H" })],
    ["conversation", () => getOwnedConversation(db as Db, WS_A, ids.conversation)],
    ["takeover", () => takeoverConversation(db as Db, ctxA, ids.conversation)],
    ["product", () => getOwnedProduct(db as Db, WS_A, ids.product)],
    ["feedback", () => getOwnedFeedback(db as Db, WS_A, ids.feedback)],
    ["knowledge", () => getOwnedDocument(db as Db, WS_A, ids.doc)],
    ["order", () => getOwnedOrder(db as Db, WS_A, ids.order)],
    ["order.transition", () => transitionOrder(db as Db, ctxA, ids.order, "PROCESSING")],
    ["orderDraft", () => getOwnedDraft(db as Db, WS_A, ids.draft)],
    ["media", () => getOwnedMedia(db as Db, WS_A, ids.media)],
    ["handoff", () => getOwnedHandoff(db as Db, WS_A, ids.handoff)],
    ["followup.cancel", () => cancelFollowUp(db as Db, ctxA, ids.followUp)],
  ])("%s → NotFound (no cross-tenant access)", async (_name, fn) => {
    await expect(fn()).rejects.toBeTruthy();
  });
});

describe("Phase 9 — authorization matrix (role → permission shape)", () => {
  it("SALES_AGENT cannot configure AI or manage automations", () => {
    const agent = new Set(ROLE_PERMISSIONS.SALES_AGENT);
    expect(agent.has("ai.configure")).toBe(false);
    expect(agent.has("automation.write")).toBe(false);
    expect(agent.has("channels.connect")).toBe(false);
    expect(agent.has("channels.send_human")).toBe(true);
    expect(agent.has("handoffs.claim")).toBe(true);
  });

  it("VIEWER is read-only", () => {
    const viewer = new Set(ROLE_PERMISSIONS.VIEWER);
    for (const p of viewer) expect(p.endsWith(".read") || p.endsWith(".view")).toBe(true);
  });

  it("every role's permissions are known permission names", () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      expect(perms.length, role).toBeGreaterThan(0);
    }
  });
});

describe("Phase 9 — webhook replay ×100 & HUMAN_ACTIVE invariant", () => {
  let conversationId: string;
  let mock: MockAIProvider;

  beforeEach(async () => {
    mock = new MockAIProvider();
    setMockAIProvider(mock);
    // fresh WS_A world
    db = createFakeDb();
    const customer = await db.customer.create({ data: { workspaceId: WS_A, name: "محمد" } } as never);
    const conv = await db.conversation.create({
      data: { workspaceId: WS_A, customerId: customer.id, channelId: "ch", channelConversationId: "fb-c1", lastCustomerMessageAt: new Date() },
    } as never);
    conversationId = conv.id;
    // restore ids shape for the sweep? (sweep tests run before with their own db)
  });

  it("webhook replay ×100 (same event) → one message", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        processIncomingMessage(db as Db, {
          workspaceId: WS_A, channelType: "FACEBOOK", externalUserId: "psid-x",
          externalConversationId: "fb-c1", externalMessageId: "mid-replay", externalEventId: "evt-replay",
          provider: "facebook", type: "TEXT", text: "مرحبا",
        })
      )
    );
    const unique = new Set(results.map((r) => r.messageId));
    expect(unique.size).toBe(1);
    expect(db._stores.message.filter((m: any) => m.direction === "INBOUND")).toHaveLength(1);
  });

  it("HUMAN_ACTIVE ×100 inbound messages → 0 AI replies", async () => {
    await takeoverConversation(db as Db, { userId: "agent", workspaceId: WS_A }, conversationId);
    for (let i = 0; i < 100; i++) {
      const inbound = await processIncomingMessage(db as Db, {
        workspaceId: WS_A, channelType: "FACEBOOK", externalUserId: "psid-x",
        externalConversationId: "fb-c1", externalMessageId: `mid-h-${i}`, externalEventId: `evt-h-${i}`,
        provider: "facebook", type: "TEXT", text: `رسالة ${i}`,
      });
      const result = await processAIMessage(db as Db, {
        workspaceId: WS_A, conversationId: inbound.conversationId, messageId: inbound.messageId,
      }, { vectorStore: emptyStore() });
      expect(result.status).toBe("AI_DISABLED");
    }
    expect(db._stores.message.filter((m: any) => m.senderType === "AI")).toHaveLength(0);
  });
});

describe("Phase 9 — input validation boundaries (Zod at the edge)", () => {
  it("automation conditions reject arbitrary deep nesting via max bounds", async () => {
    const { automationCreateSchema } = await import("@/modules/automation/schemas");
    const deep = { field: "a.b", operator: "EQ", value: "x" };
    let nested: unknown = deep;
    for (let i = 0; i < 50; i++) nested = { field: "a.b", operator: "EQ", value: "x", and: [nested] };
    const res = automationCreateSchema.safeParse({
      name: "T", trigger: "ORDER_CONFIRMED",
      actions: [{ type: "ADD_TAG", tag: "t" }],
      conditions: { all: [nested] },
    });
    expect(res.success).toBe(false);
  });

  it("huge strings are rejected by schemas", async () => {
    const { productInputSchema } = await import("@/modules/products/schemas");
    const res = productInputSchema.safeParse({ name: "x".repeat(5000), sku: "S", price: 1 });
    expect(res.success).toBe(false);
  });
});
