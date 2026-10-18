import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { purgeConversation } from "@/modules/conversations/service";

const WS_A = "ws-a";
const AGENT = { userId: "agent-1", workspaceId: WS_A, ip: "test" };
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let customerId: string;
let conversationId: string;
let otherConversationId: string;
let messageIds: string[];
let otherMessageId: string;
let otherAssetId: string;
let orderId: string;
let otherOrderId: string;
let draftId: string;

async function seedWorld() {
  db = createFakeDb();
  const customer = await db.customer.create({
    data: { workspaceId: WS_A, name: "محمد", phone: "0930000000", status: "INTERESTED" },
  } as never);
  customerId = customer.id;
  const conv = await db.conversation.create({
    data: { workspaceId: WS_A, customerId, channelId: "ch-1", channelConversationId: "fb-conv-1" },
  } as never);
  conversationId = conv.id;
  const other = await db.conversation.create({
    data: { workspaceId: WS_A, customerId, channelId: "ch-1", channelConversationId: "fb-conv-2" },
  } as never);
  otherConversationId = other.id;

  // Messages of THIS conversation + one in the other conversation.
  const m1 = await db.message.create({
    data: { workspaceId: WS_A, conversationId, direction: "INBOUND", deliveryStatus: "RECEIVED", content: "بدي شي؟" },
  } as never);
  const m2 = await db.message.create({
    data: { workspaceId: WS_A, conversationId, direction: "OUTBOUND", deliveryStatus: "SENT", content: "أهلاً" },
  } as never);
  const mOther = await db.message.create({
    data: { workspaceId: WS_A, conversationId: otherConversationId, direction: "INBOUND", deliveryStatus: "RECEIVED", content: "سؤال غيره" },
  } as never);
  messageIds = [m1.id, m2.id];
  otherMessageId = mOther.id;

  // Media bound to these messages: this conversation's rows die with it; the
  // other conversation's asset must survive.
  await db.mediaAsset.create({
    data: { workspaceId: WS_A, messageId: m1.id, category: "CUSTOMER_INBOUND", storageKey: "k-in-1" },
  } as never);
  await db.mediaAsset.create({
    data: { workspaceId: WS_A, messageId: m2.id, category: "PRODUCT", storageKey: "k-out-1" },
  } as never);
  const keptAsset = await db.mediaAsset.create({
    data: { workspaceId: WS_A, messageId: mOther.id, category: "PRODUCT", storageKey: "k-keep" },
  } as never);
  otherAssetId = keptAsset.id!;

  // Memories: two sourced by this conversation's messages, one by the other's.
  await db.customerMemory.create({
    data: { workspaceId: WS_A, customerId, type: "FACT", key: "pref a", value: "يفضل الأسود", source: `ai_extraction:${m1.id}`, confidence: 0.9 },
  } as never);
  await db.customerMemory.create({
    data: { workspaceId: WS_A, customerId, type: "PREFERENCE", key: "pref b", value: "بيضيف قبول الدفع عند الاستلام", source: `ai_extraction:${m2.id}`, confidence: 0.9 },
  } as never);
  await db.customerMemory.create({
    data: { workspaceId: WS_A, customerId, type: "FACT", key: "pref c", value: "بتحب التوصيل للبيت", source: `ai_extraction:${mOther.id}`, confidence: 0.9 },
  } as never);

  // Draft + order of this conversation.
  const draft = await db.orderDraft.create({
    data: {
      workspaceId: WS_A, conversationId, customerId,
      state: "CONVERTED", productId: "prod-1", quantity: 2,
      idempotencyKey: "draft:d-1", orderId: "order-pending-ref",
    },
  } as never);
  draftId = draft.id!;
  const order = await db.order.create({
    data: { workspaceId: WS_A, conversationId, draftId, customerId, orderNumber: "ORD-1", status: "CONFIRMED" },
  } as never);
  orderId = order.id!;
  // Order of the OTHER conversation — untouched by the purge.
  const otherOrder = await db.order.create({
    data: { workspaceId: WS_A, conversationId: otherConversationId, customerId, orderNumber: "ORD-2", status: "NEW" },
  } as never);
  otherOrderId = otherOrder.id!;

  // Ancillary atoms of this conversation.
  await db.followUp.create({ data: { workspaceId: WS_A, conversationId, customerId, status: "SCHEDULED" } } as never);
  await db.humanHandoff.create({ data: { workspaceId: WS_A, conversationId, customerId, status: "OPEN" } } as never);
  await db.salesEvent.create({ data: { workspaceId: WS_A, customerId, conversationId, type: "ORDER_CREATED" } } as never);
  await db.aIUsageLog.create({ data: { workspaceId: WS_A, conversationId, purpose: "EXTRACTION", provider: "mock", model: "m" } } as never);
  await db.knowledgeCitation.create({ data: { messageId: m2.id, conversationId, vectorId: "v-1" } } as never);
  await db.attributionTouch.create({ data: { workspaceId: WS_A, customerId, conversationId, channel: "FACEBOOK", occurredAt: new Date() } } as never);
  // Rows intentionally OUTSIDE the purge scope.
  await db.discountApproval.create({ data: { workspaceId: WS_A, conversationId, customerId, status: "PENDING" } } as never);
  await db.campaignRecipient.create({ data: { workspaceId: WS_A, campaignId: "camp-1", customerPhone: "0930000000", conversationId, status: "QUEUED" } } as never);
}

beforeEach(seedWorld);

describe("conversation purge deletes the thread AND its memory atoms", () => {
  it("removes messages, sourced memories, draft and ancillary rows — orders survive unlinked", async () => {
    const result = await purgeConversation(db as Db, AGENT, conversationId);
    expect(result.messages).toBe(2);

    // Conversation + its messages are physically gone.
    const messages = db._stores.message as any[];
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(otherMessageId);
    expect(await db.conversation.findUnique({ where: { id: conversationId } })).toBeNull();
    // The other conversation survives untouched.
    expect(await db.conversation.findUnique({ where: { id: otherConversationId } })).toBeTruthy();

    // Memory: only rows sourced by THIS conversation's messages die.
    const memories = db._stores.customerMemory as any[];
    expect(memories).toHaveLength(1);
    expect(memories[0].source).toBe(`ai_extraction:${otherMessageId}`);

    // Media of the deleted messages die with them.
    const assets = db._stores.mediaAsset as any[];
    expect(assets.map((a) => a.id)).toEqual([otherAssetId]);

    // Draft gone; the order survives with conversation + draft links cleared.
    const drafts = db._stores.orderDraft as any[];
    expect(drafts).toHaveLength(0);
    const order = await db.order.findUnique({ where: { id: orderId } });
    expect(order).toBeTruthy();
    expect(order!.conversationId).toBeNull();
    expect(order!.draftId).toBeNull();
    // The other conversation's order is untouched.
    const otherOrder = await db.order.findUnique({ where: { id: otherOrderId } });
    expect(otherOrder!.conversationId).toBe(otherConversationId);

    // Ancillary atoms of this conversation are gone.
    expect(db._stores.followUp).toHaveLength(0);
    expect(db._stores.humanHandoff).toHaveLength(0);
    expect(db._stores.salesEvent).toHaveLength(0);
    expect(db._stores.aIUsageLog).toHaveLength(0);
    expect(db._stores.knowledgeCitation).toHaveLength(0);
    expect(db._stores.attributionTouch).toHaveLength(0);

    // Deliberately KEPT rows: order-bound approvals and campaign sends.
    expect(db._stores.discountApproval).toHaveLength(1);
    expect(db._stores.campaignRecipient).toHaveLength(1);

    // The purge itself is audited — never silent.
    const actions = (db._stores.auditLog as any[]).map((a) => a.action);
    expect(actions).toContain("conversation.purged");
  });

  it("an already soft-deleted thread can still be purged (cleanup path)", async () => {
    const { deleteConversation } = await import("@/modules/conversations/service");
    await deleteConversation(db as Db, AGENT, conversationId);
    await purgeConversation(db as Db, AGENT, conversationId);
    expect(await db.conversation.findUnique({ where: { id: conversationId } })).toBeNull();
    expect(db._stores.message).toHaveLength(1);
  });

  it("cross-workspace purge is refused", async () => {
    await expect(
      purgeConversation(db as Db, { userId: "x", workspaceId: "ws-other" } as typeof AGENT, conversationId)
    ).rejects.toBeTruthy();
  });
});
