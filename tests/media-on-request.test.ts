/**
 * Sending product images when the customer asks: what goes out, what the
 * model is told about it, and that a retry never repeats a photo.
 *
 * In-memory DB and mock provider: behaviour only, nothing about real Meta
 * delivery or latency.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import { createProduct } from "@/modules/products/service";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { dispatchOutbound, recoverStuckOutboundMessages } from "@/modules/channels/outbound";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import {
  findProductMedia,
  pickUnsentProductImage,
  pickUnsentProductImages,
} from "@/modules/media/service";
import { wantsMedia, wantsMultipleImages } from "@/modules/media/request";
import { buildPageProductContext } from "@/modules/catalog/service";

type Db = Prisma.TransactionClient;
const WS = "ws-media-ask";
const AGENT = { userId: "agent-media", workspaceId: WS };
const NAME = "ماء الورد الطبيعي";

let db: ReturnType<typeof createFakeDb>;
const asDb = () => db as unknown as Db;
let counter = 0;

/** Every Send API body that reached the fake Meta endpoint, in order. */
let sends: Array<{ attachment?: { payload?: { url?: string } }; text?: string }>;
/** Decides each Send API answer; defaults to success. */
let answer: (body: { attachment?: unknown; text?: string }) => Response | null;

beforeEach(() => {
  db = createFakeDb();
  sends = [];
  answer = () => null;
  setMockAIProvider(undefined);
  vi.stubEnv("APP_URL", "https://app.example.com");
});

afterEach(() => {
  setMockAIProvider(undefined);
  setFacebookClientFactory(undefined as never);
  vi.unstubAllEnvs();
});

async function product(name = NAME, sku = "ROSE-1") {
  return (await createProduct(asDb(), AGENT, { name, sku, price: 25, currency: "USD" } as never)) as unknown as { id: string };
}

async function makePage(sendMode = "AUTO_REPLY") {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", externalId: "page-1", sendMode },
  } as never)) as { id: string };
  await db.channelAccount.create({
    data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-1", pageName: "صفحة", encryptedCredentials: encryptSecret("tok") },
  } as never);
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: { body?: string }) => {
          if (!new URL(url).pathname.includes("/messages")) return Response.json({ id: "p", name: "p" });
          const body = JSON.parse(String(init?.body ?? "{}"));
          const decided = answer(body.message ?? {});
          if (decided) return decided;
          sends.push(body.message ?? {});
          return Response.json({ recipient_id: "psid-1", message_id: `mid-${counter++}` });
        }) as typeof fetch,
      })
  );
  await db.aISettings.create({
    data: { workspaceId: WS, provider: "mock", temperature: 0.4, maxTokens: 500, aiEnabled: true, autoRespond: true },
  } as never);
  return ch.id;
}

async function image(productId: string | null, over: Record<string, unknown> = {}) {
  const n = counter++;
  return (await db.mediaAsset.create({
    data: {
      workspaceId: WS, url: `https://cdn.example/${n}.jpg`, storageKey: `k-${n}`, mimeType: "image/jpeg", size: 1000,
      type: "IMAGE", category: "PRODUCT", title: `img-${n}`, productId, ...over,
    },
  } as never)) as unknown as { id: string; url: string };
}

async function inbound(channelId: string, text: string) {
  const n = counter++;
  return processIncomingMessage(asDb(), {
    workspaceId: WS, channelType: "FACEBOOK", channelId, externalUserId: "psid-1", externalConversationId: "psid-1",
    externalMessageId: `m-${n}`, externalEventId: `e-${n}`, provider: "facebook", type: "TEXT", text,
  });
}

function mockModel(respond: string | (() => string), prompts: string[] = []) {
  const mock = new MockAIProvider();
  mock.intentHandler = () => ({ intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER" }) as never;
  mock.responseHandler = (user: string, system: string) => {
    prompts.push(`${system}\n${user}`);
    return typeof respond === "function" ? respond() : respond;
  };
  setMockAIProvider(mock);
}

async function runTurn(channelId: string, text: string, respond: string | (() => string) = "أهلا فيك") {
  const msg = await inbound(channelId, text);
  const prompts: string[] = [];
  mockModel(respond, prompts);
  const res = await processAIMessage(
    asDb(),
    { conversationId: msg.conversationId, messageId: msg.messageId, workspaceId: WS },
    { vectorStore: { size: 0, search: async () => [] } as never }
  );
  return { res, prompt: prompts.join("\n"), conversationId: msg.conversationId, messageId: msg.messageId };
}

const attachments = () => sends.filter((s) => s.attachment);
const texts = () => sends.filter((s) => !s.attachment);
const rows = () => (db as any)._stores.message.filter((m: { direction: string }) => m.direction === "OUTBOUND") as Array<Record<string, any>>;

const PROMISE = "تفضل الصورة";

describe("1. a WhatsApp photo that moved past SENT is not sent again", () => {
  it.each(["SENT", "DELIVERED", "READ"])("%s counts as already sent", async (deliveryStatus) => {
    const p = await product();
    const a = await image(p.id);
    await db.message.create({
      data: { workspaceId: WS, conversationId: "c1", direction: "OUTBOUND", deliveryStatus, metadata: { mediaId: a.id } },
    } as never);
    expect(await pickUnsentProductImage(asDb(), WS, "c1", p.id)).toEqual({ mediaId: null, skipped: "ALL_SENT" });
  });

  it("a FAILED send does not count", async () => {
    const p = await product();
    const a = await image(p.id);
    await db.message.create({
      data: { workspaceId: WS, conversationId: "c1", direction: "OUTBOUND", deliveryStatus: "FAILED", metadata: { mediaId: a.id } },
    } as never);
    expect((await pickUnsentProductImage(asDb(), WS, "c1", p.id)).mediaId).toBe(a.id);
  });
});

describe("2. the model is told the truth before it writes", () => {
  it("a photo going out: the model may say so", async () => {
    const p = await product();
    await image(p.id);
    const channelId = await makePage();
    const { prompt } = await runTurn(channelId, `ابعتلي صورة ${NAME}`);
    expect(prompt).toContain(PROMISE);
    expect(attachments()).toHaveLength(1);
  });

  it("NO_IMAGE: no promise, no attachment, reason on the row", async () => {
    await product();
    const channelId = await makePage();
    const { prompt } = await runTurn(channelId, `ابعتلي صورة ${NAME}`);
    expect(prompt).not.toContain(PROMISE);
    expect(prompt).toContain("لن تُرفق");
    expect(attachments()).toHaveLength(0);
    expect(rows()[0].metadata).toMatchObject({ mediaSkipped: "NO_IMAGE" });
  });

  it("ALL_SENT: no promise and no repeat", async () => {
    const p = await product();
    await image(p.id);
    const channelId = await makePage();
    await runTurn(channelId, `ابعتلي صورة ${NAME}`, "تفضل");
    const before = attachments().length;
    const second = await runTurn(channelId, `ابعتلي صورة ${NAME} مرة تانية`);
    expect(second.prompt).not.toContain(PROMISE);
    expect(second.prompt).toContain("لن تُرفق");
    expect(attachments()).toHaveLength(before);
  });

  it("a channel refusal: no promise, reason on the row", async () => {
    const p = await product();
    await image(p.id, { mimeType: "image/webp" });
    const channelId = await makePage();
    const { prompt } = await runTurn(channelId, `ابعتلي صورة ${NAME}`);
    expect(prompt).not.toContain(PROMISE);
    expect(prompt).toContain("لن تُرفق");
    expect(attachments()).toHaveLength(0);
    expect(rows()[0].metadata).toMatchObject({ mediaSkipped: "CHANNEL_UNFIT" });
  });

  it("an unfit photo does not hide a fitting one behind it", async () => {
    const p = await product();
    await image(p.id, { mimeType: "image/webp" });
    const good = await image(p.id);
    const channelId = await makePage();
    const { prompt } = await runTurn(channelId, `ابعتلي صورة ${NAME}`);
    expect(prompt).toContain(PROMISE);
    expect(attachments()).toHaveLength(1);
    expect(rows()[0].metadata).toMatchObject({ mediaId: good.id });
  });
});

describe("3. plural requests", () => {
  it.each([
    ["ابعتلي صور المنتج", true],
    ["بدي الصور", true],
    ["send me photos", true],
    ["any pictures?", true],
    ["ابعتلي صورة", false],
    ["ابعتلي الصوره", false],
    ["send me a photo", false],
    ["بدي فيديو", false],
    ["مرحبا", false],
  ])("wantsMultipleImages(%s) = %s", (text, expected) => {
    expect(wantsMultipleImages(text as string)).toBe(expected);
  });

  it("every plural phrase is also a media ask", () => {
    expect(wantsMedia("ابعتلي صور المنتج")).toBe("image");
    expect(wantsMedia("send me photos")).toBe("image");
  });

  async function fivePhotos() {
    const p = await product();
    const out: string[] = [];
    for (let i = 0; i < 5; i++) out.push((await image(p.id)).id);
    return { p, out };
  }

  it("pickUnsentProductImages returns at most max, unsent only", async () => {
    const { p, out } = await fivePhotos();
    await db.message.create({
      data: { workspaceId: WS, conversationId: "c1", direction: "OUTBOUND", deliveryStatus: "READ", metadata: { mediaId: out[0] } },
    } as never);
    const picked = await pickUnsentProductImages(asDb(), WS, "c1", p.id);
    expect(picked.mediaIds).toHaveLength(3);
    expect(picked.mediaIds).not.toContain(out[0]);
    expect(new Set(picked.mediaIds).size).toBe(3);
  });

  it("pickUnsentProductImages reports why there is nothing", async () => {
    const p = await product();
    expect(await pickUnsentProductImages(asDb(), WS, "c1", p.id)).toEqual({ mediaIds: [], skipped: "NO_IMAGE" });
  });

  it("plural sends three photos, then the words last", async () => {
    await fivePhotos();
    const channelId = await makePage();
    const { res, messageId, conversationId } = await runTurn(channelId, `ابعتلي صور ${NAME}`, "تفضل الصور");
    expect(res.status).toBe("RESPONDED");
    expect(attachments()).toHaveLength(3);
    expect(new Set(attachments().map((s) => s.attachment?.payload?.url)).size).toBe(3);
    expect(sends.map((s) => Boolean(s.attachment))).toEqual([true, true, true, false]);
    expect(texts().map((s) => s.text)).toEqual(["تفضل الصور"]);
    const keys = rows().map((r) => r.outboundIdempotencyKey);
    expect(keys.filter((k) => k.startsWith(`${conversationId}:${messageId}:img:`))).toHaveLength(2);
    expect(keys).toContain(`${conversationId}:${messageId}`);
  });

  it("singular sends one photo", async () => {
    await fivePhotos();
    const channelId = await makePage();
    await runTurn(channelId, `ابعتلي صورة ${NAME}`, "تفضل");
    expect(attachments()).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  it("the prompt names the plural when several are going out", async () => {
    await fivePhotos();
    const channelId = await makePage();
    const { prompt } = await runTurn(channelId, `ابعتلي صور ${NAME}`, "تفضل");
    expect(prompt).toContain("تفضل الصور");
  });

  it("a retry repeats no photo and picks no extra one", async () => {
    await fivePhotos();
    const channelId = await makePage();
    let failText = true;
    answer = (m) => (m.text && failText ? new Response("{}", { status: 500 }) : null);
    const msg = await inbound(channelId, `ابعتلي صور ${NAME}`);
    mockModel("تفضل الصور");
    const params = { conversationId: msg.conversationId, messageId: msg.messageId, workspaceId: WS };
    const deps = { vectorStore: { size: 0, search: async () => [] } as never };

    const first = await processAIMessage(asDb(), params, deps);
    expect(first.status).toBe("AI_FAILED");
    expect(attachments()).toHaveLength(3);

    failText = false;
    const second = await processAIMessage(asDb(), params, deps);
    expect(second.status).toBe("RESPONDED");
    expect(attachments()).toHaveLength(3);
    expect(new Set(attachments().map((s) => s.attachment?.payload?.url)).size).toBe(3);
    expect(texts()).toHaveLength(1);
  });

  it("a failed extra photo does not stop the reply", async () => {
    await fivePhotos();
    const channelId = await makePage();
    let seen = 0;
    answer = (m) => (m.attachment && seen++ === 0 ? new Response("{}", { status: 400 }) : null);
    const { res } = await runTurn(channelId, `ابعتلي صور ${NAME}`, "تفضل الصور");
    expect(res.status).toBe("RESPONDED");
    expect(texts()).toHaveLength(1);
  });

  describe("empty text beside a media id", () => {
    async function conversation(channelId: string) {
      const msg = await inbound(channelId, "مرحبا");
      return msg.conversationId;
    }
    const send = (conversationId: string, mediaId: string | undefined, source = "src-1") =>
      dispatchOutbound(asDb(), { workspaceId: WS, conversationId, sourceMessageId: source, text: "", mediaId });

    it("sends the image alone and never an empty text", async () => {
      const a = await image(null);
      const conv = await conversation(await makePage());
      const r = await send(conv, a.id);
      expect(r.deliveryStatus).toBe("SENT");
      expect(sends).toHaveLength(1);
      expect(sends[0].attachment).toBeDefined();
      expect(rows()[0].metadata).toMatchObject({ mediaId: a.id });
      expect(rows()[0].type).toBe("IMAGE");
    });

    it("empty text with no media is still refused", async () => {
      const conv = await conversation(await makePage());
      const r = await send(conv, undefined);
      expect(r.deliveryStatus).toBe("FAILED");
      expect(sends).toHaveLength(0);
    });

    it("a missing asset does not fall through to sendText('')", async () => {
      const conv = await conversation(await makePage());
      const r = await send(conv, "media-does-not-exist");
      expect(r.deliveryStatus).toBe("FAILED");
      expect(r.error).toContain("MEDIA_NOT_AVAILABLE");
      expect(sends).toHaveLength(0);
      expect(rows()[0].deliveryStatus).toBe("FAILED");
      expect(rows()[0].metadata).toMatchObject({ mediaSkipped: "MEDIA_NOT_AVAILABLE" });
      expect(rows()[0].metadata).not.toHaveProperty("mediaId");
    });

    it("a channel-refused file does not fall through to sendText('')", async () => {
      const webp = await image(null, { mimeType: "image/webp" });
      const conv = await conversation(await makePage());
      const r = await send(conv, webp.id);
      expect(r.deliveryStatus).toBe("FAILED");
      expect(r.error).toContain("CHANNEL_UNFIT");
      expect(sends).toHaveLength(0);
    });

    it("COLLECTION_ONLY blocks a media-only send before any row exists", async () => {
      const a = await image(null);
      const conv = await conversation(await makePage("COLLECTION_ONLY"));
      const r = await send(conv, a.id);
      expect(r.deliveryStatus).toBe("FAILED");
      expect(r.error).toContain("COLLECTION_ONLY");
      expect(sends).toHaveLength(0);
      expect(rows()).toHaveLength(0);
    });

    it("a stuck media-only row recovers without a duplicate", async () => {
      const a = await image(null);
      const conv = await conversation(await makePage());
      answer = () => new Response("{}", { status: 500 });
      const queued = await send(conv, a.id);
      expect(queued.deliveryStatus).toBe("QUEUED");
      answer = () => null;
      rows()[0].createdAt = new Date(Date.now() - 3600_000);
      const out = await recoverStuckOutboundMessages(asDb(), { workspaceId: WS, maxAgeMinutes: 10 });
      expect(out.recovered).toBe(1);
      expect(attachments()).toHaveLength(1);
      expect(texts()).toHaveLength(0);
    });
  });

  it("COLLECTION_ONLY set mid-turn blocks the extras and the reply alike", async () => {
    await fivePhotos();
    const channelId = await makePage();
    const { res } = await runTurn(channelId, `ابعتلي صور ${NAME}`, () => {
      (db as any)._stores.channel[0].sendMode = "COLLECTION_ONLY";
      return "تفضل الصور";
    });
    expect(res.status).toBe("AI_FAILED");
    expect(sends).toHaveLength(0);
  });
});

describe("4. testimonial and feedback images are not product photos", () => {
  it.each(["FEEDBACK", "TESTIMONIAL"])("%s by direct FK is excluded", async (category) => {
    const p = await product();
    await image(p.id, { category });
    expect(await findProductMedia(asDb(), WS, p.id, 10)).toEqual([]);
  });

  it.each(["FEEDBACK", "TESTIMONIAL"])("%s through the join table is excluded", async (category) => {
    const p = await product();
    const a = await image(null, { category });
    await db.productMedia.create({ data: { productId: p.id, mediaAssetId: a.id, workspaceId: WS } } as never);
    expect(await findProductMedia(asDb(), WS, p.id, 10)).toEqual([]);
  });

  it.each(["PRODUCT", "BRAND", "OTHER"])("%s is kept", async (category) => {
    const p = await product();
    const a = await image(p.id, { category });
    expect((await findProductMedia(asDb(), WS, p.id, 10)).map((m) => m.id)).toEqual([a.id]);
  });

  it("customer inbound stays excluded", async () => {
    const p = await product();
    await image(p.id, { category: "CUSTOMER_INBOUND" });
    expect(await findProductMedia(asDb(), WS, p.id, 10)).toEqual([]);
  });

  it("many testimonials linked first do not hide a real photo", async () => {
    const p = await product();
    for (let i = 0; i < 12; i++) {
      const t = await image(null, { category: "TESTIMONIAL" });
      await db.productMedia.create({ data: { productId: p.id, mediaAssetId: t.id, workspaceId: WS, sortOrder: i } } as never);
    }
    const real = await image(null);
    await db.productMedia.create({ data: { productId: p.id, mediaAssetId: real.id, workspaceId: WS, sortOrder: 50 } } as never);
    expect((await findProductMedia(asDb(), WS, p.id, 10)).map((m) => m.id)).toEqual([real.id]);
  });

  it("the customer asking for photos gets only the product photo", async () => {
    const p = await product();
    await image(p.id, { category: "TESTIMONIAL" });
    const real = await image(p.id);
    const channelId = await makePage();
    await runTurn(channelId, `ابعتلي صور ${NAME}`, "تفضل");
    expect(attachments()).toHaveLength(1);
    expect(rows().map((r) => r.metadata?.mediaId)).toEqual([real.id]);
  });
});

describe("5. no product resolved", () => {
  it("the model is told to ask which product and promise nothing", async () => {
    await product();
    const channelId = await makePage();
    const { prompt, res } = await runTurn(channelId, "ابعتلي صور");
    expect(res.status).toBe("RESPONDED");
    expect(prompt).not.toContain(PROMISE);
    expect(prompt).toContain("أي منتج");
    expect(prompt).toContain("لا تذكر اسم منتج");
    expect(attachments()).toHaveLength(0);
  });

  it("no instruction at all when the customer did not ask for media", async () => {
    await product();
    const channelId = await makePage();
    const { prompt } = await runTurn(channelId, "شو ساعات الدوام عندكم اليوم");
    expect(prompt).not.toContain("أي منتج");
    expect(prompt).not.toContain("لن تُرفق");
    expect(prompt).not.toContain(PROMISE);
  });
});

describe("6. catalog preview", () => {
  async function page() {
    const p = await product();
    const ch = (await db.channel.create({ data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "ص", externalId: "x" } } as never)) as { id: string };
    const catalog = (await db.catalog.create({ data: { workspaceId: WS, name: "ك", isActive: true } } as never)) as { id: string };
    await db.catalogPageAssignment.create({ data: { workspaceId: WS, catalogId: catalog.id, channelId: ch.id } } as never);
    await db.catalogProduct.create({ data: { catalogId: catalog.id, productId: p.id } } as never);
    return { p, channelId: ch.id };
  }
  const imagesOf = async (channelId: string) =>
    ((await buildPageProductContext(asDb(), WS, channelId)).products as Array<{ images: string[] }>)[0].images;

  it("an image linked both ways appears once", async () => {
    const { p, channelId } = await page();
    const a = await image(p.id);
    await db.productMedia.create({ data: { productId: p.id, mediaAssetId: a.id, workspaceId: WS } } as never);
    expect(await imagesOf(channelId)).toEqual([a.url]);
  });

  it("does not preview an image the reply would never send", async () => {
    const { p, channelId } = await page();
    await image(p.id, { category: "TESTIMONIAL" });
    const linked = await image(null, { category: "FEEDBACK" });
    await db.productMedia.create({ data: { productId: p.id, mediaAssetId: linked.id, workspaceId: WS } } as never);
    expect(await imagesOf(channelId)).toEqual([]);
  });
});
