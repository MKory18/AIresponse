import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import {
  hideComment,
  normalizeFeedComments,
  replyToCommentPrivate,
  replyToCommentPublic,
} from "@/modules/channels/facebook/comments";
import {
  FacebookCommentsClient,
  setFacebookCommentsClientFactory,
} from "@/modules/channels/facebook/comments-client";
import {
  hideIgComment,
  replyToIgCommentPrivate,
  replyToIgCommentPublic,
} from "@/modules/channels/instagram/comments";
import {
  InstagramClient,
  setInstagramClientFactory,
} from "@/modules/channels/instagram/client";
import { connectChannel, disconnectChannel, listChannels } from "@/modules/channels/connect";
import { setTelegramClientFactory, TelegramClient } from "@/modules/channels/telegram/client";
import { setWhatsAppClientFactory, WhatsAppClient } from "@/modules/channels/whatsapp/client";

/**
 * P5 comments + connect — operator-driven moderation and account linking.
 * Provider APIs are stubbed; credentials are fixtures (never production).
 */
const WS = "ws-p5cc";
const AGENT = { userId: "agent-1", workspaceId: WS };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

async function seedPage(pageId = "page-1") {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "P", externalId: pageId },
  } as never)) as any;
  await db.channelAccount.create({
    data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: pageId, encryptedCredentials: encryptSecret("page-token") },
  } as never);
  return ch;
}

async function seedIg(igId = "ig-1") {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "INSTAGRAM", status: "CONNECTED", displayName: "IG", externalId: igId },
  } as never)) as any;
  await db.channelAccount.create({
    data: { channelId: ch.id, provider: "INSTAGRAM", externalAccountId: igId, encryptedCredentials: encryptSecret("ig-token") },
  } as never);
}

beforeEach(() => {
  db = createFakeDb();
  setFacebookCommentsClientFactory(null);
  setInstagramClientFactory(null);
  setTelegramClientFactory(null);
  setWhatsAppClientFactory(null);
});

describe("P5-A Facebook comments", () => {
  it("parses feed comment events, ignores likes/shares", () => {
    const comments = normalizeFeedComments({
      object: "page",
      entry: [{
        id: "page-1",
        changes: [
          { field: "feed", value: { item: "comment", comment_id: "c1", post_id: "p1", message: "بكم؟", from: { id: "u1", name: "A" }, created_time: 1720000000 } },
          { field: "feed", value: { item: "like", post_id: "p1" } },
          { field: "feed", value: { item: "reaction", post_id: "p1" } },
        ],
      }],
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ commentId: "c1", postId: "p1", text: "بكم؟", authorId: "u1" });
  });

  it("public reply + hide call the Graph edges (no secrets logged)", async () => {
    await seedPage();
    const calls: unknown[] = [];
    setFacebookCommentsClientFactory(
      () =>
        new FacebookCommentsClient({
          fetchImpl: (async (url: string, init?: { body?: string }) => {
            calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
            if (url.includes("/comments")) return Response.json({ id: "reply-1" });
            return Response.json({});
          }) as typeof fetch,
        })
    );
    expect(await replyToCommentPublic(db as Db, AGENT, { pageId: "page-1", objectId: "c1", text: "أهلا فيك" })).toEqual({ id: "reply-1" });
    expect(await hideComment(db as Db, AGENT, { pageId: "page-1", commentId: "c1", hidden: true })).toEqual({ ok: true });
    expect(JSON.stringify(calls)).not.toContain("page-token");
    const actions = (db._stores.auditLog as any[]).map((a) => a.action);
    expect(actions).toContain("comment.public_replied");
    expect(actions).toContain("comment.hidden");
  });

  it("private reply sends once (dedupe) and refuses stale comments", async () => {
    await seedPage();
    let posts = 0;
    setFacebookCommentsClientFactory(
      () =>
        new FacebookCommentsClient({
          fetchImpl: (async () => {
            posts += 1;
            return Response.json({ message_id: "priv-1" });
          }) as typeof fetch,
        })
    );
    const input = { pageId: "page-1", commentId: "c9", text: "تواصل معنا" };
    expect(await replyToCommentPrivate(db as Db, AGENT, input)).toEqual({ messageId: "priv-1" });
    await expect(replyToCommentPrivate(db as Db, AGENT, input)).rejects.toMatchObject({ code: "PRIVATE_REPLY_DUPLICATE" });
    expect(posts).toBe(1);
    await expect(
      replyToCommentPrivate(db as Db, AGENT, { ...input, commentId: "c-old", commentCreatedAt: "2020-01-01T00:00:00.000Z" })
    ).rejects.toMatchObject({ code: "PRIVATE_REPLY_EXPIRED" });
  });

  it("refuses unconnected pages without calling the provider", async () => {
    let calls = 0;
    setFacebookCommentsClientFactory(
      () =>
        new FacebookCommentsClient({
          fetchImpl: (async () => {
            calls += 1;
            return Response.json({});
          }) as typeof fetch,
        })
    );
    await expect(replyToCommentPublic(db as Db, AGENT, { pageId: "ghost", objectId: "c", text: "hi" })).rejects.toMatchObject({
      code: "PAGE_NOT_CONNECTED",
    });
    expect(calls).toBe(0);
  });
});

describe("P5-B Instagram comments", () => {
  it("public reply, hide and once-only private reply", async () => {
    await seedIg();
    const calls: unknown[] = [];
    setInstagramClientFactory(
      () =>
        new InstagramClient({
          fetchImpl: (async (url: string) => {
            calls.push(url);
            if (url.includes("/replies")) return Response.json({ id: "ig-r-1" });
            if (url.includes("/messages")) return Response.json({ message_id: "ig-p-1" });
            return Response.json({});
          }) as typeof fetch,
        })
    );
    expect(await replyToIgCommentPublic(db as Db, AGENT, { igId: "ig-1", commentId: "cc1", text: "hi" })).toEqual({ id: "ig-r-1" });
    expect(await hideIgComment(db as Db, AGENT, { igId: "ig-1", commentId: "cc1", hidden: true })).toEqual({ ok: true });
    const priv = { igId: "ig-1", pageId: "page-1", commentId: "cc1", text: "dm" };
    expect(await replyToIgCommentPrivate(db as Db, AGENT, priv)).toEqual({ messageId: "ig-p-1" });
    await expect(replyToIgCommentPrivate(db as Db, AGENT, priv)).rejects.toMatchObject({ code: "PRIVATE_REPLY_DUPLICATE" });
    expect(calls.length).toBe(3);
  });
});

describe("P5 connect/disconnect/list", () => {
  it("validates live before storing; token encrypted, never returned", async () => {
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async (url: string) => {
            if (url.includes("/getMe")) return Response.json({ ok: true, result: { id: 777, username: "shopbot" } });
            return Response.json({ ok: true, result: true });
          }) as typeof fetch,
        })
    );
    const res = await connectChannel(db as Db, AGENT, { type: "TELEGRAM", botToken: "123:ABC" });
    expect(res.type).toBe("TELEGRAM");
    expect(res.status).toBe("CONNECTED");
    const rows = db._stores.channelAccount as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].encryptedCredentials).not.toContain("123:ABC");
    expect(JSON.stringify(res)).not.toContain("123:ABC");
    expect((rows[0].metadata as { tgWebhookSecret?: string }).tgWebhookSecret).toBeTruthy();
  });

  it("rejects bad tokens without storing anything", async () => {
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async () => Response.json({ ok: false, error_code: 401, description: "Unauthorized" })) as typeof fetch,
        })
    );
    await expect(connectChannel(db as Db, AGENT, { type: "TELEGRAM", botToken: "bad" })).rejects.toThrow();
    expect((db._stores.channel as any[])).toHaveLength(0);
    expect((db._stores.channelAccount as any[])).toHaveLength(0);
  });

  it("refuses account reuse across workspaces (ownership proof)", async () => {
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async (url: string) => {
            if (url.includes("/getMe")) return Response.json({ ok: true, result: { id: 888, username: "shared" } });
            return Response.json({ ok: true, result: true });
          }) as typeof fetch,
        })
    );
    await connectChannel(db as Db, AGENT, { type: "TELEGRAM", botToken: "tok-1" });
    await expect(
      connectChannel(db as Db, { userId: "u2", workspaceId: "ws-other" }, { type: "TELEGRAM", botToken: "tok-2" })
    ).rejects.toMatchObject({ code: "ACCOUNT_CONFLICT" });
  });

  it("TikTok/Facebook connect refuse with explicit reasons (no fake linking)", async () => {
    await expect(connectChannel(db as Db, AGENT, { type: "TIKTOK" })).rejects.toMatchObject({ code: "CHANNEL_NOT_SUPPORTED" });
    await expect(connectChannel(db as Db, AGENT, { type: "FACEBOOK" })).rejects.toMatchObject({ code: "CHANNEL_NOT_SUPPORTED" });
    expect((db._stores.channel as any[])).toHaveLength(0);
  });

  it("disconnect flips status (sends stop) and lists secret-free overview", async () => {
    const TOKEN = "tg-token-SECRET-xyz-123";
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async (url: string) => {
            if (url.includes("/getMe")) return Response.json({ ok: true, result: { id: 999, username: "b" } });
            return Response.json({ ok: true, result: true });
          }) as typeof fetch,
        })
    );
    await connectChannel(db as Db, AGENT, { type: "TELEGRAM", botToken: TOKEN });
    const before = await listChannels(db as Db, WS);
    expect(before[0]).toMatchObject({ status: "CONNECTED", hasAccount: true });
    expect(JSON.stringify(before)).not.toContain(TOKEN);
    expect(await disconnectChannel(db as Db, AGENT, { type: "TELEGRAM" })).toEqual({ disconnected: 1 });
    const after = await listChannels(db as Db, WS);
    expect(after[0].status).toBe("DISCONNECTED");
  });

  it("WhatsApp connect validates the number id", async () => {
    setWhatsAppClientFactory(
      () =>
        new WhatsAppClient({
          fetchImpl: (async () => Response.json({ id: "num-5", display_phone_number: "15550005" })) as typeof fetch,
        })
    );
    const res = await connectChannel(db as Db, AGENT, { type: "WHATSAPP", phoneNumberId: "num-5", token: "wa-token-123" });
    expect(res).toMatchObject({ type: "WHATSAPP", status: "CONNECTED" });
    expect(JSON.stringify(res)).not.toContain("wa-token-123");
  });
});
