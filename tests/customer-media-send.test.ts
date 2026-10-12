import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { findProductMedia, pickUnsentProductImage } from "@/modules/media/service";
import { setWhatsAppClientFactory, WhatsAppClient } from "@/modules/channels/whatsapp/client";
import { setFacebookClientFactory, FacebookClient } from "@/modules/channels/facebook/client";

/**
 * THE TEXT SURVIVES THE IMAGE.
 *
 * A missing asset, a channel-refused file, or a failed media send used to
 * fail the whole reply — the customer got nothing, not even the words.
 * Now the send continues text-only, SENT, and the row records
 * metadata.mediaSkipped. Selection is IMAGE-only (a linked video never
 * answers as a photo), one photo per conversation, never a repeat, never
 * a customer inbound.
 */
const WS = "ws-custmedia";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

async function seedWhatsApp(identityId: string) {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "W", externalId: "num-1" },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "WHATSAPP", externalAccountId: "num-1",
      encryptedCredentials: encryptSecret("fixture-token"),
    },
  } as never);
  const customer = (await db.customer.create({ data: { workspaceId: WS, phone: `p-${identityId}` } } as never)) as any;
  await db.channelIdentity.create({
    data: { workspaceId: WS, customerId: customer.id, channelType: "WHATSAPP", channelExternalId: identityId },
  } as never);
  const conv = (await db.conversation.create({
    data: {
      workspaceId: WS, customerId: customer.id, channelId: ch.id, channelConversationId: identityId,
      lastCustomerMessageAt: new Date(),
    },
  } as never)) as any;
  return { ch, conv };
}

async function asset(over: Record<string, unknown> = {}) {
  return (await db.mediaAsset.create({
    data: {
      workspaceId: WS, url: "https://cdn.example/x.jpg", storageKey: `k-${Math.random().toString(36).slice(2)}`,
      mimeType: "image/jpeg", size: 1000, type: "IMAGE", category: "PRODUCT", title: "x",
      ...over,
    },
  } as never)) as any;
}

function stubWhatsApp() {
  setWhatsAppClientFactory(
    () =>
      new WhatsAppClient({
        fetchImpl: (async () => Response.json({ messages: [{ id: "wamid.out.1" }] })) as typeof fetch,
      })
  );
}

function send(conversationId: string, text: string, mediaId?: string, source?: string) {
  return dispatchOutbound(db as Db, {
    workspaceId: WS, conversationId, sourceMessageId: source ?? `s-${Math.random().toString(36).slice(2, 8)}`,
    text, mediaId: mediaId ?? undefined,
  });
}

async function sentRow(id: string) {
  return (await db.message.findUnique({ where: { id }, select: { deliveryStatus: true, metadata: true } })) as any;
}

beforeEach(() => {
  db = createFakeDb();
  setWhatsAppClientFactory(null);
  setFacebookClientFactory(null);
  vi.stubEnv("APP_URL", "https://app.example.com");
  return () => {
    vi.unstubAllEnvs();
  };
});

describe("selection — IMAGE only, once per conversation", () => {
  it("a video linked to the product never answers as its photo", async () => {
    const photo = await asset({ title: "photo" });
    const clip = await asset({ title: "clip", type: "VIDEO", mimeType: "video/mp4", url: "https://cdn.example/x.mp4" });
    await db.productMedia.create({ data: { productId: "prod-1", mediaAssetId: photo.id, workspaceId: WS } } as never);
    await db.productMedia.create({ data: { productId: "prod-1", mediaAssetId: clip.id, workspaceId: WS } } as never);
    const found = await findProductMedia(db as Db, WS, "prod-1", 10);
    expect(found.map((m: any) => m.id)).toEqual([photo.id]);
  });

  it("picks an unsent photo, then the other one, then reports ALL_SENT — never a repeat", async () => {
    const a = await asset({ title: "a" });
    const b = await asset({ title: "b" });
    await db.productMedia.create({ data: { productId: "prod-1", mediaAssetId: a.id, workspaceId: WS, sortOrder: 0 } } as never);
    await db.productMedia.create({ data: { productId: "prod-1", mediaAssetId: b.id, workspaceId: WS, sortOrder: 1 } } as never);
    const { conv } = await seedWhatsApp("9101");

    const first = await pickUnsentProductImage(db as Db, WS, conv.id, "prod-1");
    expect([a.id, b.id]).toContain(first.mediaId);
    await db.message.create({
      data: { workspaceId: WS, conversationId: conv.id, direction: "OUTBOUND", deliveryStatus: "SENT", metadata: { mediaId: first.mediaId } },
    } as never);
    const second = await pickUnsentProductImage(db as Db, WS, conv.id, "prod-1");
    expect(second.mediaId).toBe(first.mediaId === a.id ? b.id : a.id);
    await db.message.create({
      data: { workspaceId: WS, conversationId: conv.id, direction: "OUTBOUND", deliveryStatus: "SENT", metadata: { mediaId: second.mediaId } },
    } as never);
    expect(await pickUnsentProductImage(db as Db, WS, conv.id, "prod-1")).toEqual({ mediaId: null, skipped: "ALL_SENT" });
  });

  it("reports NO_IMAGE when the product has no photo", async () => {
    const { conv } = await seedWhatsApp("9102");
    expect(await pickUnsentProductImage(db as Db, WS, conv.id, "prod-9")).toEqual({ mediaId: null, skipped: "NO_IMAGE" });
  });

  it("a customer inbound is never picked", async () => {
    const inbound = await asset({ title: "customer-photo", category: "CUSTOMER_INBOUND" });
    await db.productMedia.create({ data: { productId: "prod-1", mediaAssetId: inbound.id, workspaceId: WS } } as never);
    const { conv } = await seedWhatsApp("9103");
    expect(await pickUnsentProductImage(db as Db, WS, conv.id, "prod-1")).toEqual({ mediaId: null, skipped: "NO_IMAGE" });
  });
});

describe("dispatch — the text survives the image", () => {
  it("a missing asset sends the text alone, SENT, with the reason on the row", async () => {
    const { conv } = await seedWhatsApp("9201");
    stubWhatsApp();
    const r = await send(conv.id, "السعر 100", "media-does-not-exist");
    expect(r.deliveryStatus).toBe("SENT");
    const row = await sentRow(r.messageId);
    expect(row.metadata).toMatchObject({ mediaSkipped: "MEDIA_NOT_AVAILABLE" });
    expect(row.metadata).not.toHaveProperty("mediaId");
  });

  it("a WhatsApp-refused file sends the text alone, SENT, with the reason on the row", async () => {
    const webp = await asset({ title: "w", mimeType: "image/webp", url: "https://cdn.example/x.webp" });
    const { conv } = await seedWhatsApp("9202");
    stubWhatsApp();
    const r = await send(conv.id, "شوف الصورة", webp.id);
    expect(r.deliveryStatus).toBe("SENT");
    const row = await sentRow(r.messageId);
    expect(row.metadata).toMatchObject({ mediaSkipped: "CHANNEL_UNFIT" });
    expect(row.metadata).not.toHaveProperty("mediaId");
  });

  it("a fitting photo still travels with the text", async () => {
    const photo = await asset({ title: "p" });
    const { conv } = await seedWhatsApp("9203");
    stubWhatsApp();
    const r = await send(conv.id, "شوف الصورة", photo.id);
    expect(r.deliveryStatus).toBe("SENT");
    const row = await sentRow(r.messageId);
    expect(row.metadata).toMatchObject({ mediaId: photo.id });
    expect(row.metadata).not.toHaveProperty("mediaSkipped");
  });

  it("a permanently refused send still delivers the words, SENT, with the reason on the row", async () => {
    const ch = (await db.channel.create({
      data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "P", externalId: "page-9" },
    } as never)) as any;
    await db.channelAccount.create({
      data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-9", encryptedCredentials: encryptSecret("t") },
    } as never);
    const customer = (await db.customer.create({ data: { workspaceId: WS, phone: "9301" } } as never)) as any;
    await db.channelIdentity.create({
      data: { workspaceId: WS, customerId: customer.id, channelType: "FACEBOOK", channelExternalId: "psid-9301" },
    } as never);
    const conv = (await db.conversation.create({
      data: { workspaceId: WS, customerId: customer.id, channelId: ch.id, channelConversationId: "psid-9301", lastCustomerMessageAt: new Date() },
    } as never)) as any;
    const photo = await asset({ title: "p" });
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async (url: string, init?: { body?: string }) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            // The photo is refused for good; the words go through.
            if (body.message?.attachment) return new Response("{}", { status: 400 });
            return Response.json({ recipient_id: "psid-9301", message_id: "mid-fb-9" });
          }) as typeof fetch,
        })
    );
    const r = await send(conv.id, "شوف الصورة", photo.id);
    expect(r.deliveryStatus).toBe("SENT");
    const row = await sentRow(r.messageId);
    expect(row.metadata).toMatchObject({ mediaSkipped: "SEND_FAILED" });
    expect(row.metadata).not.toHaveProperty("mediaId");
  });
});
