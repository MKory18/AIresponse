import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { MockAIProvider, setMockAIProvider } from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";
import {
  deleteConversation,
  listConversations,
  listMessages,
  processIncomingMessage,
} from "@/modules/conversations/service";
import { loadMemory, saveMemories } from "@/modules/ai/memory";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { dispatchOutbound, sendHumanReply } from "@/modules/channels/outbound";
import { displayNameOf, pageNameOf } from "@/components/inbox/types";
import { t } from "@/lib/i18n";

const WS_A = "ws-inbox-a";
const WS_B = "ws-inbox-b";
const AGENT_A = { userId: "agent-a", workspaceId: WS_A };
const AGENT_B = { userId: "agent-b", workspaceId: WS_B };

type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
let sentToMeta: { recipientId: string; text: string }[];
let failNext: { times: number; transient: boolean };

function installMeta() {
  sentToMeta = [];
  failNext = { times: 0, transient: false };
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: { body?: string }) => {
          const u = new URL(url as string);
          if (u.pathname.endsWith("/me/messages")) {
            if (failNext.times > 0) {
              failNext.times -= 1;
              return Response.json(
                failNext.transient
                  ? { error: { message: "down", code: 1, is_transient: true } }
                  : { error: { message: "bad", code: 100, is_transient: false } }
              );
            }
            let body: any = null;
            try {
              body = JSON.parse(String((init as any)?.body ?? ""));
            } catch { /* legacy */ }
            const recipientId = body?.recipient?.id ?? "psid";
            sentToMeta.push({ recipientId, text: body?.message?.text ?? "" });
            return Response.json({ recipient_id: recipientId, message_id: `mid-${recipientId}` });
          }
          return Response.json({ id: "page", name: "Demo" });
        }) as typeof fetch,
      })
  );
}

async function seedPage(ws: string, pageId: string, pageName: string) {
  const ch = (await db.channel.create({
    data: { workspaceId: ws, type: "FACEBOOK", status: "CONNECTED", displayName: pageName, externalId: pageId },
  } as never)) as any;
  const account = (await db.channelAccount.create({
    data: {
      channelId: ch.id,
      provider: "FACEBOOK",
      externalAccountId: pageId,
      pageName,
      encryptedCredentials: encryptSecret("page-token-test"),
    },
  } as never)) as any;
  return { channel: ch, account };
}

async function seedInbound(ws: string, psid: string, text: string, channelId?: string, name?: string) {
  return processIncomingMessage(db as Db, {
    workspaceId: ws,
    channelType: "FACEBOOK",
    channelId,
    externalUserId: psid,
    externalUserName: name,
    externalConversationId: psid,
    externalMessageId: `m-${ws}-${psid}-${Math.random().toString(36).slice(2, 8)}`,
    externalEventId: `e-${ws}-${psid}-${Math.random().toString(36).slice(2, 8)}`,
    provider: "facebook",
    type: "TEXT",
    text,
  });
}

beforeEach(async () => {
  db = createFakeDb();
  (db._stores.workspaceMember as any[]).push(
    { id: "m-a", workspaceId: WS_A, userId: AGENT_A.userId, status: "ACTIVE" },
    { id: "m-b", workspaceId: WS_B, userId: AGENT_B.userId, status: "ACTIVE" }
  );
  setMockAIProvider(new MockAIProvider());
  installMeta();
  await db.aISettings.create({
    data: { workspaceId: WS_A, provider: "mock", temperature: 0.4, maxTokens: 500 },
  } as never);
});

describe("inbox identity", () => {
  it("1. real customer name wins over fallbacks", () => {
    expect(
      displayNameOf({ customer: { name: "محمد أحمد", phone: null, identities: [] } })
    ).toBe("محمد أحمد");
  });

  it("2. fallback is null (UI renders central عميل) only when nothing known", () => {
    expect(displayNameOf({ customer: { name: null, phone: null, identities: [] } })).toBeNull();
    expect(t.inbox.unknownCustomer).toBe("عميل");
    expect(
      displayNameOf({ customer: { name: null, phone: null, identities: [{ displayName: "Sara" }] } })
    ).toBe("Sara");
  });

  it("3. page identity comes from the channel account, not message text", () => {
    expect(
      pageNameOf({ channel: { displayName: "X", account: { pageName: "صفحة الريان" } } })
    ).toBe("صفحة الريان");
  });

  it("4. same customer on two pages keeps separate conversations + pages", async () => {
    const pageA = await seedPage(WS_A, "page-A", "صفحة الريان");
    const pageB = await seedPage(WS_A, "page-B", "صفحة الجمال");
    const r1 = await seedInbound(WS_A, "psid-A", "مرحبا", pageA.channel.id, "محمد أحمد");
    const r2 = await seedInbound(WS_A, "psid-B", "مرحبا", pageB.channel.id, "محمد أحمد");
    expect(r1.conversationId).not.toBe(r2.conversationId);
    const list = await listConversations(db as Db, { workspaceId: WS_A });
    const pages = new Map(list.items.map((c) => [c.id, pageNameOf(c as never)]));
    expect(pages.get(r1.conversationId)).toBe("صفحة الريان");
    expect(pages.get(r2.conversationId)).toBe("صفحة الجمال");
  });

  it("profile/identity names backfill customer.name end-to-end", async () => {
    await seedPage(WS_A, "page-A", "صفحة الريان");
    const r = await seedInbound(WS_A, "psid-1", "مرحبا", undefined, "ليلى");
    const list = await listConversations(db as Db, { workspaceId: WS_A });
    const row = list.items.find((c) => c.id === r.conversationId)!;
    expect(displayNameOf(row as never)).toBe("ليلى");
  });
});

describe("inbox outbound delivery", () => {
  it("5. human outbound reaches the sender service and is SENT", async () => {
    const page = await seedPage(WS_A, "page-A", "صفحة الريان");
    const r = await seedInbound(WS_A, "psid-h", "مرحبا", page.channel.id);
    const res = await sendHumanReply(db as Db, {
      workspaceId: WS_A,
      conversationId: r.conversationId,
      userId: AGENT_A.userId,
      text: "أهلا بك",
      idempotencyKey: "k-human-1",
    });
    expect(res.deliveryStatus).toBe("SENT");
    expect(sentToMeta).toHaveLength(1);
    expect(sentToMeta[0].recipientId).toBe("psid-h");
  });

  it("6. AI outbound reaches the sender service and is SENT", async () => {
    const page = await seedPage(WS_A, "page-A", "صفحة الريان");
    const r = await seedInbound(WS_A, "psid-ai", "بكم السعر؟", page.channel.id);
    const inbound = (db._stores.message as any[]).find((m) => m.direction === "INBOUND");
    const res = await processAIMessage(
      db as Db,
      { conversationId: r.conversationId, messageId: inbound.id, workspaceId: WS_A },
      { vectorStore: { search: async () => [] } as never }
    );
    expect(["RESPONDED", "CLARIFIED"]).toContain(res.status);
    const outbound = (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND");
    expect(outbound.length).toBeGreaterThanOrEqual(1);
    expect(outbound.every((m) => m.deliveryStatus === "SENT")).toBe(true);
    expect(sentToMeta.length).toBeGreaterThanOrEqual(1);
  });

  it("7. failed outbound becomes FAILED with code + failedAt, no silence", async () => {
    const page = await seedPage(WS_A, "page-A", "صفحة الريان");
    const r = await seedInbound(WS_A, "psid-f", "مرحبا", page.channel.id);
    failNext = { times: 99, transient: false };
    const res = await sendHumanReply(db as Db, {
      workspaceId: WS_A,
      conversationId: r.conversationId,
      userId: AGENT_A.userId,
      text: "أهلا",
      idempotencyKey: "k-fail-1",
    });
    expect(res.deliveryStatus).toBe("FAILED");
    const row = (db._stores.message as any[]).find((m) => m.id === res.messageId);
    expect(row.deliveryStatus).toBe("FAILED");
    expect(row.metadata.providerErrorCode).toBeTruthy();
    expect(row.metadata.failedAt).toBeTruthy();
  });

  it("8. outbound retry reuses the row and never double-sends", async () => {
    const page = await seedPage(WS_A, "page-A", "صفحة الريان");
    const r = await seedInbound(WS_A, "psid-r", "مرحبا", page.channel.id);
    failNext = { times: 1, transient: true };
    const first = await dispatchOutbound(db as Db, {
      workspaceId: WS_A,
      conversationId: r.conversationId,
      sourceMessageId: "retry-key-1",
      text: "أهلا",
      senderType: "HUMAN",
      senderId: AGENT_A.userId,
    });
    expect(first.deliveryStatus).toBe("QUEUED");
    const second = await dispatchOutbound(db as Db, {
      workspaceId: WS_A,
      conversationId: r.conversationId,
      sourceMessageId: "retry-key-1",
      text: "أهلا",
      senderType: "HUMAN",
      senderId: AGENT_A.userId,
    });
    expect(second.deliveryStatus).toBe("SENT");
    expect(second.messageId).toBe(first.messageId);
    const rows = (db._stores.message as any[]).filter(
      (m) => m.outboundIdempotencyKey === `${r.conversationId}:retry-key-1`
    );
    expect(rows).toHaveLength(1);
    expect(sentToMeta).toHaveLength(1);
  });
});

describe("inbox conversation delete (soft)", () => {
  it("9+12+13. delete hides the thread but preserves customer + messages", async () => {
    await seedPage(WS_A, "page-A", "صفحة الريان");
    const r = await seedInbound(WS_A, "psid-d", "مرحبا");
    await deleteConversation(db as Db, AGENT_A, r.conversationId);
    const conv = (db._stores.conversation as any[]).find((c) => c.id === r.conversationId);
    expect(conv.deletedAt).toBeTruthy();
    // customer + messages preserved
    expect((db._stores.customer as any[]).find((c) => c.id === r.customerId)).toBeTruthy();
    expect(
      (db._stores.message as any[]).filter((m) => m.conversationId === r.conversationId).length
    ).toBeGreaterThanOrEqual(1);
  });

  it("10+11. deleted conversation leaves list + polling and detail 404s", async () => {
    await seedPage(WS_A, "page-A", "صفحة الريان");
    const r = await seedInbound(WS_A, "psid-d2", "مرحبا");
    await deleteConversation(db as Db, AGENT_A, r.conversationId);
    const list = await listConversations(db as Db, { workspaceId: WS_A });
    expect(list.items.find((c) => c.id === r.conversationId)).toBeUndefined();
    const { getConversationDetail } = await import("@/modules/conversations/service");
    await expect(getConversationDetail(db as Db, AGENT_A, r.conversationId)).rejects.toThrow();
  });

  it("14. delete is workspace-isolated", async () => {
    await seedPage(WS_A, "page-A", "صفحة الريان");
    await seedPage(WS_B, "page-B", "صفحة ب");
    const a = await seedInbound(WS_A, "psid-wa", "مرحبا");
    const b = await seedInbound(WS_B, "psid-wb", "مرحبا");
    await deleteConversation(db as Db, AGENT_A, a.conversationId);
    const listB = await listConversations(db as Db, { workspaceId: WS_B });
    expect(listB.items.find((c) => c.id === b.conversationId)).toBeTruthy();
    await expect(deleteConversation(db as Db, AGENT_B, a.conversationId)).rejects.toThrow();
  });
});

describe("inbox AI continuity + ordering + mapping", () => {
  it("15+16. customer memory persists across turns in one conversation", async () => {
    await seedPage(WS_A, "page-A", "صفحة الريان");
    const r = await seedInbound(WS_A, "psid-m", "اسمي أحمد");
    const conv = (db._stores.conversation as any[]).find((c) => c.id === r.conversationId);
    await saveMemories(db as Db, {
      workspaceId: WS_A,
      customerId: conv.customerId,
      source: "test",
      memories: [{ type: "FACT", content: "اسم العميل أحمد" }],
    });
    const mems = await loadMemory(db as Db, WS_A, conv.customerId);
    expect(mems.some((m) => m.value.includes("أحمد"))).toBe(true);
    // second inbound stays in the SAME conversation
    const r2 = await seedInbound(WS_A, "psid-m", "ما اسمي؟");
    expect(r2.conversationId).toBe(r.conversationId);
  });

  it("17. message order stays chronological", async () => {
    await seedPage(WS_A, "page-A", "صفحة الريان");
    const r = await seedInbound(WS_A, "psid-o", "الأولى");
    await seedInbound(WS_A, "psid-o", "الثانية");
    const page = await listMessages(db as Db, AGENT_A, r.conversationId, { limit: 10 });
    const texts = page.items.map((m) => m.text);
    expect(texts[0]).toContain("الأولى");
    expect(texts[texts.length - 1]).toContain("الثانية");
  });

  it("18. conversation maps to the webhook-resolved page channel", async () => {
    const page = await seedPage(WS_A, "page-Z", "صفحة ز");
    const r = await seedInbound(WS_A, "psid-z", "مرحبا", page.channel.id);
    const conv = (db._stores.conversation as any[]).find((c) => c.id === r.conversationId);
    expect(conv.channelId).toBe(page.channel.id);
  });
});
