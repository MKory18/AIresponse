import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { MockAIProvider, setMockAIProvider } from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { resolveSenderName } from "@/modules/channels/facebook/profile";
import { resolveChannelPersona } from "@/modules/ai/channel-persona";
import { processAIMessage } from "@/modules/ai/orchestrator";
import {
  deleteConversation,
  listConversations,
  processIncomingMessage,
  releaseConversationToAI,
  takeoverConversation,
} from "@/modules/conversations/service";
import { createHandoff } from "@/modules/handoffs/handoff-service";
import { encryptSecret } from "@/core/crypto";
import { avatarOf, displayNameOf, pageNameOf } from "@/components/inbox/types";

const WS_A = "ws-mode-a";
const WS_B = "ws-mode-b";
const AGENT = { userId: "agent-mode", workspaceId: WS_A };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
let mock: MockAIProvider;

const emptyVectors = () => ({ search: async () => [] }) as never;

async function seedPage(ws: string, pageId: string, pageName: string, aiPersonaId?: string) {
  const ch = (await db.channel.create({
    data: {
      workspaceId: ws, type: "FACEBOOK", status: "CONNECTED",
      displayName: pageName, externalId: pageId, aiPersonaId: aiPersonaId ?? null,
    },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: pageId, pageName,
      encryptedCredentials: encryptSecret("tok"),
    },
  } as never);
  return ch;
}

async function seedInbound(ws: string, psid: string, text: string, channelId?: string) {
  const res = await processIncomingMessage(db as Db, {
    workspaceId: ws,
    channelType: "FACEBOOK",
    channelId,
    externalUserId: psid,
    externalConversationId: psid,
    externalMessageId: `m-${psid}-${Math.random().toString(36).slice(2, 8)}`,
    externalEventId: `e-${psid}-${Math.random().toString(36).slice(2, 8)}`,
    provider: "facebook",
    type: "TEXT",
    text,
  });
  const inbound = (db._stores.message as any[]).find(
    (m) => m.direction === "INBOUND" && m.conversationId === res.conversationId
  );
  return { ...res, messageId: inbound.id };
}

async function seedPersona(ws: string, name: string, extra: Record<string, unknown> = {}) {
  return (await db.persona.create({
    data: { workspaceId: ws, name, isActive: true, ...extra },
  } as never)) as any;
}

beforeEach(async () => {
  db = createFakeDb();
  (db._stores.workspaceMember as any[]).push(
    { id: "m-a", workspaceId: WS_A, userId: AGENT.userId, status: "ACTIVE" },
    { id: "m-b", workspaceId: WS_B, userId: "agent-b", status: "ACTIVE" }
  );
  mock = new MockAIProvider();
  setMockAIProvider(mock);
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
          return Response.json({ id: "page", name: "Demo" });
        }) as typeof fetch,
      })
  );
  await db.aISettings.create({
    data: { workspaceId: WS_A, provider: "mock", temperature: 0.4, maxTokens: 500 },
  } as never);
});

describe("conversation state machine: AI stays AI_ACTIVE", () => {
  it("1. new Facebook conversation defaults to AI_ACTIVE", async () => {
    const r = await seedInbound(WS_A, "psid-new", "مرحبا");
    const conv = (db._stores.conversation as any[]).find((c) => c.id === r.conversationId);
    expect(conv.aiState).toBe("AI_ACTIVE");
    expect(conv.aiEnabled).toBe(true);
  });

  it("2. AI failure does NOT switch to HUMAN_ACTIVE (alert only)", async () => {
    const r = await seedInbound(WS_A, "psid-f", "مرحبا");
    const failing = new MockAIProvider();
    (failing as any).generateText = async () => {
      throw new Error("provider down");
    };
    const res = await processAIMessage(
      db as Db,
      { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A },
      { provider: failing, vectorStore: emptyVectors() }
    );
    expect(res.status).toBe("AI_FAILED");
    const conv = (db._stores.conversation as any[]).find((c) => c.id === r.conversationId);
    expect(conv.aiState).toBe("AI_ACTIVE");
    expect(
      (db._stores.humanHandoff as any[]).some((h) => h.conversationId === r.conversationId && h.status === "OPEN")
    ).toBe(true);
  });

  it("3. low confidence does NOT switch to HUMAN_ACTIVE", async () => {
    const r = await seedInbound(WS_A, "psid-lc", "???");
    const low = new MockAIProvider();
    (low as any).intentHandler = () => ({ intent: "UNKNOWN", confidence: 0.05, entities: {}, memories: [] });
    const res = await processAIMessage(
      db as Db,
      { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A },
      { provider: low, vectorStore: emptyVectors() }
    );
    expect(res.status).toBe("HANDOFF");
    const conv = (db._stores.conversation as any[]).find((c) => c.id === r.conversationId);
    expect(conv.aiState).toBe("AI_ACTIVE");
  });

  it("4. HumanHandoff OPEN coexists with AI_ACTIVE", async () => {
    const r = await seedInbound(WS_A, "psid-h", "مرحبا");
    await createHandoff(db as Db, {
      workspaceId: WS_A, conversationId: r.conversationId, customerId: r.customerId, reason: "LOW_CONFIDENCE",
    });
    const conv = (db._stores.conversation as any[]).find((c) => c.id === r.conversationId);
    expect(conv.aiState).toBe("AI_ACTIVE");
    expect(
      (db._stores.humanHandoff as any[]).some((h) => h.conversationId === r.conversationId && h.status === "OPEN")
    ).toBe(true);
  });

  it("5. manual takeover switches to HUMAN_ACTIVE", async () => {
    const r = await seedInbound(WS_A, "psid-t", "مرحبا");
    await takeoverConversation(db as Db, AGENT, r.conversationId);
    const conv = (db._stores.conversation as any[]).find((c) => c.id === r.conversationId);
    expect(conv.aiState).toBe("HUMAN_ACTIVE");
    expect(conv.aiEnabled).toBe(false);
  });

  it("6. manual release switches back to AI_ACTIVE", async () => {
    const r = await seedInbound(WS_A, "psid-r", "مرحبا");
    await takeoverConversation(db as Db, AGENT, r.conversationId);
    await releaseConversationToAI(db as Db, AGENT, r.conversationId);
    const conv = (db._stores.conversation as any[]).find((c) => c.id === r.conversationId);
    expect(conv.aiState).toBe("AI_ACTIVE");
    expect(conv.aiEnabled).toBe(true);
  });

  it("7+25. HUMAN_ACTIVE blocks AI reply", async () => {
    const r = await seedInbound(WS_A, "psid-b", "مرحبا");
    await takeoverConversation(db as Db, AGENT, r.conversationId);
    const res = await processAIMessage(
      db as Db,
      { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A },
      { vectorStore: emptyVectors() }
    );
    expect(res.status).toBe("AI_DISABLED");
  });

  it("8. AI_ACTIVE allows AI reply", async () => {
    const ch = await seedPage(WS_A, "page-ai", "صفحة");
    const r = await seedInbound(WS_A, "psid-ok", "مرحبا", ch.id);
    const res = await processAIMessage(
      db as Db,
      { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A },
      { vectorStore: emptyVectors() }
    );
    expect(["RESPONDED", "CLARIFIED"]).toContain(res.status);
  });
});

describe("page-level AI persona", () => {
  it("9+10. Page A → Persona A, Page B → Persona B", async () => {
    const sales = await seedPersona(WS_A, "شخصية المبيعات");
    const support = await seedPersona(WS_A, "خدمة العملاء");
    const chA = await seedPage(WS_A, "page-A", "صفحة أ", sales.id);
    const chB = await seedPage(WS_A, "page-B", "صفحة ب", support.id);
    const pA = await resolveChannelPersona(db as Db, { workspaceId: WS_A, channelId: chA.id });
    const pB = await resolveChannelPersona(db as Db, { workspaceId: WS_A, channelId: chB.id });
    expect(pA).toMatchObject({ id: sales.id, name: "شخصية المبيعات", source: "channel" });
    expect(pB).toMatchObject({ id: support.id, name: "خدمة العملاء", source: "channel" });
  });

  it("falls back to workspace default when the page has none", async () => {
    await seedPersona(WS_A, "الافتراضية");
    const ch = await seedPage(WS_A, "page-X", "صفحة");
    const p = await resolveChannelPersona(db as Db, { workspaceId: WS_A, channelId: ch.id });
    expect(p.source).toBe("workspace");
  });

  it("11. same customer on two pages stays isolated with per-page persona", async () => {
    const sales = await seedPersona(WS_A, "شخصية المبيعات");
    const support = await seedPersona(WS_A, "خدمة العملاء");
    const chA = await seedPage(WS_A, "page-A", "صفحة أ", sales.id);
    const chB = await seedPage(WS_A, "page-B", "صفحة ب", support.id);
    const rA = await seedInbound(WS_A, "psid-same-A", "مرحبا", chA.id);
    const rB = await seedInbound(WS_A, "psid-same-B", "مرحبا", chB.id);
    expect(rA.conversationId).not.toBe(rB.conversationId);
    const resA = await processAIMessage(
      db as Db, { conversationId: rA.conversationId, messageId: rA.messageId, workspaceId: WS_A },
      { vectorStore: emptyVectors() }
    );
    const resB = await processAIMessage(
      db as Db, { conversationId: rB.conversationId, messageId: rB.messageId, workspaceId: WS_A },
      { vectorStore: emptyVectors() }
    );
    expect(resA.persona?.name).toBe("شخصية المبيعات");
    expect(resB.persona?.name).toBe("خدمة العملاء");
  });

  it("12. persona is included in the AI context", async () => {
    await seedPersona(WS_A, "شخصية المبيعات", { systemInstructions: "القاعدة الذهبية للاختبار" });
    const ch = await seedPage(WS_A, "page-A", "صفحة أ");
    // assign via channel update path
    const personas = (db._stores.persona as any[]).filter((p) => p.workspaceId === WS_A);
    await db.channel.update({ where: { id: ch.id }, data: { aiPersonaId: personas[0].id } } as never);
    let captured = "";
    mock.responseHandler = (_user, system) => {
      captured = system;
      return "أهلا بك";
    };
    const r = await seedInbound(WS_A, "psid-ctx", "مرحبا", ch.id);
    await processAIMessage(
      db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A },
      { vectorStore: emptyVectors() }
    );
    expect(captured).toContain("شخصية المبيعات");
    expect(captured).toContain("القاعدة الذهبية للاختبار");
  });

  it("23. persona assignment is workspace-isolated", async () => {
    const other = await seedPersona(WS_B, "أجنبية");
    const ch = await seedPage(WS_A, "page-A", "صفحة أ");
    // cross-workspace assignment must not resolve
    await db.channel.update({ where: { id: ch.id }, data: { aiPersonaId: other.id } } as never);
    await seedPersona(WS_A, "محلية");
    const p = await resolveChannelPersona(db as Db, { workspaceId: WS_A, channelId: ch.id });
    expect(p.source).toBe("workspace");
    expect(p.name).toBe("محلية");
  });
});

describe("facebook name + avatar chain", () => {
  function profileClient(name: string | null, avatar: string | null, calls: string[]) {
    return new FacebookClient({
      fetchImpl: (async (url: string) => {
        calls.push(url as string);
        return Response.json({ first_name: name, profile_pic: avatar, id: "x" });
      }) as typeof fetch,
    });
  }

  it("13+14. name and avatar persist to identity + customer", async () => {
    await seedPage(WS_A, "page-A", "صفحة أ");
    const calls: string[] = [];
    const out = await resolveSenderName(db as Db, {
      workspaceId: WS_A, psid: "psid-av", pageToken: "tok",
      client: profileClient("ليلى", "https://fb.example/pic.jpg", calls),
    });
    expect(out.name).toBe("ليلى");
    expect(out.avatarUrl).toBe("https://fb.example/pic.jpg");
    await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", externalUserId: "psid-av",
      externalUserName: out.name, externalAvatarUrl: out.avatarUrl, externalConversationId: "psid-av",
      externalMessageId: "m-av", externalEventId: "e-av", provider: "facebook", type: "TEXT", text: "مرحبا",
    });
    const identity = (db._stores.channelIdentity as any[]).find((i) => i.channelExternalId === "psid-av");
    expect(identity.displayName).toBe("ليلى");
    expect(identity.avatarUrl).toBe("https://fb.example/pic.jpg");
    const customer = (db._stores.customer as any[]).find((c) => c.id === identity.customerId);
    expect(customer.name).toBe("ليلى");
    expect(customer.avatarUrl).toBe("https://fb.example/pic.jpg");
  });

  it("15+16. name and avatar are returned by the conversation API", async () => {
    const ch = await seedPage(WS_A, "page-A", "صفحة أ");
    await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", channelId: ch.id, externalUserId: "psid-api",
      externalUserName: "كريم", externalAvatarUrl: "https://fb.example/k.jpg",
      externalConversationId: "psid-api", externalMessageId: "m-api", externalEventId: "e-api",
      provider: "facebook", type: "TEXT", text: "مرحبا",
    });
    const list = await listConversations(db as Db, { workspaceId: WS_A });
    const row = list.items[0] as never as Parameters<typeof displayNameOf>[0] &
      Parameters<typeof avatarOf>[0];
    expect(displayNameOf(row)).toBe("كريم");
    expect(avatarOf(row)).toBe("https://fb.example/k.jpg");
  });

  it("17+18+19. UI helpers use real name/avatar/page", () => {
    const row = {
      customer: { name: "هند", phone: null, avatarUrl: "https://fb.example/h.jpg", identities: [] },
      channel: { type: "FACEBOOK", displayName: "صفحة أ", account: { pageName: "صفحة أ" } },
    };
    expect(displayNameOf(row)).toBe("هند");
    expect(avatarOf(row)).toBe("https://fb.example/h.jpg");
    expect(pageNameOf(row)).toBe("صفحة أ");
  });

  it("20+21. failed lookup blocks nothing and throttles repeats", async () => {
    await seedPage(WS_A, "page-A", "صفحة أ");
    const customer = (await db.customer.create({ data: { workspaceId: WS_A, status: "NEW_LEAD" } } as never)) as any;
    await db.channelIdentity.create({
      data: { workspaceId: WS_A, customerId: customer.id, channelType: "FACEBOOK", channelExternalId: "psid-nn" },
    } as never);
    const calls: string[] = [];
    const failing = new FacebookClient({
      fetchImpl: (async (url: string) => {
        calls.push(url as string);
        return Response.json({ error: { message: "denied", code: 10 } }, { status: 400 });
      }) as typeof fetch,
    });
    const first = await resolveSenderName(db as Db, { workspaceId: WS_A, psid: "psid-nn", pageToken: "tok", client: failing });
    expect(first.name).toBeNull();
    // message processing still works
    const r = await seedInbound(WS_A, "psid-nn", "مرحبا");
    expect(r.conversationId).toBeTruthy();
    const second = await resolveSenderName(db as Db, { workspaceId: WS_A, psid: "psid-nn", pageToken: "tok", client: failing });
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("22. fallback only when no real name exists", () => {
    expect(displayNameOf({ customer: { name: null, phone: null, identities: [] } })).toBeNull();
    expect(displayNameOf({ customer: { name: null, phone: "0911111111", identities: [] } })).toBe("0911111111");
  });
});

describe("delete stays deleted + isolation", () => {
  it("24. soft-deleted conversation stays out of list/polling", async () => {
    await seedPage(WS_A, "page-A", "صفحة أ");
    const r = await seedInbound(WS_A, "psid-del", "مرحبا");
    await deleteConversation(db as Db, AGENT, r.conversationId);
    for (let i = 0; i < 2; i++) {
      const list = await listConversations(db as Db, { workspaceId: WS_A });
      expect(list.items.find((c) => c.id === r.conversationId)).toBeUndefined();
    }
    // customer + memory + identity preserved
    expect((db._stores.customer as any[]).find((c) => c.id === r.customerId)).toBeTruthy();
    expect(
      (db._stores.channelIdentity as any[]).some((x: any) => x.channelExternalId === "psid-del")
    ).toBe(true);
  });
});
