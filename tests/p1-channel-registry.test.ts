import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import {
  ChannelNotSupportedError,
  getChannelAdapter,
  setChannelAdapterFactory,
} from "@/modules/channels/registry";
import { FacebookChannelAdapter } from "@/modules/channels/facebook/adapter";
import { MockChannelAdapter } from "@/modules/channels/mock-adapter";
import { normalizeFacebookWebhook, deriveEventId } from "@/modules/channels/facebook/normalizer";
import { ingestMetaWebhook } from "@/modules/channels/facebook/webhook";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";

const PAGE_ID = "page-1";

function metaPayload() {
  return {
    object: "page",
    entry: [
      {
        id: PAGE_ID,
        time: 1720000000000,
        messaging: [
          {
            sender: { id: "psid-1" },
            recipient: { id: PAGE_ID },
            timestamp: 1720000000000,
            message: { mid: "mid.1", text: "بكم؟" },
          },
          {
            sender: { id: "psid-1" },
            recipient: { id: PAGE_ID },
            timestamp: 1720000001000,
            message: {
              mid: "mid.2",
              text: "شوف الصورة",
              attachments: [{ type: "image", payload: { url: "https://cdn.example/i.jpg" } }],
            },
          },
          // Echoes never enter the pipeline.
          {
            sender: { id: PAGE_ID },
            recipient: { id: "psid-1" },
            timestamp: 1720000002000,
            message: { mid: "mid.3", text: "ردنا", is_echo: true },
          },
        ],
      },
    ],
  };
}

function senderStub() {
  const calls: Array<{ to: string; payload: unknown }> = [];
  const sender = async (to: string, payload: unknown) => {
    calls.push({ to, payload });
    return { messageId: `mid-sent-${calls.length}` };
  };
  return { calls, sender };
}

beforeEach(() => {
  setChannelAdapterFactory("FACEBOOK", null);
});

describe("P1 channel registry — real adapters, no silent mock", () => {
  it("FACEBOOK resolves the production adapter (not a mock)", () => {
    const { sender } = senderStub();
    const adapter = getChannelAdapter("FACEBOOK", {
      facebook: { pageId: PAGE_ID, channelAccountId: "acc-1", sender },
    });
    expect(adapter).toBeInstanceOf(FacebookChannelAdapter);
    expect(adapter.provider).toBe("facebook");
  });

  it("FACEBOOK without a page binding refuses instead of mocking", () => {
    expect(() => getChannelAdapter("FACEBOOK")).toThrowError(ChannelNotSupportedError);
  });

  it("unregistered channels (WHATSAPP/TELEGRAM/INSTAGRAM) throw, never mock", () => {
    for (const t of ["WHATSAPP", "TELEGRAM", "INSTAGRAM", "WEB"] as const) {
      expect(() => getChannelAdapter(t)).toThrowError(ChannelNotSupportedError);
    }
  });

  it("mock is available ONLY via explicit opt-in (tests/dev)", () => {
    const adapter = getChannelAdapter("WHATSAPP", { mock: true });
    expect(adapter).toBeInstanceOf(MockChannelAdapter);
    expect(adapter.provider).toBe("mock");
  });
});

describe("P1 FacebookChannelAdapter — protocol mapping over existing modules", () => {
  it("normalizes a Meta batch: 2 inbound, echo dropped, per-mid identity", () => {
    const { sender } = senderStub();
    const adapter = new FacebookChannelAdapter({ pageId: PAGE_ID, channelAccountId: "acc-1", sender });
    const msgs = adapter.receiveMessage(metaPayload());
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({
      channelType: "FACEBOOK",
      externalUserId: "psid-1",
      externalMessageId: "mid.1",
      provider: "facebook",
      type: "TEXT",
      text: "بكم؟",
    });
    expect(msgs[1].type).toBe("IMAGE");
    expect(msgs[1].mediaUrl).toBe("https://cdn.example/i.jpg");
    // Distinct messages stay distinct (no shared batch key).
    expect(msgs[0].externalEventId).not.toBe(msgs[1].externalEventId);
  });

  it("ignores entries for other pages", () => {
    const { sender } = senderStub();
    const adapter = new FacebookChannelAdapter({ pageId: "other-page", channelAccountId: "acc-1", sender });
    expect(adapter.receiveMessage(metaPayload())).toHaveLength(0);
  });

  it("sends text/media through the bound page-token owner", async () => {
    const { calls, sender } = senderStub();
    const adapter = new FacebookChannelAdapter({ pageId: PAGE_ID, channelAccountId: "acc-1", sender });
    const t = await adapter.sendText("psid-1", "أهلاً");
    expect(t).toMatchObject({ externalMessageId: "mid-sent-1", provider: "facebook" });
    const m = await adapter.sendMedia("psid-1", { type: "IMAGE", mediaUrl: "https://cdn.example/i.jpg" });
    expect(m.externalMessageId).toBe("mid-sent-2");
    expect(calls[0]).toMatchObject({ to: "psid-1" });
    expect(calls[1].payload).toMatchObject({ attachment: { type: "image", url: "https://cdn.example/i.jpg" } });
  });

  it("constructor refuses bindings without an account (fail-closed)", () => {
    const { sender } = senderStub();
    expect(() => new FacebookChannelAdapter({ pageId: PAGE_ID, channelAccountId: "", sender })).toThrowError(ChannelNotSupportedError);
  });

  it("receive-only bindings (no sender) normalize but refuse sends", async () => {
    const adapter = new FacebookChannelAdapter({ pageId: PAGE_ID, channelAccountId: "acc-1" });
    expect(adapter.receiveMessage(metaPayload())).toHaveLength(2);
    await expect(adapter.sendText("psid-1", "hi")).rejects.toThrowError(ChannelNotSupportedError);
  });

  it("receive without a page binding refuses (entry filter needs the page)", () => {
    const { sender } = senderStub();
    const adapter = new FacebookChannelAdapter({ channelAccountId: "acc-1", sender });
    expect(() => adapter.receiveMessage(metaPayload())).toThrowError(ChannelNotSupportedError);
  });
});

describe("P1.1 live flows route through the registry (no real sends)", () => {
  const WS = "ws-p11-chan";
  type Db = Prisma.TransactionClient;
  let db: ReturnType<typeof createFakeDb>;

  async function seedChannel() {
    db = createFakeDb();
    const ch = (await db.channel.create({
      data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "P", externalId: PAGE_ID },
    } as never)) as any;
    await db.channelAccount.create({
      data: {
        channelId: ch.id, provider: "FACEBOOK", externalAccountId: PAGE_ID, pageName: "P",
        encryptedCredentials: encryptSecret("page-token"),
      },
    } as never);
    return ch;
  }

  function spyFactory() {
    const hits: string[] = [];
    setChannelAdapterFactory("FACEBOOK", (ctx) => {
      hits.push("resolve");
      if (!ctx.facebook) throw new ChannelNotSupportedError("FACEBOOK");
      const inner = new FacebookChannelAdapter(ctx.facebook);
      if (!ctx.mock) hits.push("real-adapter");
      return inner;
    });
    return hits;
  }

  it("inbound webhook normalizes through the registry-resolved real adapter", async () => {
    await seedChannel();
    const hits = spyFactory();
    const res = await ingestMetaWebhook(db as Db, metaPayload());
    expect(res.status).toBe("OK");
    expect(res.normalizedCount).toBe(2);
    expect(hits).toContain("resolve");
    expect(hits).toContain("real-adapter");
    // Byte-identical to the direct kernel call (no behavior change).
    const direct = normalizeFacebookWebhook(metaPayload() as never, "acc-1", PAGE_ID, deriveEventId(metaPayload()));
    const viaAdapter = new FacebookChannelAdapter({ pageId: PAGE_ID, channelAccountId: "acc-1" }).receiveNative(metaPayload());
    expect(viaAdapter).toEqual(direct);
  });

  it("outbound dispatch sends through the registry-resolved real adapter", async () => {
    const ch = await seedChannel();
    const customer = (await db.customer.create({ data: { workspaceId: WS, phone: "0999000000" } } as never)) as any;
    await db.channelIdentity.create({
      data: { workspaceId: WS, customerId: customer.id, channelType: "FACEBOOK", channelExternalId: "psid-1" },
    } as never);
    const conv = (await db.conversation.create({
      data: {
        workspaceId: WS, customerId: customer.id, channelId: ch.id, channelConversationId: "psid-1",
        lastCustomerMessageAt: new Date(),
      },
    } as never)) as any;
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async () => Response.json({ recipient_id: "psid-1", message_id: "mid-live-1" })) as typeof fetch,
        })
    );
    const hits = spyFactory();
    const out = await dispatchOutbound(db as Db, {
      workspaceId: WS,
      conversationId: conv.id,
      sourceMessageId: "probe-1",
      text: "أهلاً فيك",
    });
    expect(out.deliveryStatus).toBe("SENT");
    expect(out.externalMessageId).toBe("mid-live-1");
    expect(hits).toContain("resolve");
    expect(hits).toContain("real-adapter");
  });
});
