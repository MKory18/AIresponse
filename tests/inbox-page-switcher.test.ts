/**
 * INBOX PAGE SWITCHER — server-side page filter + pages list.
 *
 * Pins: exact channelId filtering (no client-side hiding), workspace
 * isolation, foreign/missing channel rejection, search+filter+pagination
 * composition, unread totals, and the URL-param sanitizer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { listConversations, listConversationPages } from "@/modules/conversations/service";
import { sanitizeSelectedChannelId } from "@/components/inbox/page-switcher";
import { NotFoundError } from "@/core/errors";

const WS_A = "ws-inbox-a";
const WS_B = "ws-inbox-b";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

async function seedChannel(ws: string, name: string, type = "FACEBOOK") {
  return (await db.channel.create({
    data: { workspaceId: ws, type, status: "CONNECTED", displayName: name, externalId: `ext-${name}` },
  } as never)) as any;
}

async function seedConv(ws: string, channelId: string, psid: string, text: string, unread = 1, customerName?: string) {
  const customer = (await db.customer.create({
    data: { workspaceId: ws, name: customerName ?? `cust-${psid}`, channelCustomerId: psid },
  } as never)) as any;
  const conv = (await db.conversation.create({
    data: {
      workspaceId: ws, channelId, customerId: customer.id, channelConversationId: psid,
      status: "OPEN", unreadCount: unread, lastCustomerMessageAt: new Date(),
    },
  } as never)) as any;
  await db.message.create({
    data: { workspaceId: ws, conversationId: conv.id, senderType: "CUSTOMER", direction: "INBOUND", type: "TEXT", text, provider: "facebook" },
  } as never);
  return conv;
}

beforeEach(() => { db = createFakeDb(); });

describe("inbox page switcher — channelId filter", () => {
  it("returns only the selected page conversations", async () => {
    const pageA = await seedChannel(WS_A, "page-a");
    const pageB = await seedChannel(WS_A, "page-b");
    await seedConv(WS_A, pageA.id, "psid-a1", "أهلا من أ");
    await seedConv(WS_A, pageB.id, "psid-b1", "أهلا من ب");
    const res = await listConversations(db as Db, { workspaceId: WS_A, channelId: pageA.id });
    expect(res.items).toHaveLength(1);
    expect((res.items[0] as any).channelId ?? (res.items[0] as any).channel?.id).toBeTruthy();
    const texts = (db._stores.message as any[])
      .filter((m) => res.items.some((c) => c.id === m.conversationId))
      .map((m) => m.text);
    expect(texts).toEqual(["أهلا من أ"]);
  });

  it("page A selection never shows page B threads", async () => {
    const pageA = await seedChannel(WS_A, "page-a");
    const pageB = await seedChannel(WS_A, "page-b");
    await seedConv(WS_A, pageA.id, "psid-a1", "x");
    await seedConv(WS_A, pageB.id, "psid-b1", "y");
    await seedConv(WS_A, pageB.id, "psid-b2", "z");
    const res = await listConversations(db as Db, { workspaceId: WS_A, channelId: pageA.id, limit: 50 });
    expect(res.items).toHaveLength(1);
  });

  it("rejects a channel from another workspace (no leak)", async () => {
    const foreign = await seedChannel(WS_B, "foreign");
    await seedConv(WS_B, foreign.id, "psid-x", "secret");
    await expect(listConversations(db as Db, { workspaceId: WS_A, channelId: foreign.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a missing channel id", async () => {
    await expect(listConversations(db as Db, { workspaceId: WS_A, channelId: "no-such-channel" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("search composes with the page filter", async () => {
    const pageA = await seedChannel(WS_A, "page-a");
    const pageB = await seedChannel(WS_A, "page-b");
    // Customer-name match (the messages.some clause needs a real Postgres
    // relation join; the in-memory double only supports scalar matches).
    await seedConv(WS_A, pageA.id, "psid-a1", "مرحبا", 1, "زبون السعر المميز");
    await seedConv(WS_A, pageB.id, "psid-b1", "مرحبا", 1, "زبون السعر المميز");
    const res = await listConversations(db as Db, { workspaceId: WS_A, channelId: pageA.id, q: "السعر" });
    expect(res.items).toHaveLength(1);
  });

  it("pagination cursors respect the page filter", async () => {
    const pageA = await seedChannel(WS_A, "page-a");
    const pageB = await seedChannel(WS_A, "page-b");
    for (let i = 0; i < 3; i++) await seedConv(WS_A, pageA.id, `psid-a${i}`, `a${i}`);
    for (let i = 0; i < 2; i++) await seedConv(WS_A, pageB.id, `psid-b${i}`, `b${i}`);
    const first = await listConversations(db as Db, { workspaceId: WS_A, channelId: pageA.id, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await listConversations(db as Db, { workspaceId: WS_A, channelId: pageA.id, limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
  });
});

describe("inbox page switcher — pages list", () => {
  it("lists workspace channels with unread totals", async () => {
    const pageA = await seedChannel(WS_A, "page-a");
    const pageB = await seedChannel(WS_A, "page-b");
    await seedConv(WS_A, pageA.id, "psid-a1", "x", 3);
    await seedConv(WS_A, pageA.id, "psid-a2", "y", 2);
    await seedConv(WS_A, pageB.id, "psid-b1", "z", 0);
    const pages = await listConversationPages(db as Db, WS_A);
    expect(pages).toHaveLength(2);
    expect(pages.find((p) => p.id === pageA.id)?.unreadCount).toBe(5);
    expect(pages.find((p) => p.id === pageB.id)?.unreadCount).toBe(0);
    expect(pages[0].displayName).toBe("page-a");
    expect(pages[0].status).toBe("CONNECTED");
  });

  it("excludes other workspaces and returns [] when empty", async () => {
    await seedChannel(WS_B, "foreign");
    expect(await listConversationPages(db as Db, WS_A)).toEqual([]);
    const pageA = await seedChannel(WS_A, "mine");
    const pages = await listConversationPages(db as Db, WS_A);
    expect(pages).toHaveLength(1);
    expect(pages[0].id).toBe(pageA.id);
  });
});

describe("inbox page switcher — selection sanitizer", () => {
  const rows = [{ id: "c1" }, { id: "c2" }] as any;
  it("keeps server-known ids, drops crafted/empty ones", () => {
    expect(sanitizeSelectedChannelId("c1", rows)).toBe("c1");
    expect(sanitizeSelectedChannelId("evil", rows)).toBe("");
    expect(sanitizeSelectedChannelId("", rows)).toBe("");
  });
});
