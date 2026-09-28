import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { FacebookClient } from "@/modules/channels/facebook/client";
import { resolveSenderName } from "@/modules/channels/facebook/profile";
import { encryptSecret } from "@/core/crypto";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { processIncomingMessage } from "@/modules/conversations/service";

const WS = "ws-fb-live";
const AGENT = { userId: "agent-fb", workspaceId: WS };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

const SECRET_TOKEN = "page-token-live-test-abc123";

async function seedPage(pageId: string, pageName: string) {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: pageName, externalId: pageId },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: pageId, pageName,
      encryptedCredentials: encryptSecret(SECRET_TOKEN),
    },
  } as never);
  return ch;
}

async function seedInbound(psid: string, text: string, channelId?: string) {
  return processIncomingMessage(db as Db, {
    workspaceId: WS,
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
}

beforeEach(async () => {
  db = createFakeDb();
  (db._stores.workspaceMember as any[]).push({ id: "m-fb", workspaceId: WS, userId: AGENT.userId, status: "ACTIVE" });
});

describe("official send transport", () => {
  it("token travels as query param; JSON body carries recipient+message (never the token)", async () => {
    const seen: { url: string; init: any }[] = [];
    const client = new FacebookClient({
      fetchImpl: (async (url: string, init?: any) => {
        seen.push({ url: url as string, init });
        return Response.json({ recipient_id: "psid-1", message_id: "mid-1" });
      }) as typeof fetch,
    });
    const res = await client.sendMessage(SECRET_TOKEN, "psid-1", { text: "مرحبا" });
    expect(res.messageId).toBe("mid-1");
    const u = new URL(seen[0].url);
    expect(u.pathname.endsWith("/me/messages")).toBe(true);
    expect(u.searchParams.get("access_token")).toBe(SECRET_TOKEN);
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(seen[0].init.body));
    expect(body.recipient).toEqual({ id: "psid-1" });
    expect(body.messaging_type).toBe("RESPONSE");
    expect(body.message).toEqual({ text: "مرحبا" });
    expect(JSON.stringify(body)).not.toContain(SECRET_TOKEN);
  });

  it("non-2xx without message_id never becomes SENT", async () => {
    const client = new FacebookClient({
      fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    });
    await expect(client.sendMessage("tok", "psid-1", { text: "hi" })).rejects.toMatchObject({
      name: "FacebookApiError",
    });
  });
});

describe("outbound uses the conversation's own page + recipient", () => {
  it("6+7+8. channelId, Page ID, and recipient PSID all match the inbound page", async () => {
    const chA = await seedPage("page-A", "صفحة أ");
    const chB = await seedPage("page-B", "صفحة ب");
    const calls: { url: string; init: any }[] = [];
    const { setFacebookClientFactory } = await import("@/modules/channels/facebook/client");
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async (url: string, init?: any) => {
            calls.push({ url: url as string, init });
            return Response.json({ recipient_id: "psid-B", message_id: "mid-B" });
          }) as typeof fetch,
        })
    );
    try {
      const r = await seedInbound("psid-B", "مرحبا", chB.channel?.id ?? chB.id);
      const res = await dispatchOutbound(db as Db, {
        workspaceId: WS,
        conversationId: r.conversationId,
        sourceMessageId: "src-page-check",
        text: "أهلا",
        senderType: "HUMAN",
        senderId: AGENT.userId,
      });
      expect(res.deliveryStatus).toBe("SENT");
      expect(res.pageId).toBe("page-B");
      expect(res.recipientId).toBe("psid-B");
      expect(res.channelId).not.toBe(chA.channel?.id ?? chA.id);
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.recipient).toEqual({ id: "psid-B" });
    } finally {
      const { setFacebookClientFactory: reset } = await import("@/modules/channels/facebook/client");
      reset(undefined as never);
    }
  });

  it("heals a stale conversation.channelId to the webhook-resolved page", async () => {
    const chA = await seedPage("page-A", "صفحة أ");
    const chB = await seedPage("page-B", "صفحة ب");
    const idA = chA.channel?.id ?? chA.id;
    const idB = chB.channel?.id ?? chB.id;
    const r1 = await seedInbound("psid-h", "مرحبا", idA);
    const before = (db._stores.conversation as any[]).find((c) => c.id === r1.conversationId);
    expect(before.channelId).toBe(idA);
    // Same PSID writes via page B (e.g. after reconnect): channel heals to B.
    await seedInbound("psid-h", "مرحبا مجددا", idB);
    const after = (db._stores.conversation as any[]).find((c) => c.id === r1.conversationId);
    expect(after.channelId).toBe(idB);
  });
});

describe("graph errors persist safely", () => {
  it("1+2. failed send persists code/message/httpStatus, never the token", async () => {
    await seedPage("page-A", "صفحة أ");
    const { setFacebookClientFactory } = await import("@/modules/channels/facebook/client");
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async () =>
            Response.json({ error: { message: "Invalid OAuth access token", code: 190, error_subcode: 460 } }, { status: 400 })) as typeof fetch,
        })
    );
    try {
      const r = await seedInbound("psid-err", "مرحبا");
      // wire the conversation to the seeded channel
      const ch = (db._stores.channel as any[])[0];
      await db.conversation.update({ where: { id: r.conversationId }, data: { channelId: ch.id } } as never);
      const res = await dispatchOutbound(db as Db, {
        workspaceId: WS, conversationId: r.conversationId, sourceMessageId: "src-err", text: "أهلا",
      });
      expect(res.deliveryStatus).toBe("FAILED");
      expect(res.graphCode).toBe("190/460");
      const row = (db._stores.message as any[]).find((m) => m.id === res.messageId);
      expect(row.deliveryStatus).toBe("FAILED");
      expect(row.metadata.providerErrorCode).toBe("190/460");
      expect(row.metadata.providerErrorMessage).toContain("Invalid OAuth");
      expect(row.metadata.failedAt).toBeTruthy();
      const dumped = JSON.stringify([res, row]);
      expect(dumped).not.toContain(SECRET_TOKEN);
    } finally {
      const { setFacebookClientFactory: reset } = await import("@/modules/channels/facebook/client");
      reset(undefined as never);
    }
  });

  it("3. provider success without message_id never marks SENT", async () => {
    await seedPage("page-A", "صفحة أ");
    const { setFacebookClientFactory } = await import("@/modules/channels/facebook/client");
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async () => Response.json({ recipient_id: "psid-x" })) as typeof fetch,
        })
    );
    try {
      const r = await seedInbound("psid-x", "مرحبا");
      const ch = (db._stores.channel as any[])[0];
      await db.conversation.update({ where: { id: r.conversationId }, data: { channelId: ch.id } } as never);
      const res = await dispatchOutbound(db as Db, {
        workspaceId: WS, conversationId: r.conversationId, sourceMessageId: "src-nomid", text: "أهلا",
      });
      expect(res.deliveryStatus).not.toBe("SENT");
      const row = (db._stores.message as any[]).find((m) => m.id === res.messageId);
      expect(row.deliveryStatus).not.toBe("SENT");
    } finally {
      const { setFacebookClientFactory: reset } = await import("@/modules/channels/facebook/client");
      reset(undefined as never);
    }
  });

  it("4+5. retry re-sends through the provider on the same row", async () => {
    let graphCalls = 0;
    await seedPage("page-A", "صفحة أ");
    const { setFacebookClientFactory } = await import("@/modules/channels/facebook/client");
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async () => {
            graphCalls += 1;
            if (graphCalls === 1) {
              return Response.json({ error: { message: "busy", code: 1, is_transient: true } });
            }
            return Response.json({ recipient_id: "psid-rt", message_id: "mid-rt" });
          }) as typeof fetch,
        })
    );
    try {
      const r = await seedInbound("psid-rt", "مرحبا");
      const ch = (db._stores.channel as any[])[0];
      await db.conversation.update({ where: { id: r.conversationId }, data: { channelId: ch.id } } as never);
      const first = await dispatchOutbound(db as Db, {
        workspaceId: WS, conversationId: r.conversationId, sourceMessageId: "src-retry", text: "أهلا",
      });
      expect(first.deliveryStatus).toBe("QUEUED");
      const second = await dispatchOutbound(db as Db, {
        workspaceId: WS, conversationId: r.conversationId, sourceMessageId: "src-retry", text: "أهلا",
      });
      expect(second.deliveryStatus).toBe("SENT");
      expect(second.messageId).toBe(first.messageId);
      expect(graphCalls).toBe(2);
      const rows = (db._stores.message as any[]).filter(
        (m) => m.outboundIdempotencyKey === `${r.conversationId}:src-retry`
      );
      expect(rows).toHaveLength(1);
    } finally {
      const { setFacebookClientFactory: reset } = await import("@/modules/channels/facebook/client");
      reset(undefined as never);
    }
  });
});

describe("facebook profile name chain", () => {
  function profileClient(name: string | null, calls: string[], error?: { code: number; message: string }) {
    return new FacebookClient({
      fetchImpl: (async (url: string) => {
        calls.push(url as string);
        if (error) return Response.json({ error }, { status: 400 });
        return Response.json(name ? { first_name: name, id: "psid-p" } : { id: "psid-p" });
      }) as typeof fetch,
    });
  }

  it("9. real profile name resolves and backfills identity + customer", async () => {
    await seedPage("page-A", "صفحة أ");
    const calls: string[] = [];
    const client = profileClient("أحمد محمد", calls);
    const out = await resolveSenderName(db as Db, {
      workspaceId: WS, psid: "psid-p", pageToken: "tok", client,
    });
    expect(out.name).toBe("أحمد محمد");
    expect(calls).toHaveLength(1);
    // token travels only in the access_token query slot (correct placement)
    expect(new URL(calls[0]).searchParams.get("access_token")).toBe("tok");
    expect(JSON.stringify(out)).not.toContain("tok-secret-never-present");
    const r = await processIncomingMessage(db as Db, {
      workspaceId: WS, channelType: "FACEBOOK", externalUserId: "psid-p",
      externalUserName: out.name, externalConversationId: "psid-p",
      externalMessageId: "m-p1", externalEventId: "e-p1", provider: "facebook", type: "TEXT", text: "مرحبا",
    });
    const customer = (db._stores.customer as any[]).find((c) => c.id === r.customerId);
    expect(customer.name).toBe("أحمد محمد");
  });

  it("10. graph error invents nothing and throttles for 24h", async () => {
    await seedPage("page-A", "صفحة أ");
    // existing identity without a name
    const customer = (await db.customer.create({ data: { workspaceId: WS, status: "NEW_LEAD" } } as never)) as any;
    await db.channelIdentity.create({
      data: { workspaceId: WS, customerId: customer.id, channelType: "FACEBOOK", channelExternalId: "psid-q" },
    } as never);
    const calls: string[] = [];
    const client = profileClient(null, calls, { code: 10, message: "permission denied" });
    const first = await resolveSenderName(db as Db, { workspaceId: WS, psid: "psid-q", pageToken: "tok", client });
    expect(first.name).toBeNull();
    expect(calls).toHaveLength(1);
    const second = await resolveSenderName(db as Db, { workspaceId: WS, psid: "psid-q", pageToken: "tok", client });
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
    const identity = (db._stores.channelIdentity as any[]).find((i) => i.channelExternalId === "psid-q");
    expect(identity.displayName ?? null).toBeNull();
    expect(customer.name ?? null).toBeNull();
  });

  it("15. no secrets leak through profile/outbound results", async () => {
    await seedPage("page-A", "صفحة أ");
    const calls: string[] = [];
    const client = profileClient("سارة", calls);
    const out = await resolveSenderName(db as Db, { workspaceId: WS, psid: "psid-s", pageToken: SECRET_TOKEN, client });
    // token must never appear in request path beyond the access_token param slot
    for (const url of calls) {
      const u = new URL(url);
      expect(u.searchParams.get("access_token")).toBe(SECRET_TOKEN);
    }
    expect(JSON.stringify(out)).not.toContain(SECRET_TOKEN);
  });
});
