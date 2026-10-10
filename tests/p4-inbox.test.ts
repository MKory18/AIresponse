import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import {
  deleteConversation,
  getConversationDetail,
  listConversations,
  listMessages,
  postNote,
  takeoverConversation,
  assignConversation,
} from "@/modules/conversations/service";
import { processIncomingMessage } from "@/modules/conversations/service";
import { getCustomerDetail, updateCustomer } from "@/modules/customers/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import type { AIProvider, AIResponse, StructuredRequest, TextRequest } from "@/modules/ai/provider";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";

/**
 * P4 inbox + Contact 360 — service behavior on the in-memory double plus
 * route-level permission pins (mocked auth boundary, real handlers).
 */

const seenPermissions: string[] = [];
vi.mock("@/modules/auth/context", async () => {
  const { AuthorizationError } = await import("@/core/errors");
  return {
    getAuthContext: async () => ({
      userId: "agent-1",
      workspaceId: "ws-p4",
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

const WS = "ws-p4";
const OTHER = "ws-p4-other";
const AGENT = { userId: "agent-1", workspaceId: WS };
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;

async function seedConversation(opts: {
  status?: string;
  priority?: string;
  aiState?: string;
  assignedAgentId?: string | null;
  unreadCount?: number;
  channelType?: "FACEBOOK";
} = {}) {
  const customer = (await db.customer.create({
    data: { workspaceId: WS, name: "زبون", phone: `09${Math.floor(10000000 + Math.random() * 89999999)}` },
  } as never)) as any;
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: opts.channelType ?? "FACEBOOK", status: "CONNECTED", displayName: "P", externalId: "page-1" },
  } as never)) as any;
  const conv = (await db.conversation.create({
    data: {
      workspaceId: WS, customerId: customer.id, channelId: ch.id,
      channelConversationId: `fb-${Math.random().toString(36).slice(2, 10)}`,
      status: opts.status ?? "OPEN",
      priority: opts.priority ?? "NORMAL",
      aiState: opts.aiState ?? "AI_ACTIVE",
      assignedAgentId: opts.assignedAgentId ?? null,
      unreadCount: opts.unreadCount ?? 0,
    },
  } as never)) as any;
  return { customer, conv };
}

async function seedMessage(conversationId: string, text: string, extra: Record<string, unknown> = {}) {
  return db.message.create({
    data: {
      conversationId, workspaceId: WS, senderType: "CUSTOMER", direction: "INBOUND",
      type: "TEXT", text, deliveryStatus: "DELIVERED", ...extra,
    },
  } as never);
}

beforeEach(() => {
  db = createFakeDb();
  seenPermissions.length = 0;
});

describe("P4 server-side filters + pagination + ordering", () => {
  it("filters by status/priority/assignee/channel and combines them", async () => {
    const a = await seedConversation({ status: "OPEN", priority: "URGENT" });
    await seedConversation({ status: "RESOLVED", priority: "LOW" });
    await db.conversation.update({ where: { id: a.conv.id }, data: { assignedAgentId: "agent-1" } });
    const urgent = await listConversations(db as Db, { workspaceId: WS, priority: "URGENT" });
    expect(urgent.items.map((c) => c.id)).toEqual([a.conv.id]);
    const mine = await listConversations(db as Db, { workspaceId: WS, assignee: "me", actorUserId: "agent-1" });
    expect(mine.items.map((c) => c.id)).toEqual([a.conv.id]);
    const none = await listConversations(db as Db, { workspaceId: WS, assignee: "none" });
    expect(none.items.length).toBe(1);
    const chan = await listConversations(db as Db, { workspaceId: WS, channelType: "FACEBOOK" });
    expect(chan.items.length).toBe(2);
    const combined = await listConversations(db as Db, { workspaceId: WS, status: "OPEN", priority: "URGENT", assignee: "me", actorUserId: "agent-1" });
    expect(combined.items.map((c) => c.id)).toEqual([a.conv.id]);
    const future = await listConversations(db as Db, { workspaceId: WS, dateFrom: new Date(Date.now() + 3600_000).toISOString() });
    expect(future.items).toHaveLength(0);
    const past = await listConversations(db as Db, { workspaceId: WS, dateFrom: new Date(Date.now() - 3600_000).toISOString() });
    expect(past.items.length).toBe(2);
  });

  it("message order is stable (createdAt, id) with cursor pagination", async () => {
    const { conv } = await seedConversation();
    for (let i = 0; i < 5; i += 1) {
      await seedMessage(conv.id, `msg-${i}`);
    }
    const page1 = await listMessages(db as Db, AGENT, conv.id, { limit: 2 });
    expect(page1.items.map((m: { text: string }) => m.text)).toEqual(["msg-3", "msg-4"]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listMessages(db as Db, AGENT, conv.id, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((m: { text: string }) => m.text)).toEqual(["msg-1", "msg-2"]);
  });

  it("unknown cursors and empty threads fail safe (shape, no throw)", async () => {
    const { conv } = await seedConversation();
    const r = await listMessages(db as Db, AGENT, conv.id, { cursor: "nope", limit: 10 });
    expect(Array.isArray(r.items)).toBe(true);
    expect(await listConversations(db as Db, { workspaceId: "ws-empty" })).toEqual({ items: [], nextCursor: null });
  });
});

describe("P4 internal notes — team-only, never sent", () => {
  it("creates labeled notes visible in the thread", async () => {
    const { conv } = await seedConversation();
    await seedMessage(conv.id, "مرحبا");
    const note = (await postNote(db as Db, AGENT, conv.id, "تابع معه غدا")) as any;
    expect(note.isNote).toBe(true);
    expect(note.senderId).toBe("agent-1");
    const thread = await listMessages(db as Db, AGENT, conv.id, {});
    expect(thread.items.map((m: { isNote?: boolean }) => m.isNote ?? false)).toEqual([false, true]);
  });

  it("notes never become outbound rows and carry no send identity", async () => {
    const { conv } = await seedConversation();
    const note = (await postNote(db as Db, AGENT, conv.id, "سرية")) as any;
    // Retry-guard shape: retry requires OUTBOUND + idempotency key.
    expect(note.direction).not.toBe("OUTBOUND");
    expect(note.outboundIdempotencyKey ?? null).toBeNull();
    const outbounds = (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND");
    expect(outbounds).toHaveLength(0);
  });

  it("notes are excluded from AI history (prompts unchanged)", async () => {
    const captured: string[] = [];
    const rec = {
      name: "rec",
      delivery: "external" as const,
      async generateText(r: TextRequest): Promise<AIResponse> {
        captured.push(`${r.system}\n${r.user}`);
        return { text: "أهلا", promptTokens: 1, completionTokens: 1, latencyMs: 1 };
      },
      async generateStructured<T>(r: StructuredRequest<T>): Promise<AIResponse & { value: T }> {
        captured.push(`${r.system}\n${r.user}`);
        const raw = { intent: "GREETING", confidence: 0.99, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER" };
        const v = r.validate(raw);
        if (!v.ok) throw new Error("bad fixture");
        return { text: "{}", promptTokens: 1, completionTokens: 1, latencyMs: 1, value: v.value };
      },
    } satisfies AIProvider;
    const { conv } = await seedConversation();
    await db.channelAccount.create({
      data: { channelId: (await db.channel.findFirst({}) as any).id, provider: "FACEBOOK", externalAccountId: "page-1", pageName: "P", encryptedCredentials: "eJwDAAAAAAA" },
    } as never);
    await db.aISettings.create({ data: { workspaceId: WS } } as never);
    await db.persona.create({ data: { workspaceId: WS, name: "P" } } as never);
    const inbound = await processIncomingMessage(db as Db, {
      workspaceId: WS, channelType: "FACEBOOK", externalUserId: "fb-n", externalConversationId: `fbn-${Date.now()}`,
      externalMessageId: "m-n", externalEventId: "e-n", provider: "mock", type: "TEXT", text: "مرحبا",
    });
    await postNote(db as Db, AGENT, inbound.conversationId, "ملاحظة سرية للفريق 999");
    const vectors = new InMemoryVectorStore(new Map(), new Map());
    await processAIMessage(
      db as Db,
      { workspaceId: WS, conversationId: inbound.conversationId, messageId: inbound.messageId },
      { provider: rec, vectorStore: vectors }
    );
    expect(captured.join("\n")).not.toContain("ملاحظة سرية");
  });
});

describe("P4 Contact 360 — relations without invention", () => {
  it("exposes email, blacklist, adSource, orders and conversations", async () => {
    const { customer, conv } = await seedConversation();
    await db.customer.update({ where: { id: customer.id }, data: { email: "c@x.test", isBlacklisted: true, blacklistSource: "OMS" } });
    await db.order.create({
      data: { workspaceId: WS, orderNumber: "O-1", customerId: customer.id, conversationId: conv.id, status: "CONFIRMED", subtotal: 1, total: 1, adSource: "ad-42" },
    } as never);
    const detail = (await getCustomerDetail(db as Db, AGENT, customer.id)) as any;
    expect(detail.email).toBe("c@x.test");
    expect(detail.isBlacklisted).toBe(true);
    expect(detail.blacklistSource).toBe("OMS");
    expect(detail.orders[0].adSource).toBe("ad-42");
    expect(detail.conversations.length).toBeGreaterThan(0);
  });

  it("cross-workspace customers 404 (no existence leak)", async () => {
    const { customer } = await seedConversation();
    await expect(getCustomerDetail(db as Db, { userId: "x", workspaceId: OTHER }, customer.id)).rejects.toThrow();
    await expect(updateCustomer(db as Db, { userId: "x", workspaceId: OTHER }, customer.id, { name: "H" })).rejects.toThrow();
  });
});

describe("P4 assignment, handoff banner, activity, hidden threads", () => {
  it("assign/reassign audits and surfaces in detail + history", async () => {
    const { conv } = await seedConversation();
    const agent2 = (await db.user.create({ data: { email: "a2@x.test", name: "A2", passwordHash: "x" } })) as any;
    const me = (await db.user.create({ data: { id: "agent-1", email: "me@x.test", name: "Me", passwordHash: "x" } })) as any;
    void me;
    await db.workspaceMember.create({ data: { workspaceId: WS, userId: agent2.id, role: "SALES_AGENT", status: "ACTIVE" } } as never);
    await assignConversation(db as Db, AGENT, conv.id, agent2.id);
    await takeoverConversation(db as Db, { userId: agent2.id, workspaceId: WS }, conv.id);
    const detail = (await getConversationDetail(db as Db, AGENT, conv.id)) as any;
    expect(detail.assignedAgentId).toBe(agent2.id);
    const actions = detail.assignmentHistory.map((a: { action: string }) => a.action);
    expect(actions).toContain("conversation.assigned");
    expect(actions).toContain("conversation.takeover");
    // Actor names resolved (order-independent: same-ms rows have no total order).
    const actors = detail.assignmentHistory.map((a: { actorName: string | null }) => a.actorName);
    expect(actors).toContain("A2");
    expect(actors).toContain("Me");
  });

  it("open handoff appears in detail for the banner", async () => {
    const { conv } = await seedConversation();
    await db.humanHandoff.create({
      data: { workspaceId: WS, conversationId: conv.id, customerId: "c", reason: "COMPLAINT", status: "OPEN", priority: "HIGH" },
    } as never);
    const detail = (await getConversationDetail(db as Db, AGENT, conv.id)) as any;
    expect(detail.openHandoff).toMatchObject({ reason: "COMPLAINT", status: "OPEN" });
  });

  it("hidden threads vanish from lists but reopen on new inbound (history kept)", async () => {
    const r = await processIncomingMessage(db as Db, {
      workspaceId: WS, channelType: "FACEBOOK", externalUserId: "fb-h", externalConversationId: "fbh-1",
      externalMessageId: "m-h1", externalEventId: "e-h1", provider: "mock", type: "TEXT", text: "hi",
    });
    const { deleteConversation } = await import("@/modules/conversations/service");
    await deleteConversation(db as Db, AGENT, r.conversationId);
    expect((await listConversations(db as Db, { workspaceId: WS })).items).toHaveLength(0);
    const r2 = await processIncomingMessage(db as Db, {
      workspaceId: WS, channelType: "FACEBOOK", externalUserId: "fb-h", externalConversationId: "fbh-1",
      externalMessageId: "m-h2", externalEventId: "e-h2", provider: "mock", type: "TEXT", text: "again",
    });
    expect(r2.conversationId).toBe(r.conversationId);
    const thread = await listMessages(db as Db, AGENT, r.conversationId, {});
    expect(thread.items.length).toBe(2);
  });
});

describe("P4 isolation + RBAC pins", () => {
  it("cross-workspace conversation/message/note access 404s", async () => {
    const { conv } = await seedConversation();
    const X = { userId: "x", workspaceId: OTHER };
    await expect(listMessages(db as Db, X, conv.id, {})).rejects.toThrow();
    await expect(postNote(db as Db, X, conv.id, "x")).rejects.toThrow();
    await expect(assignConversation(db as Db, X, conv.id, null)).rejects.toThrow();
    await expect(getConversationDetail(db as Db, X, conv.id)).rejects.toThrow();
  });

  it("notes/assign endpoints require their permissions (403, leak-free)", async () => {
    const { POST: notePost } = await import("@/app/api/conversations/[id]/notes/route");
    const r1 = await notePost(
      new NextRequest("http://localhost/api/conversations/cid/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
      { params: { id: "cid" } }
    );
    expect(r1.status).toBe(403);
    expect(await r1.text()).not.toContain("hi");
    const { POST: assignPost } = await import("@/app/api/conversations/[id]/assign/route");
    const r2 = await assignPost(
      new NextRequest("http://localhost/api/conversations/cid/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: null }),
      }),
      { params: { id: "cid" } }
    );
    expect(r2.status).toBe(403);
    expect(seenPermissions).toContain("conversations.reply");
    expect(seenPermissions).toContain("conversations.assign");
  });
});

describe("P4 identity — concurrent duplicate delivery", () => {
  it("same event twice in parallel yields one thread and one message (P2002 loser paths)", async () => {
    // Production-faithful: the identity already exists (first contact won it
    // earlier), so the race is isolated to conversation/message creation —
    // exactly what the P2002 guards cover.
    const customer = (await db.customer.create({ data: { workspaceId: WS, phone: "0999000000" } } as never)) as any;
    await db.channelIdentity.create({
      data: { workspaceId: WS, customerId: customer.id, channelType: "FACEBOOK", channelExternalId: "fb-d" },
    } as never);
    const base = {
      workspaceId: WS, channelType: "FACEBOOK", externalUserId: "fb-d",
      externalConversationId: "fbd-1", externalMessageId: "m-d", externalEventId: "e-d",
      provider: "mock", type: "TEXT", text: "hi",
    } as const;
    const [r1, r2] = await Promise.all([
      processIncomingMessage(db as Db, { ...base }),
      processIncomingMessage(db as Db, { ...base }),
    ]);
    expect(r1.conversationId).toBe(r2.conversationId);
    const convs = (db._stores.conversation as any[]).filter((c) => c.channelConversationId === "fbd-1");
    expect(convs).toHaveLength(1);
    const msgs = (db._stores.message as any[]).filter((m) => m.externalEventId === "e-d");
    expect(msgs).toHaveLength(1);
    expect([r1.duplicate, r2.duplicate].filter(Boolean)).toHaveLength(1);
  });
});
