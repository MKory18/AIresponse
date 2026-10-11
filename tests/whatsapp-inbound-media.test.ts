import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { LocalStorageProvider } from "@/modules/media/storage";
import { encryptSecret } from "@/core/crypto";
import { normalizeWhatsAppWebhook } from "@/modules/channels/whatsapp/normalizer";
import { WhatsAppClient, setWhatsAppClientFactory } from "@/modules/channels/whatsapp/client";
import { handleWhatsAppMediaDownload } from "@/modules/channels/whatsapp/media-download";
import { handleChannelInbound } from "@/modules/channels/inbound-job";

/**
 * وسائط واتساب الواردة — ميتا تبعت **معرّف** مش رابط، فالوسيط كان يوصل
 * بلا محتوى («وسيط» فاضي بالمحادثة). هون: المعرّف يُلتقط، مهمة التحميل
 * تُصفّ مرة وحدة لكل رسالة، والتحميل بتوكن القناة يصير رابط عندنا.
 */

const WS = "ws-wa-media";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
let tmp: string;
let calls: { url: string; auth: string }[];

/** رأس PNG صالح (فحص البايتات الأولى يطلبه). */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);

const MEDIA_ID = "1234567890";
const WAMID = "wamid.HBgLOTYzOTMz";

function inboundPayload(media: Record<string, unknown>, type = "image") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "pn-1" },
              messages: [{ from: "963933000111", id: WAMID, timestamp: "1760000000", type, [type]: media }],
            },
          },
        ],
      },
    ],
  };
}

/** عميل واتساب وهمي: lookup المعرّف ثم تحميل البايتات — الاثنين بتوكن. */
function stubClient(opts: {
  meta?: { url?: string; mime_type?: string; file_size?: number } | { error: { code: number; message: string } };
  metaStatus?: number;
  body?: Buffer;
  bodyStatus?: number;
  contentType?: string;
}) {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
    calls.push({ url: String(url), auth });
    if (String(url).includes("/media-cdn/")) {
      return new Response(opts.body ?? PNG, {
        status: opts.bodyStatus ?? 200,
        headers: { "content-type": opts.contentType ?? "image/png" },
      });
    }
    return new Response(JSON.stringify(opts.meta ?? { url: "https://graph.example/media-cdn/f1", mime_type: "image/png", file_size: PNG.byteLength }), {
      status: opts.metaStatus ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  setWhatsAppClientFactory(() => new WhatsAppClient({ fetchImpl, graphUrl: "https://graph.example/v21.0" }));
}

async function seedChannelAndMessage(token = "wa-token-xyz") {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "WA", externalId: "pn-1" },
  } as never)) as { id: string };
  await db.channelAccount.create({
    data: {
      channelId: ch.id,
      provider: "WHATSAPP",
      externalAccountId: "pn-1",
      pageName: "WA",
      encryptedCredentials: encryptSecret(token),
    },
  } as never);
  const conv = (await db.conversation.create({
    data: { workspaceId: WS, channelId: ch.id, status: "OPEN", externalConversationId: "963933000111" },
  } as never)) as { id: string };
  const msg = (await db.message.create({
    data: {
      conversationId: conv.id,
      workspaceId: WS,
      senderType: "CUSTOMER",
      direction: "INBOUND",
      type: "IMAGE",
      externalMessageId: WAMID,
      provider: "whatsapp",
      metadata: { waMedia: { id: MEDIA_ID, mimeType: "image/png" } },
    },
  } as never)) as { id: string };
  return { channelId: ch.id, conversationId: conv.id, messageId: msg.id };
}

const messageRow = () => (db._stores.message as Record<string, unknown>[]).find((m) => m.externalMessageId === WAMID)!;
const mediaJobs = () =>
  (db._stores.backgroundJob as Record<string, unknown>[]).filter((j) => j.type === "download_whatsapp_media");

beforeEach(() => {
  db = createFakeDb();
  calls = [];
  tmp = mkdtempSync(join(tmpdir(), "wa-media-"));
  (globalThis as Record<string, unknown>).__acreStorage = new LocalStorageProvider(tmp);
});

afterEach(() => {
  setWhatsAppClientFactory(null);
  delete (globalThis as Record<string, unknown>).__acreStorage;
  rmSync(tmp, { recursive: true, force: true });
});

describe("وسائط واتساب الواردة — التقاط المعرّف", () => {
  it("صورة واردة بمعرّف بلا رابط: المعرّف ينلتقط والنوع يضل IMAGE", () => {
    const [m] = normalizeWhatsAppWebhook(
      inboundPayload({ id: MEDIA_ID, mime_type: "image/jpeg", caption: "شوف هاد" }),
      "ev-1"
    );
    expect(m!.mediaType).toBe("IMAGE");
    expect(m!.mediaUrl).toBeNull();
    expect(m!.media).toEqual({
      id: MEDIA_ID,
      mimeType: "image/jpeg",
      filename: null,
      caption: "شوف هاد",
      voice: false,
    });
  });

  it("بصمة صوتية (voice) ومستند باسمه: الاسم والنوع ينلتقطوا", () => {
    const [voice] = normalizeWhatsAppWebhook(
      inboundPayload({ id: "m-v", mime_type: "audio/ogg; codecs=opus", voice: true }, "audio"),
      "ev-2"
    );
    expect(voice!.mediaType).toBe("AUDIO");
    expect(voice!.media).toMatchObject({ id: "m-v", mimeType: "audio/ogg; codecs=opus", voice: true });
    const [doc] = normalizeWhatsAppWebhook(
      inboundPayload({ id: "m-d", mime_type: "application/pdf", filename: "فاتورة.pdf" }, "document"),
      "ev-3"
    );
    expect(doc!.mediaType).toBe("DOCUMENT");
    expect(doc!.media).toMatchObject({ id: "m-d", filename: "فاتورة.pdf" });
  });

  it("رسالة نص: ولا معرّف وسيط", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn-1" },
                messages: [{ from: "963933000111", id: "wamid.T", timestamp: "1760000000", type: "text", text: { body: "مرحبا" } }],
              },
            },
          ],
        },
      ],
    };
    const [m] = normalizeWhatsAppWebhook(payload, "ev-4");
    expect(m!.media).toBeUndefined();
    expect(m!.text).toBe("مرحبا");
  });
});

describe("وسائط واتساب الواردة — التحميل والتخزين", () => {
  it("المعرّف ← رابط ميتا ← بايتات ← رابط عندنا على الرسالة (والتوكن بكل نداء)", async () => {
    const { channelId } = await seedChannelAndMessage();
    stubClient({});
    const res = await handleWhatsAppMediaDownload(db as Db, {
      workspaceId: WS, channelId, externalMessageId: WAMID, mediaId: MEDIA_ID, mimeType: "image/png",
    });
    expect(res.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`https://graph.example/v21.0/${MEDIA_ID}`);
    expect(calls.every((c) => c.auth === "Bearer wa-token-xyz")).toBe(true);
    const asset = (db._stores.mediaAsset as Record<string, unknown>[])[0]!;
    expect(asset.workspaceId).toBe(WS);
    expect(asset.mimeType).toBe("image/png");
    expect(messageRow().mediaUrl).toBe(asset.url);
    expect(messageRow().metadata).toMatchObject({ waMediaAssetId: asset.id, waMediaId: MEDIA_ID });
  });

  it("بصمة صوتية `audio/ogg; codecs=opus` تُقبل (المعامل يُشال قبل الفحص)", async () => {
    const { channelId } = await seedChannelAndMessage();
    stubClient({
      meta: { url: "https://graph.example/media-cdn/v1", mime_type: "audio/ogg; codecs=opus", file_size: OGG.byteLength },
      body: OGG,
      contentType: "audio/ogg",
    });
    const res = await handleWhatsAppMediaDownload(db as Db, {
      workspaceId: WS, channelId, externalMessageId: WAMID, mediaId: MEDIA_ID,
    });
    expect(res.success).toBe(true);
    expect((db._stores.mediaAsset as Record<string, unknown>[])[0]!.mimeType).toBe("audio/ogg");
    expect(messageRow().mediaUrl).toBeTruthy();
  });

  it("تشغيل المهمة مرتين = تحميل واحد (عدم تكرار بالرابط الموجود)", async () => {
    const { channelId } = await seedChannelAndMessage();
    stubClient({});
    const args = { workspaceId: WS, channelId, externalMessageId: WAMID, mediaId: MEDIA_ID };
    await handleWhatsAppMediaDownload(db as Db, args);
    const first = messageRow().mediaUrl;
    calls = [];
    await handleWhatsAppMediaDownload(db as Db, args);
    expect(calls).toHaveLength(0);
    expect((db._stores.mediaAsset as unknown[]).length).toBe(1);
    expect(messageRow().mediaUrl).toBe(first);
  });

  it("نوع غير مسموح: سبب واضح على الرسالة وبلا إعادة ولا تخزين", async () => {
    const { channelId } = await seedChannelAndMessage();
    stubClient({ meta: { url: "https://graph.example/media-cdn/z", mime_type: "application/zip", file_size: 10 } });
    const res = await handleWhatsAppMediaDownload(db as Db, {
      workspaceId: WS, channelId, externalMessageId: WAMID, mediaId: MEDIA_ID,
    });
    expect(res.success).toBe(true); // نهائي — ما منعيد مهمة ما بتنجح أبدًا
    expect((db._stores.mediaAsset as unknown[]).length).toBe(0);
    expect(messageRow().mediaUrl).toBeFalsy();
    expect(messageRow().metadata).toMatchObject({ waMediaError: "UNSUPPORTED_MEDIA_TYPE:application/zip" });
  });

  it("أكبر من الحد: يُرفض نهائيًا بلا تحميل البايتات", async () => {
    const { channelId } = await seedChannelAndMessage();
    stubClient({ meta: { url: "https://graph.example/media-cdn/big", mime_type: "image/png", file_size: 50 * 1024 * 1024 } });
    const res = await handleWhatsAppMediaDownload(db as Db, {
      workspaceId: WS, channelId, externalMessageId: WAMID, mediaId: MEDIA_ID,
    });
    expect(res.success).toBe(true);
    expect(calls).toHaveLength(1); // lookup بس — ولا تحميل
    expect(String((messageRow().metadata as Record<string, unknown>).waMediaError)).toContain("MEDIA_TOO_LARGE");
  });

  it("عطل مؤقت من ميتا (500): المهمة ترجع فشل حتى تنعاد", async () => {
    const { channelId } = await seedChannelAndMessage();
    stubClient({ meta: { error: { code: 500, message: "server" } }, metaStatus: 500 });
    const res = await handleWhatsAppMediaDownload(db as Db, {
      workspaceId: WS, channelId, externalMessageId: WAMID, mediaId: MEDIA_ID,
    });
    expect(res.success).toBe(false);
    expect(messageRow().mediaUrl).toBeFalsy();
    expect(messageRow().metadata).not.toMatchObject({ waMediaError: expect.anything() });
  });

  it("توكن منتهي (190): سبب نهائي على الرسالة بلا إعادة أبدية", async () => {
    const { channelId } = await seedChannelAndMessage();
    stubClient({ meta: { error: { code: 190, message: "expired" } }, metaStatus: 401 });
    const res = await handleWhatsAppMediaDownload(db as Db, {
      workspaceId: WS, channelId, externalMessageId: WAMID, mediaId: MEDIA_ID,
    });
    expect(res.success).toBe(true);
    expect(messageRow().metadata).toMatchObject({ waMediaError: "WA_190" });
  });

  it("قناة من مساحة تانية: ولا نداء ولا تخزين", async () => {
    const { channelId } = await seedChannelAndMessage();
    stubClient({});
    const res = await handleWhatsAppMediaDownload(db as Db, {
      workspaceId: "ws-other", channelId, externalMessageId: WAMID, mediaId: MEDIA_ID,
    });
    expect(res.success).toBe(false); // الرسالة مش بهالمساحة
    expect(calls).toHaveLength(0);
    expect((db._stores.mediaAsset as unknown[]).length).toBe(0);
  });
});

describe("وسائط واتساب الواردة — صف المهمة من المسار الحي", () => {
  it("رسالة وسيط بواتساب تصفّ مهمة وحدة، والإعادة ما تضاعفها", async () => {
    const ch = (await db.channel.create({
      data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "WA", externalId: "pn-1" },
    } as never)) as { id: string };
    const msg = {
      channelType: "WHATSAPP" as const,
      channelId: ch.id,
      externalUserId: "963933000111",
      externalConversationId: "963933000111",
      externalMessageId: WAMID,
      externalEventId: `ev:${WAMID}`,
      provider: "whatsapp",
      type: "IMAGE" as const,
      text: null,
      mediaUrl: null,
      metadata: { waMedia: { id: MEDIA_ID, mimeType: "image/png", filename: null } },
    };
    await handleChannelInbound(db as Db, { workspaceId: WS, messages: [msg] });
    expect(mediaJobs()).toHaveLength(1);
    expect(mediaJobs()[0]).toMatchObject({
      workspaceId: WS,
      idempotencyKey: `wa-media:${WS}:${WAMID}`,
    });
    expect(mediaJobs()[0]!.payload).toMatchObject({ mediaId: MEDIA_ID, channelId: ch.id, externalMessageId: WAMID });
    await handleChannelInbound(db as Db, { workspaceId: WS, messages: [msg] });
    expect(mediaJobs()).toHaveLength(1);
  });

  it("رسالة نص أو وسيط بيجي معه رابط: ولا مهمة تحميل", async () => {
    const ch = (await db.channel.create({
      data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "WA", externalId: "pn-1" },
    } as never)) as { id: string };
    await handleChannelInbound(db as Db, {
      workspaceId: WS,
      messages: [
        {
          channelType: "WHATSAPP", channelId: ch.id, externalUserId: "u1", externalConversationId: "u1",
          externalMessageId: "wamid.text", externalEventId: "ev:text", provider: "whatsapp",
          type: "TEXT", text: "مرحبا", metadata: {},
        },
        {
          channelType: "WHATSAPP", channelId: ch.id, externalUserId: "u1", externalConversationId: "u1",
          externalMessageId: "wamid.linked", externalEventId: "ev:linked", provider: "whatsapp",
          type: "IMAGE", mediaUrl: "https://cdn.example/a.png",
          metadata: { waMedia: { id: "m-linked" } },
        },
      ],
    });
    expect(mediaJobs()).toHaveLength(0);
  });
});
