import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { FacebookApiError } from "@/modules/channels/facebook/types";
import { resolveSenderName } from "@/modules/channels/facebook/profile";
import { recoverOrphanedInboundMessages } from "@/modules/jobs/service";
import { generatePublicMediaUrl, uploadMedia, findProductMedia } from "@/modules/media/service";
import { processIncomingMessage } from "@/modules/conversations/service";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { resetEnvCache } from "@/core/env";

const WS_A = "ws-fx-a";
const WS_B = "ws-fx-b";

type Db = Prisma.TransactionClient;
let db: Db;

function fbSendClient(opts: { httpStatus?: number; error?: { message: string; code?: number; is_transient?: boolean }; messageId?: string } = {}) {
  return new FacebookClient({
    fetchImpl: (async () => {
      if (opts.error) {
        return Response.json({ error: opts.error }, { status: opts.httpStatus ?? 400 });
      }
      return Response.json({ recipient_id: "psid", message_id: opts.messageId ?? "mid-ok" }, { status: opts.httpStatus ?? 200 });
    }) as typeof fetch,
  });
}

describe("FACEBOOK outbound — transient vs permanent classification (forensic regression)", () => {
  beforeEach(() => {
    db = createFakeDb() as unknown as Db;
    setMockAIProvider(new MockAIProvider());
  });
  afterEach(() => {
    setMockAIProvider(undefined);
    setFacebookClientFactory(undefined as never);
    resetEnvCache();
  });

  it("HTTP 429 without Graph error body is TRANSIENT (was: PERMANENT → message abandoned)", async () => {
    const client = new FacebookClient({
      fetchImpl: (async () => new Response(null, { status: 429 })) as typeof fetch,
    });
    await expect(client.sendMessage("tok", "psid", { text: "hi" })).rejects.toMatchObject({ kind: "TRANSIENT" });
  });

  it("HTTP 408 and 425 are TRANSIENT", async () => {
    for (const status of [408, 425]) {
      const client = new FacebookClient({
        fetchImpl: (async () => new Response(null, { status })) as typeof fetch,
      });
      await expect(client.sendMessage("tok", "psid", { text: "hi" })).rejects.toMatchObject({ kind: "TRANSIENT" });
    }
  });

  it("Graph rate-limit codes 4/17/32/613 are TRANSIENT even when Meta marks is_transient:false", async () => {
    for (const code of [4, 17, 32, 613]) {
      const client = fbSendClient({ httpStatus: 400, error: { message: "rate limited", code, is_transient: false } });
      await expect(client.sendMessage("tok", "psid", { text: "hi" })).rejects.toMatchObject({ kind: "TRANSIENT" });
    }
  });

  it("genuine permanent errors stay PERMANENT (code 100/190, is_transient:false)", async () => {
    const c100 = fbSendClient({ httpStatus: 400, error: { message: "bad recipient", code: 100, is_transient: false } });
    await expect(c100.sendMessage("tok", "psid", { text: "hi" })).rejects.toMatchObject({ kind: "PERMANENT" });
    const c190 = fbSendClient({ httpStatus: 401, error: { message: "invalid token", code: 190 } });
    await expect(c190.sendMessage("tok", "psid", { text: "hi" })).rejects.toMatchObject({ kind: "PERMANENT" });
  });
});

describe("PROFILE — network failure retries quickly (15min), definitive Graph error throttles 24h", () => {
  beforeEach(() => {
    db = createFakeDb() as unknown as Db;
  });

  function failingNetworkClient(calls: string[]) {
    return new FacebookClient({
      fetchImpl: (async (url: string) => {
        calls.push(url as string);
        throw new Error("network down");
      }) as typeof fetch,
    });
  }

  it("network failure is retried after the short window — not hidden for 24h", async () => {
    await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", externalUserId: "psid-net",
      externalConversationId: "psid-net", externalMessageId: "m-net-1", externalEventId: "e-net-1",
      provider: "facebook", type: "TEXT", text: "hi",
    });
    const identity = (db._stores.channelIdentity as any[]).find((i: any) => i.channelExternalId === "psid-net");
    expect(identity).toBeTruthy();
    const calls: string[] = [];
    const failing = failingNetworkClient(calls);
    const first = await resolveSenderName(db as Db, { workspaceId: WS_A, psid: "psid-net", pageToken: "tok", client: failing });
    expect(first.name).toBeNull();
    expect(calls).toHaveLength(1);
    // Immediately after: throttled (short window not yet elapsed).
    const second = await resolveSenderName(db as Db, { workspaceId: WS_A, psid: "psid-net", pageToken: "tok", client: failing });
    expect(second.cached).toBe(true);
    // Simulate 16 minutes passing — retry happens (was previously 24h).
    identity.metadata.profileNetworkFailAt = new Date(Date.now() - 16 * 60_000).toISOString();
    const third = await resolveSenderName(db as Db, { workspaceId: WS_A, psid: "psid-net", pageToken: "tok", client: failing });
    expect(third.cached).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("real Graph name+avatar persist; empty Graph answer never overwrites existing values", async () => {
    await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", externalUserId: "psid-name",
      externalUserName: "أحمد", externalAvatarUrl: "https://fb.example/a.jpg",
      externalConversationId: "psid-name", externalMessageId: "m-name-1", externalEventId: "e-name-1",
      provider: "facebook", type: "TEXT", text: "hi",
    });
    const client = new FacebookClient({
      fetchImpl: (async () => Response.json({ id: "psid-name" })) as typeof fetch,
    });
    const out = await resolveSenderName(db as Db, { workspaceId: WS_A, psid: "psid-name", pageToken: "tok", client });
    expect(out.name).toBeNull();
    expect(out.avatarUrl).toBeNull();
    const identity = (db._stores.channelIdentity as any[]).find((i: any) => i.channelExternalId === "psid-name");
    expect(identity.displayName).toBe("أحمد");
    expect(identity.avatarUrl).toBe("https://fb.example/a.jpg");
  });
});

describe("ORPHAN sweep — age window is configurable, not hard-capped at 24h", () => {
  beforeEach(() => {
    db = createFakeDb() as unknown as Db;
    setMockAIProvider(new MockAIProvider());
  });
  afterEach(() => setMockAIProvider(undefined));

  it("a 48h-old orphan is recovered with the 72h default window", async () => {
    const old = new Date(Date.now() - 48 * 3600_000);
    const customer = await (db as any).customer.create({ data: { workspaceId: WS_A, status: "NEW_LEAD" } });
    const conv = await (db as any).conversation.create({
      data: { workspaceId: WS_A, customerId: customer.id, aiEnabled: true, aiState: "AI_ACTIVE", channelConversationId: "psid-old" },
    });
    await (db as any).message.create({
      data: {
        workspaceId: WS_A, conversationId: conv.id, senderType: "CUSTOMER", direction: "INBOUND",
        type: "TEXT", text: "مرحبا", createdAt: old,
      },
    });
    const out = await recoverOrphanedInboundMessages(db as never);
    expect(out.recovered).toBe(1);
  });

  it("a message beyond the configured window is NOT recovered (zombie protection intact)", async () => {
    const ancient = new Date(Date.now() - 200 * 3600_000);
    const customer = await (db as any).customer.create({ data: { workspaceId: WS_A, status: "NEW_LEAD" } });
    const conv = await (db as any).conversation.create({
      data: { workspaceId: WS_A, customerId: customer.id, aiEnabled: true, aiState: "AI_ACTIVE", channelConversationId: "psid-anc" },
    });
    await (db as any).message.create({
      data: {
        workspaceId: WS_A, conversationId: conv.id, senderType: "CUSTOMER", direction: "INBOUND",
        type: "TEXT", text: "مرحبا", createdAt: ancient,
      },
    });
    const out = await recoverOrphanedInboundMessages(db as never);
    expect(out.recovered).toBe(0);
  });
});

describe("MEDIA — public URL + product relation", () => {
  beforeEach(() => {
    db = createFakeDb() as unknown as Db;
  });

  it("valid Arabic-named image uploads and attaches to product", async () => {
    const product = await (db as any).product.create({
      data: { workspaceId: WS_A, name: "منتج تجريبي", price: 10, isActive: true },
    });
    const asset = await uploadMedia(db as Db, { userId: "u1", workspaceId: WS_A }, {
      filename: "صورة المنتج.jpg",
      mimeType: "image/jpeg",
      size: 4,
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      category: "PRODUCT",
      productId: product.id,
    });
    expect(asset.type).toBe("IMAGE");
    expect(asset.storageKey).toContain(WS_A);
    const media = await findProductMedia(db as Db, WS_A, product.id, 5);
    expect(media.some((m) => m.id === asset.id)).toBe(true);
  });

  it("signed public URL is workspace-bound and absolute", async () => {
    process.env.APP_URL = "https://app.example.com";
    resetEnvCache();
    try {
      const asset = await uploadMedia(db as Db, { userId: "u1", workspaceId: WS_A }, {
        filename: "img.png", mimeType: "image/png", size: 8,
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        category: "PRODUCT",
      });
      const url = await generatePublicMediaUrl(db as Db, WS_A, asset.id, 60);
      expect(url.startsWith("https://app.example.com/api/media/public/")).toBe(true);
    } finally {
      delete process.env.APP_URL;
      resetEnvCache();
    }
  });
});
