import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { LocalStorageProvider, getStorage } from "@/modules/media/storage";
import { encryptSecret } from "@/core/crypto";
import { WhatsAppClient, setWhatsAppClientFactory } from "@/modules/channels/whatsapp/client";
import { handleWhatsAppMediaDownload } from "@/modules/channels/whatsapp/media-download";
import {
  purgeOldCustomerMedia,
  waMediaRetentionDays,
  DEFAULT_WA_MEDIA_RETENTION_DAYS,
} from "@/modules/channels/whatsapp/media-retention";
import {
  listMedia,
  findRelevantMedia,
  findProductMedia,
  generatePublicMediaUrl,
  uploadMedia,
} from "@/modules/media/service";
import { buildMediaContext } from "@/modules/ai/context-builder";
import { createProduct } from "@/modules/products/service";

/**
 * خصوصية وسائط الزبون الواردة.
 *
 * ⚠️ العيب الي هالملف بيحرسه: وسيط الزبون كان يتخزّن بالمكتبة المشتركة
 * بعنوان = اسم ملفه الأصلي. ومحادثة فيها صورة بلا نص (بحث فاضي · بلا منتج)
 * كانت ترجّع «أحدث 3 وسائط» بالمساحة — يعني وسائط زباين **تانيين** بعنوانها
 * ورابطها جوّا برومبت الموديل، واسم الملف ممكن يكون فيه اسم الزبون.
 */

const WS = "ws-wa-privacy";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
let tmp: string;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const WAMID = "wamid.PRIV1";
const MEDIA_ID = "9988776655";
/** اسم ملف فيه اسم الزبون — ما بيجوز ينحفظ ولا يظهر أبدًا. */
const CUSTOMER_FILENAME = "صورة-أبو-محمد-الحلبي.png";

function stubClient() {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/media-cdn/")) {
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response(
      JSON.stringify({ url: "https://graph.example/media-cdn/f1", mime_type: "image/png", file_size: PNG.byteLength }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as unknown as typeof fetch;
  setWhatsAppClientFactory(() => new WhatsAppClient({ fetchImpl, graphUrl: "https://graph.example/v21.0" }));
}

/** محادثة زبون + رسالة وسيط، وتحميل الوسيط فعليًا عبر المسار الحي. */
async function seedCustomerMedia(suffix = "") {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "WA", externalId: "pn-1" },
  } as never)) as { id: string };
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "WHATSAPP", externalAccountId: "pn-1", pageName: "WA",
      encryptedCredentials: encryptSecret("wa-token"),
    },
  } as never);
  const conv = (await db.conversation.create({
    data: { workspaceId: WS, channelId: ch.id, status: "OPEN", externalConversationId: `cust${suffix}` },
  } as never)) as { id: string };
  const msg = (await db.message.create({
    data: {
      conversationId: conv.id, workspaceId: WS, senderType: "CUSTOMER", direction: "INBOUND",
      type: "IMAGE", externalMessageId: `${WAMID}${suffix}`, provider: "whatsapp",
      metadata: { waMedia: { id: `${MEDIA_ID}${suffix}`, mimeType: "image/png", filename: CUSTOMER_FILENAME } },
    },
  } as never)) as { id: string };
  stubClient();
  const res = await handleWhatsAppMediaDownload(db as Db, {
    workspaceId: WS,
    channelId: ch.id,
    externalMessageId: `${WAMID}${suffix}`,
    mediaId: `${MEDIA_ID}${suffix}`,
    mimeType: "image/png",
    // ⚠️ حتى لو الاسم انمرر، ممنوع ينحفظ.
    filename: CUSTOMER_FILENAME,
  });
  expect(res.success).toBe(true);
  const asset = (db._stores.mediaAsset as Record<string, unknown>[]).find((a) => a.messageId === msg.id)!;
  return { channelId: ch.id, conversationId: conv.id, messageId: msg.id, asset };
}

let prevEnv: string | undefined;
beforeEach(() => {
  db = createFakeDb();
  tmp = mkdtempSync(join(tmpdir(), "wa-priv-"));
  (globalThis as Record<string, unknown>).__acreStorage = new LocalStorageProvider(tmp);
  prevEnv = process.env.WA_MEDIA_RETENTION_DAYS;
  delete process.env.WA_MEDIA_RETENTION_DAYS;
});
afterEach(() => {
  setWhatsAppClientFactory(null);
  delete (globalThis as Record<string, unknown>).__acreStorage;
  rmSync(tmp, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.WA_MEDIA_RETENTION_DAYS;
  else process.env.WA_MEDIA_RETENTION_DAYS = prevEnv;
});

describe("وسيط الزبون — اسم الملف الأصلي ما بينحفظ أبدًا", () => {
  it("العنوان معتم · ولا اسم زبون بالعنوان أو الوصف أو مفتاح التخزين", async () => {
    const { asset } = await seedCustomerMedia();
    const blob = JSON.stringify(asset);
    expect(blob).not.toContain("أبو-محمد");
    expect(blob).not.toContain("الحلبي");
    expect(String(asset.title)).toMatch(/^wa-[0-9a-f]{24}\.png$/);
    expect(asset.description ?? null).toBeNull();
    expect(String(asset.storageKey)).not.toContain("محمد");
  });

  it("التصنيف خاص والوسيط مربوط برسالته بس", async () => {
    const { asset, messageId } = await seedCustomerMedia();
    expect(asset.category).toBe("CUSTOMER_INBOUND");
    expect(asset.messageId).toBe(messageId);
    expect(asset.productId ?? null).toBeNull();
  });
});

describe("وسيط الزبون — ما بيوصل سياق الذكاء لمحادثة تانية", () => {
  it("بحث فاضي وبلا منتج (رسالة صورة بس): ولا وسيط زبون بالسياق", async () => {
    await seedCustomerMedia();
    const ctx = await buildMediaContext(db as Db, { workspaceId: WS });
    expect(ctx.media).toEqual([]);
    expect(ctx.citations).toEqual([]);
  });

  it("بحث يطابق اسم ملف الزبون: ولا نتيجة", async () => {
    await seedCustomerMedia();
    for (const q of ["أبو-محمد", "الحلبي", "wa-", "png"]) {
      const ctx = await buildMediaContext(db as Db, { workspaceId: WS, query: q });
      expect(ctx.media, `query=${q}`).toEqual([]);
    }
  });

  it("وسيط منتج حقيقي يضل يوصل — ووسيط الزبون لا (ولا كسر للسلوك الموجود)", async () => {
    await seedCustomerMedia();
    const product = (await createProduct(db as Db, { userId: "u1", workspaceId: WS }, {
      name: "كريم", sku: "CR-1", price: 100, currency: "USD",
    } as never)) as { id: string };
    await uploadMedia(db as Db, { userId: "u1", workspaceId: WS }, {
      filename: "cream.png", mimeType: "image/png", size: PNG.byteLength, data: PNG,
      category: "PRODUCT", productId: product.id, title: "كريم الوجه",
    });
    const ctx = await buildMediaContext(db as Db, { workspaceId: WS, productId: product.id });
    expect(ctx.media.map((m) => m.title)).toEqual(["كريم الوجه"]);
    const direct = await findProductMedia(db as Db, WS, product.id, 5);
    expect(direct.every((a) => a.category !== "CUSTOMER_INBOUND")).toBe(true);
    // وبلا منتج كمان: الوسيط العام بيطلع، وسيط الزبون لأ.
    const generic = await findRelevantMedia(db as Db, { workspaceId: WS });
    expect(generic.map((a) => a.title)).toEqual(["كريم الوجه"]);
  });

  it("وسيط زبون من محادثة تانية ما بيطلع ولا بسياق محادثته هو", async () => {
    await seedCustomerMedia("-a");
    await seedCustomerMedia("-b");
    const ctx = await buildMediaContext(db as Db, { workspaceId: WS, limit: 3 });
    expect(ctx.media).toEqual([]);
  });
});

describe("وسيط الزبون — ولا بالمكتبة ولا بالمنتقيات ولا برابط عام", () => {
  it("قائمة المكتبة (ونفس المسار للمنتقيات) ما بتعرضه", async () => {
    await seedCustomerMedia();
    await uploadMedia(db as Db, { userId: "u1", workspaceId: WS }, {
      filename: "brand.png", mimeType: "image/png", size: PNG.byteLength, data: PNG,
      category: "BRAND", title: "شعار",
    });
    const all = await listMedia(db as Db, { workspaceId: WS, limit: 50 });
    expect(all.items.map((a) => a.title)).toEqual(["شعار"]);
    // ولا لو حدا طلب التصنيف صريح من الواجهة.
    const asked = await listMedia(db as Db, { workspaceId: WS, category: "CUSTOMER_INBOUND" as never, limit: 50 });
    expect(asked.items).toEqual([]);
    const byType = await listMedia(db as Db, { workspaceId: WS, type: "IMAGE" as never, limit: 50 });
    expect(byType.items.map((a) => a.title)).toEqual(["شعار"]);
  });

  it("رابط عام (المسار الي بيبعت لميتا): مرفوض صريح", async () => {
    const { asset } = await seedCustomerMedia();
    await expect(generatePublicMediaUrl(db as Db, WS, String(asset.id))).rejects.toMatchObject({
      code: "CUSTOMER_INBOUND_NOT_PUBLISHABLE",
    });
  });
});

describe("وسيط الزبون — مدة الاحتفاظ", () => {
  it("بلا إعداد = 180 يوم · غلط = 180 · `0` = مطفي", () => {
    expect(waMediaRetentionDays()).toBe(DEFAULT_WA_MEDIA_RETENTION_DAYS);
    expect(DEFAULT_WA_MEDIA_RETENTION_DAYS).toBe(180);
    process.env.WA_MEDIA_RETENTION_DAYS = "nope";
    expect(waMediaRetentionDays()).toBe(180);
    process.env.WA_MEDIA_RETENTION_DAYS = "0";
    expect(waMediaRetentionDays()).toBe(0);
  });

  it("بعد المدة: الملف بينحذف والصف بينشال والرسالة بتحتفظ بعلامة", async () => {
    const { asset, messageId } = await seedCustomerMedia();
    const key = String(asset.storageKey);
    expect(existsSync(join(tmp, key))).toBe(true);
    const later = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000);
    const res = await purgeOldCustomerMedia(db as Db, later);
    expect(res.deleted).toBe(1);
    expect(existsSync(join(tmp, key))).toBe(false);
    expect((db._stores.mediaAsset as unknown[]).length).toBe(0);
    const msg = (db._stores.message as Record<string, unknown>[]).find((m) => m.id === messageId)!;
    expect(msg.mediaUrl ?? null).toBeNull();
    expect(msg.metadata).toMatchObject({ waMediaExpiredAt: later.toISOString() });
  });

  it("جوّا المدة: ولا ملف بينلمس", async () => {
    const { asset } = await seedCustomerMedia();
    expect((await purgeOldCustomerMedia(db as Db, new Date())).deleted).toBe(0);
    expect(existsSync(join(tmp, String(asset.storageKey)))).toBe(true);
  });

  it("`0` = الكنس مطفي حتى لو الوسيط قديم", async () => {
    process.env.WA_MEDIA_RETENTION_DAYS = "0";
    const { asset } = await seedCustomerMedia();
    const later = new Date(Date.now() + 5000 * 24 * 60 * 60 * 1000);
    expect(await purgeOldCustomerMedia(db as Db, later)).toMatchObject({ deleted: 0, disabled: true });
    expect(existsSync(join(tmp, String(asset.storageKey)))).toBe(true);
  });

  it("وسيط منتج عادي ما بينحذف بالكنس أبدًا", async () => {
    await uploadMedia(db as Db, { userId: "u1", workspaceId: WS }, {
      filename: "brand.png", mimeType: "image/png", size: PNG.byteLength, data: PNG,
      category: "BRAND", title: "شعار",
    });
    const later = new Date(Date.now() + 5000 * 24 * 60 * 60 * 1000);
    expect((await purgeOldCustomerMedia(db as Db, later)).deleted).toBe(0);
    expect((db._stores.mediaAsset as unknown[]).length).toBe(1);
    expect(getStorage()).toBeTruthy();
  });
});
