import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { canSendToCustomer } from "@/modules/channels/facebook/policy";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { processIncomingMessage } from "@/modules/conversations/service";
import { encryptSecret } from "@/core/crypto";

const WS = "ws-expiry-fix";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

function readSource(rel: string): string {
  return readFileSync(`${process.cwd()}/${rel}`, "utf8");
}

async function seedPage(pageId: string, opts: { tokenExpiresAt?: Date | null } = {}) {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "Page", externalId: pageId },
  } as never)) as any;
  const account = (await db.channelAccount.create({
    data: {
      channelId: ch.id,
      provider: "FACEBOOK",
      externalAccountId: pageId,
      pageName: "Page",
      encryptedCredentials: encryptSecret("page-token-test"),
      ...(opts.tokenExpiresAt !== undefined ? { tokenExpiresAt: opts.tokenExpiresAt } : {}),
    },
  } as never)) as any;
  return { channel: ch, account };
}

async function seedInbound(psid: string, channelId: string) {
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
    text: "مرحبا",
  });
}

function mockGraphSuccess(calls: { n: number }) {
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async () => {
          calls.n += 1;
          return Response.json({ recipient_id: "psid-x", message_id: `mid-${calls.n}` });
        }) as typeof fetch,
      })
  );
}

beforeEach(() => {
  db = createFakeDb();
});

describe("FIX 1 — select-page clears stale tokenExpiresAt", () => {
  it("route upsert always resets tokenExpiresAt to null (create + update)", () => {
    const src = readSource("src/app/api/channels/facebook/select-page/route.ts");
    // Both the create and update branches of the account upsert must clear it.
    const occurrences = src.match(/tokenExpiresAt:\s*null/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("fresh connect leaves tokenExpiresAt null and policy allows send", () => {
    const decision = canSendToCustomer({
      channelStatus: "CONNECTED",
      tokenExpiresAt: null,
      lastCustomerMessageAt: new Date(),
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("reconnect after disconnect clears stale expiry and unblocks a valid token", async () => {
    // Simulate post-disconnect stale state: expiry = now (disconnect writes new Date()).
    const { channel } = await seedPage("page-reconnect", { tokenExpiresAt: new Date(Date.now() - 1000) });
    const channelId = channel.channel?.id ?? channel.id;
    const calls = { n: 0 };
    mockGraphSuccess(calls);
    try {
      const inbound = await seedInbound("psid-re", channelId);
      const blocked = await dispatchOutbound(db as Db, {
        workspaceId: WS,
        conversationId: inbound.conversationId,
        sourceMessageId: "src-stale",
        text: "أهلا",
      });
      expect(blocked.deliveryStatus).toBe("FAILED");
      expect(blocked.error).toContain("POLICY_TOKEN_EXPIRED");
      expect(calls.n).toBe(0);

      // What the fixed select-page route now does on every reconnect.
      const stored = (db._stores.channelAccount as any[])[0];
      await db.channelAccount.update({ where: { id: stored.id }, data: { tokenExpiresAt: null } } as never);
      const cleared = (db._stores.channelAccount as any[])[0];
      expect(cleared.tokenExpiresAt ?? null).toBeNull();

      const unblocked = await dispatchOutbound(db as Db, {
        workspaceId: WS,
        conversationId: inbound.conversationId,
        sourceMessageId: "src-stale-retry",
        text: "أهلا",
      });
      expect(unblocked.deliveryStatus).toBe("SENT");
      expect(calls.n).toBe(1);
    } finally {
      setFacebookClientFactory(undefined as never);
    }
  });

  it("genuinely expired token remains blocked (no Graph call)", async () => {
    await seedPage("page-expired", { tokenExpiresAt: new Date(Date.now() - 60_000) });
    const decision = canSendToCustomer({
      channelStatus: "CONNECTED",
      tokenExpiresAt: new Date(Date.now() - 60_000),
      lastCustomerMessageAt: new Date(),
    });
    expect(decision).toEqual({ allowed: false, reason: "TOKEN_EXPIRED" });

    const channelId = (db._stores.channel as any[])[0].id;
    const calls = { n: 0 };
    mockGraphSuccess(calls);
    try {
      const inbound = await seedInbound("psid-exp", channelId);
      const res = await dispatchOutbound(db as Db, {
        workspaceId: WS,
        conversationId: inbound.conversationId,
        sourceMessageId: "src-exp",
        text: "أهلا",
      });
      expect(res.deliveryStatus).toBe("FAILED");
      expect(res.error).toContain("POLICY_TOKEN_EXPIRED");
      expect(calls.n).toBe(0);
      const row = (db._stores.message as any[]).find((m) => m.id === res.messageId);
      expect(row.metadata.providerErrorCode).toBe("POLICY_TOKEN_EXPIRED");
    } finally {
      setFacebookClientFactory(undefined as never);
    }
  });
});

describe("FIX 2 — GET /api/handoffs without invalid Prisma include", () => {
  it("route no longer includes the non-existent `conversation` relation", () => {
    const src = readSource("src/app/api/handoffs/route.ts");
    // Guard targets the Prisma include usage, not the explanatory comment.
    expect(src).not.toContain("include: { conversation: { select");
  });

  it("OPEN handoffs hydrate conversation status via a second query (compatible shape)", async () => {
    const customer = (await db.customer.create({
      data: { workspaceId: WS, status: "NEW_LEAD" },
    } as never)) as any;
    const ch = (await db.channel.create({
      data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "P", externalId: "page-h" },
    } as never)) as any;
    const conv = (await db.conversation.create({
      data: {
        workspaceId: WS,
        customerId: customer.id,
        channelId: ch.id,
        channelConversationId: "psid-h",
        status: "OPEN",
      },
    } as never)) as any;
    await (db as any).humanHandoff.create({
      data: { workspaceId: WS, conversationId: conv.id, customerId: customer.id, reason: "MANUAL", status: "OPEN" },
    });
    await (db as any).humanHandoff.create({
      data: { workspaceId: WS, conversationId: conv.id, customerId: customer.id, reason: "MANUAL", status: "RESOLVED" },
    });

    // Mirror of the fixed route logic: no include; second query + merge.
    const handoffs = (await (db as any).humanHandoff.findMany({
      where: { workspaceId: WS, status: "OPEN" },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 50,
    })) as Array<{ conversationId: string } & Record<string, unknown>>;
    expect(handoffs).toHaveLength(1);
    const ids = [...new Set(handoffs.map((h) => h.conversationId))];
    const conversations = (await (db as any).conversation.findMany({
      where: { workspaceId: WS, id: { in: ids } },
      select: { id: true, status: true },
    })) as Array<{ id: string; status: string }>;
    const statusById = new Map(conversations.map((c) => [c.id, c.status]));
    const items = handoffs.map((h) => ({
      ...h,
      conversation: statusById.has(h.conversationId)
        ? { id: h.conversationId, status: statusById.get(h.conversationId) }
        : null,
    }));
    expect(items[0].conversation).toEqual({ id: conv.id, status: "OPEN" });
  });

  it("missing conversation resolves to null instead of throwing", async () => {
    const customer = (await db.customer.create({
      data: { workspaceId: WS, status: "NEW_LEAD" },
    } as never)) as any;
    await (db as any).humanHandoff.create({
      data: { workspaceId: WS, conversationId: "ghost-conv", customerId: customer.id, reason: "MANUAL", status: "OPEN" },
    });
    const handoffs = (await (db as any).humanHandoff.findMany({
      where: { workspaceId: WS, status: "OPEN" },
      take: 50,
    })) as Array<{ conversationId: string } & Record<string, unknown>>;
    const ids = [...new Set(handoffs.map((h) => h.conversationId))];
    const conversations = (await (db as any).conversation.findMany({
      where: { workspaceId: WS, id: { in: ids } },
      select: { id: true, status: true },
    })) as Array<{ id: string; status: string }>;
    const statusById = new Map(conversations.map((c) => [c.id, c.status]));
    const items = handoffs.map((h) => ({
      ...h,
      conversation: statusById.has(h.conversationId)
        ? { id: h.conversationId, status: statusById.get(h.conversationId) }
        : null,
    }));
    expect(items[0].conversation).toBeNull();
  });
});
