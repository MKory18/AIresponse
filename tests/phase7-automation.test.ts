import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { evaluateEvent, eventToTrigger } from "@/modules/automation/engine";
import { renderTemplate, validateTemplate } from "@/modules/automation/template";
import { evaluateCondition, evaluateConditionGroup } from "@/modules/automation/conditions";
import { createFollowUp, claimDueFollowUps, executeFollowUp, processDueFollowUps, cancelFollowUp } from "@/modules/automation/followup-service";
import { createHandoff, claimHandoff, releaseHandoff, resolveHandoff, routeHandoff } from "@/modules/handoffs/handoff-service";
import { sendHumanReply } from "@/modules/channels/outbound";
import { createProduct } from "@/modules/products/service";
import { processIncomingMessage, takeoverConversation } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { setFacebookClientFactory, FacebookClient } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";
import { AppError } from "@/core/errors";

const WS_A = "ws-a";
const WS_B = "ws-b";
const AGENT = { userId: "agent-1", workspaceId: WS_A };
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let productId: string;
let conversationId: string;
let customerId: string;
let sentToMeta: { recipientId: string; text: string }[];

function emptyStore() {
  return new InMemoryVectorStore(new Map(), new Map());
}

beforeEach(async () => {
  db = createFakeDb();
  const product = await createProduct(db as Db, AGENT, { name: "ماء الكمأة", sku: "TW-500", price: 150000, currency: "SYP" });
  productId = product.id;
  const customer = await db.customer.create({ data: { workspaceId: WS_A, name: "محمد", phone: "0930000000", province: "دمشق" } } as never);
  customerId = customer.id;
  await db.channel.create({
    data: { workspaceId: WS_A, type: "FACEBOOK", status: "CONNECTED", displayName: "Demo Page", externalId: "page-1" },
  } as never);
  await db.channelAccount.create({
    data: { channelId: (db._stores.channel as any[])[0].id, provider: "FACEBOOK", externalAccountId: "page-1", encryptedCredentials: encryptSecret("page-token") },
  } as never);
  const conv = await db.conversation.create({
    data: { workspaceId: WS_A, customerId, channelId: (db._stores.channel as any[])[0].id, channelConversationId: "fb-conv-1", lastCustomerMessageAt: new Date() },
  } as never);
  conversationId = conv.id;
  await db.channelIdentity.create({
    data: { workspaceId: WS_A, customerId, channelType: "FACEBOOK", channelExternalId: "psid-alice" },
  } as never);
  const agent = await db.user.create({ data: { email: "a@x.co", passwordHash: "x", name: "أحمد" } } as never);
  await db.workspaceMember.create({ data: { workspaceId: WS_A, userId: (agent as any).id, status: "ACTIVE", role: "SALES_AGENT" } } as never);

  sentToMeta = [];
  setMockAIProvider(new MockAIProvider());
  setFacebookClientFactory(() =>
    new FacebookClient({
      fetchImpl: (async (url: string) => {
        const u = new URL(url as string);
        if (u.pathname.endsWith("/me/messages")) {
          sentToMeta.push({
            recipientId: JSON.parse(u.searchParams.get("recipient")!).id,
            text: JSON.parse(u.searchParams.get("message")!).text,
          });
          return Response.json({ recipient_id: "psid", message_id: `mid-${Math.random().toString(36).slice(2, 8)}` });
        }
        return Response.json({ id: "page-1", name: "Demo" });
      }) as typeof fetch,
    })
  );
});

describe("Phase 7 — templates & conditions", () => {
  it("renders allowlisted placeholders only", () => {
    const out = renderTemplate("مرحبًا {{customer.name}}، إجمالي طلبك {{order.total}}", {
      customer: { name: "محمد" }, order: { total: 450000 },
    });
    expect(out).toContain("محمد");
    expect(out).toContain("450000");
  });

  it("rejects template injection: constructor/prototype/__proto__/unknown", () => {
    expect(validateTemplate("{{constructor}}").ok).toBe(false);
    expect(validateTemplate("{{prototype.constructor}}").ok).toBe(false);
    expect(validateTemplate("{{__proto__}}").ok).toBe(false);
    expect(validateTemplate("{{customer.eval}}").ok).toBe(false);
    expect(validateTemplate("{{unknown.field}}").ok).toBe(false);
    expect(validateTemplate("{{customer.passwordHash}}").ok).toBe(false);
    expect(validateTemplate("{{customer.name}}").ok).toBe(true);
  });

  it("evaluates typed conditions and AND/OR groups", () => {
    const data = { customer: { province: "دمشق", tags: ["VIP"] }, order: { total: 500000, status: "CONFIRMED" } };
    expect(evaluateCondition({ field: "customer.province", operator: "EQ", value: "دمشق" }, data)).toBe(true);
    expect(evaluateCondition({ field: "order.total", operator: "GTE", value: 500000 }, data)).toBe(true);
    expect(evaluateCondition({ field: "order.total", operator: "GTE", value: 500001 }, data)).toBe(false);
    expect(evaluateConditionGroup({ all: [
      { field: "customer.province", operator: "EQ", value: "دمشق" },
      { field: "order.status", operator: "EQ", value: "CONFIRMED" },
    ]}, data)).toBe(true);
    expect(evaluateConditionGroup({ any: [
      { field: "customer.province", operator: "EQ", value: "حلب" },
      { field: "order.total", operator: "GTE", value: 100000 },
    ]}, data)).toBe(true);
  });
});

describe("Phase 7 — automation engine", () => {
  async function seedConfirmedOrderAutomation() {
    await db.automation.create({
      data: {
        workspaceId: WS_A, name: "متابعة بعد التأكيد", trigger: "ORDER_CONFIRMED", priority: 5,
        conditions: { all: [{ field: "customer.province", operator: "EQ", value: "دمشق" }] },
        actions: [{ type: "CREATE_FOLLOW_UP", template: "مرحبًا {{customer.name}}، نود التأكد من أن كل شيء على ما يرام مع طلبك 🌹", delayHours: 24, followUpType: "CHECK_IN" }],
      },
    } as never);
  }

  it("maps domain events to triggers", () => {
    expect(eventToTrigger("OrderConfirmed")).toBe("ORDER_CONFIRMED");
    expect(eventToTrigger("OrderCreated")).toBe("ORDER_CREATED");
    expect(eventToTrigger("MessageCreated")).toBeNull();
  });

  it("ORDER_CONFIRMED → conditions met → follow-up scheduled (idempotent per event)", async () => {
    await seedConfirmedOrderAutomation();
    const event = {
      name: "OrderConfirmed", workspaceId: WS_A, eventId: "evt-1",
      payload: { customerId, orderId: "order-1", conversationId },
    };
    const r1 = await evaluateEvent(db as Db, event);
    expect(r1.executed).toBe(1);
    // same event again → idempotent (execution already recorded)
    const r2 = await evaluateEvent(db as Db, event);
    expect(r2.skipped).toBe(1);
    expect((db._stores.followUp as any[])).toHaveLength(1);
    const fu = (db._stores.followUp as any[])[0];
    expect(fu.scheduledAt - fu.createdAt).toBeGreaterThanOrEqual(24 * 3600_000 - 1000);
  });

  it("conditions not met → SKIPPED", async () => {
    await seedConfirmedOrderAutomation();
    const result = await evaluateEvent(db as Db, {
      name: "OrderConfirmed", workspaceId: WS_A, eventId: "evt-2",
      payload: { customerId, orderId: "order-2" },
    });
    // customer province is دمشق in seed → change it
    await db.customer.update({ where: { id: customerId }, data: { province: "حلب" } } as never);
    const r = await evaluateEvent(db as Db, { name: "OrderConfirmed", workspaceId: WS_A, eventId: "evt-3", payload: { customerId, orderId: "order-3" } });
    expect(r.skipped).toBe(1);
    void result;
  });

  it("loop prevention: automation never re-triggers itself in the same chain", async () => {
    await db.automation.create({
      data: {
        workspaceId: WS_A, name: "self", trigger: "CUSTOMER_UPDATED",
        actions: [{ type: "ADD_TAG", tag: "x" }],
      },
    } as never);
    const event = {
      name: "CustomerUpdated", workspaceId: WS_A, eventId: "evt-loop",
      payload: { customerId }, originAutomationId: "c-automation-1",
    };
    // force the created automation id to match the origin
    const automation = (db._stores.automation as any[])[0];
    event.originAutomationId = automation.id;
    const r = await evaluateEvent(db as Db, event);
    expect(r.skipped).toBe(1);
    expect((db._stores.customerMemory as any[]).length).toBe(0);
  });

  it("workspace isolation: automation in WS_A never evaluates WS_B events", async () => {
    await seedConfirmedOrderAutomation();
    const r = await evaluateEvent(db as Db, {
      name: "OrderConfirmed", workspaceId: WS_B, eventId: "evt-b",
      payload: { customerId, orderId: "order-b" },
    });
    expect(r.executed).toBe(0);
    expect((db._stores.followUp as any[])).toHaveLength(0);
  });

  it("SEND_MESSAGE goes through the ChannelSender (Facebook mock), recipient from DB", async () => {
    await db.automation.create({
      data: {
        workspaceId: WS_A, name: "رسالة", trigger: "ORDER_CONFIRMED",
        actions: [{ type: "SEND_MESSAGE", template: "شكرًا {{customer.name}} 🌹" }],
      },
    } as never);
    await evaluateEvent(db as Db, {
      name: "OrderConfirmed", workspaceId: WS_A, eventId: "evt-msg",
      payload: { customerId, conversationId },
    });
    expect(sentToMeta).toHaveLength(1);
    expect(sentToMeta[0].text).toContain("محمد");
  });
});

describe("Phase 7 — follow-ups", () => {
  it("atomic claim: 100 concurrent claims → exactly 1 winner", async () => {
    await createFollowUp(db as Db, {
      workspaceId: WS_A, customerId, conversationId, type: "CHECK_IN",
      messageText: "متابعة", scheduledAt: new Date(Date.now() - 1000),
      idempotencyKey: "fu-1",
    });
    // simulate 100 workers calling claim on separate "transactions"
    const results = await Promise.all(
      Array.from({ length: 100 }, () => claimDueFollowUps(db as Db, 10))
    );
    const totalClaimed = results.reduce((s, r) => s + r.length, 0);
    expect(totalClaimed).toBe(1);
  });

  it("duplicate scheduling prevented via idempotency key", async () => {
    const input = {
      workspaceId: WS_A, customerId, conversationId, type: "X",
      messageText: "نص", scheduledAt: new Date(), idempotencyKey: "dup-key",
    };
    await createFollowUp(db as Db, input);
    await createFollowUp(db as Db, input);
    expect((db._stores.followUp as any[])).toHaveLength(1);
  });

  it("execution sends through Facebook and marks SENT; policy block → SKIPPED", async () => {
    const fu = await createFollowUp(db as Db, {
      workspaceId: WS_A, customerId, conversationId, type: "CHECK_IN",
      messageText: "متابعة", scheduledAt: new Date(Date.now() - 1000), idempotencyKey: "fu-exec",
    });
    await db.followUp.update({ where: { id: (fu as any).id }, data: { status: "RUNNING", attempts: 1 } } as never);
    const res = await executeFollowUp(db as Db, {
      id: (fu as any).id, workspaceId: WS_A, customerId, conversationId, orderId: null,
      type: "CHECK_IN", messageText: "متابعة", attempts: 1,
    });
    expect(res).toBe("SENT");
    expect(sentToMeta).toHaveLength(1);

    // policy block: window closed
    await db.conversation.update({ where: { id: conversationId }, data: { lastCustomerMessageAt: new Date(Date.now() - 30 * 3600_000) } } as never);
    const fu2 = await createFollowUp(db as Db, {
      workspaceId: WS_A, customerId, conversationId, type: "CHECK_IN",
      messageText: "متابعة 2", scheduledAt: new Date(Date.now() - 1000), idempotencyKey: "fu-policy",
    });
    const res2 = await executeFollowUp(db as Db, {
      id: (fu2 as any).id, workspaceId: WS_A, customerId, conversationId, orderId: null,
      type: "CHECK_IN", messageText: "متابعة 2", attempts: 1,
    });
    expect(res2).toBe("SKIPPED");
    expect(sentToMeta).toHaveLength(1); // policy enforced — no send
  });

  it("cancellation only for non-sent follow-ups", async () => {
    const fu = await createFollowUp(db as Db, {
      workspaceId: WS_A, customerId, conversationId, type: "X",
      messageText: "نص", scheduledAt: new Date(), idempotencyKey: "fu-cancel",
    });
    const cancelled = await cancelFollowUp(db as Db, AGENT, (fu as any).id);
    expect(cancelled.status).toBe("CANCELLED");
    await expect(cancelFollowUp(db as Db, AGENT, (fu as any).id)).rejects.toBeTruthy();
  });

  it("scheduler processes due follow-ups end-to-end", async () => {
    await createFollowUp(db as Db, {
      workspaceId: WS_A, customerId, conversationId, type: "CHECK_IN",
      messageText: "متابعة مجدولة", scheduledAt: new Date(Date.now() - 5000), idempotencyKey: "fu-sched",
    });
    const result = await processDueFollowUps(db as Db);
    expect(result.sent).toBe(1);
    expect(sentToMeta).toHaveLength(1);
  });

  it("restart recovery: follow-ups persist and run after 'restart' (new worker call)", async () => {
    await createFollowUp(db as Db, {
      workspaceId: WS_A, customerId, conversationId, type: "CHECK_IN",
      messageText: "بعد restart", scheduledAt: new Date(Date.now() - 5000), idempotencyKey: "fu-restart",
    });
    // simulate restart: fresh call, same DB — follow-up still there and executes
    const due = await db.followUp.findMany({ where: { status: "SCHEDULED" } } as never);
    expect(due).toHaveLength(1);
    const result = await processDueFollowUps(db as Db);
    expect(result.sent).toBe(1);
  });
});

describe("Phase 7 — human handoffs", () => {
  it("creates handoff → conversation HUMAN_ACTIVE (AI pause invariant)", async () => {
    const handoff = await createHandoff(db as Db, {
      workspaceId: WS_A, conversationId, customerId, reason: "CUSTOMER_REQUEST",
    });
    const conv = await db.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conv.aiState).toBe("HUMAN_ACTIVE");
    expect(conv.aiEnabled).toBe(false);
    expect(handoff.priority).toBe("NORMAL"); // server policy: customer request → NORMAL
  });

  it("priority floor: payment issue forced to HIGH regardless of AI suggestion", async () => {
    const handoff = await createHandoff(db as Db, {
      workspaceId: WS_A, conversationId, customerId, reason: "PAYMENT_ISSUE", priority: "LOW",
    });
    expect(handoff.priority).toBe("HIGH");
  });

  it("claim race: two agents → one wins, one gets 409", async () => {
    const handoff = await createHandoff(db as Db, { workspaceId: WS_A, conversationId, customerId, reason: "COMPLAINT" });
    const agentA = { userId: "agent-a", workspaceId: WS_A };
    const agentB = { userId: "agent-b", workspaceId: WS_A };
    const results = await Promise.allSettled([
      claimHandoff(db as Db, agentA, (handoff as any).id),
      claimHandoff(db as Db, agentB, (handoff as any).id),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
  });

  it("release → OPEN again; resolve → closed", async () => {
    const handoff = await createHandoff(db as Db, { workspaceId: WS_A, conversationId, customerId, reason: "MANUAL" });
    await claimHandoff(db as Db, AGENT, (handoff as any).id);
    const released = await releaseHandoff(db as Db, AGENT, (handoff as any).id);
    expect(released.status).toBe("OPEN");
    await claimHandoff(db as Db, AGENT, (handoff as any).id);
    const resolved = await resolveHandoff(db as Db, AGENT, (handoff as any).id);
    expect(resolved.status).toBe("RESOLVED");
  });

  it("workspace isolation: WS_B cannot claim WS_A handoff", async () => {
    const handoff = await createHandoff(db as Db, { workspaceId: WS_A, conversationId, customerId, reason: "MANUAL" });
    await expect(claimHandoff(db as Db, { userId: "x", workspaceId: WS_B }, (handoff as any).id)).rejects.toBeTruthy();
  });

  it("LEAST_LOADED routing picks the available agent", async () => {
    const handoff = await createHandoff(db as Db, { workspaceId: WS_A, conversationId, customerId, reason: "MANUAL" });
    const routed = await routeHandoff(db as Db, WS_A, (handoff as any).id, "LEAST_LOADED");
    expect(routed.status).toBe("CLAIMED");
    expect(routed.assignedTo).toBeTruthy();
  });

  it("after handoff, AI does not respond to next message", async () => {
    await createHandoff(db as Db, { workspaceId: WS_A, conversationId, customerId, reason: "CUSTOMER_REQUEST" });
    const inbound = await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", externalUserId: "psid-1",
      externalConversationId: "fb-conv-1", externalMessageId: "m-after", externalEventId: "e-after",
      provider: "facebook", type: "TEXT", text: "أي شيء",
    });
    const result = await processAIMessage(db as Db, {
      workspaceId: WS_A, conversationId: inbound.conversationId, messageId: inbound.messageId,
    }, { vectorStore: emptyStore() });
    expect(result.status).toBe("AI_DISABLED");
  });
});

describe("Phase 7 — human replies through Facebook", () => {
  it("agent reply goes through ChannelSender + policy to Facebook", async () => {
    const result = await sendHumanReply(db as Db, {
      workspaceId: WS_A, conversationId, userId: "agent-1", text: "أهلًا، معك أحمد من فريق العملاء 🌹",
    });
    expect(result.deliveryStatus).toBe("SENT");
    expect(sentToMeta).toHaveLength(1);
    const msg = (db._stores.message as any[]).find((m) => m.senderType === "HUMAN");
    expect(msg.deliveryStatus).toBe("SENT");
    expect(msg.externalMessageId).toBeTruthy();
  });

  it("human reply idempotency: same key → one send", async () => {
    await sendHumanReply(db as Db, { workspaceId: WS_A, conversationId, userId: "agent-1", text: "مرحبا", idempotencyKey: "human-key-1" });
    const r2 = await sendHumanReply(db as Db, { workspaceId: WS_A, conversationId, userId: "agent-1", text: "مرحبا", idempotencyKey: "human-key-1" });
    expect(r2.deliveryStatus).toBe("SKIPPED_DUPLICATE");
    expect(sentToMeta).toHaveLength(1);
  });

  it("AI cannot control the Facebook recipient — recipient comes from ChannelIdentity", async () => {
    // The dispatch API accepts NO recipient parameter at all: the recipient is
    // always resolved from the customer's ChannelIdentity in the DB.
    await sendHumanReply(db as Db, { workspaceId: WS_A, conversationId, userId: "agent-1", text: "مرحبا" });
    expect(sentToMeta).toHaveLength(1);
    expect(sentToMeta[0].recipientId).toBe("psid-alice"); // the DB identity, not any AI/user-provided value
  });
});

describe("Phase 7 — takeover still works through handoff service path", () => {
  it("takeover keeps conversation paused for AI", async () => {
    await takeoverConversation(db as Db, AGENT, conversationId);
    const conv = await db.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conv.aiState).toBe("HUMAN_ACTIVE");
    expect(conv.aiEnabled).toBe(false);
  });
});
