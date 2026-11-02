import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import nodeCrypto from "node:crypto";
import { createFakeDb } from "./helpers/inmemory-db";
import { decryptSecret } from "@/core/crypto";
import type { Db } from "@/modules/customers/service";
import { saveIntegrationConnection, setIntegrationDnsLookup } from "@/modules/integrations/connections";
import { setSystemFetch } from "@/modules/integrations/http";
import { findPii } from "@/modules/integrations/pii-guard";
import { conversationRef } from "@/modules/integrations/format";
import { EVENT_SCHEMAS, emitIntegrationEvent } from "@/modules/integrations/outbox";
import {
  MAX_ATTRIBUTION_AGE_DAYS,
  attributionCandidates,
  captureAttribution,
  codeLooksReal,
  detectCodeInText,
  markCodeVerification,
  normalizeCode,
  resolveOrderAttribution,
  snapshotOrderAttribution,
  type InboundReferral,
} from "@/modules/integrations/attribution";
import { onInboundCustomerMessage, parseReferral, safeReferralForStorage } from "@/modules/integrations/inbound-hooks";
import { captureReferralSignals } from "@/modules/integrations/referral-signals";
import { applyOptOut, getCustomerMarketingView, isOptOutMessage, setMarketingConsent } from "@/modules/integrations/consent";
import {
  afterCodeCaptured,
  buildRetargetCampaign,
  createRetargetCampaign,
  emitOptOutIfCoded,
  emitRetargetResult,
  getRetargetCampaign,
  parseRetargetCampaignId,
  retargetCampaignId,
  retargetCounts,
  retargetStatus,
  segmentForRetarget,
  validateCodeTouch,
  type RetargetRequest,
} from "@/modules/integrations/clipper";
import { normalizeWhatsAppWebhook } from "@/modules/channels/whatsapp/normalizer";
import { WhatsAppChannelAdapter } from "@/modules/channels/whatsapp/adapter";
import { extractFacebookReferralSignals, normalizeFacebookWebhook, normalizeMetaReferral, type MetaWebhookPayload } from "@/modules/channels/facebook/normalizer";
import { normalizeInstagramWebhook } from "@/modules/channels/instagram/normalizer";
import { handleChannelInbound } from "@/modules/channels/inbound-job";
import { processIncomingMessage, postNote } from "@/modules/conversations/service";
import { SEGMENT_VERSION, segmentDefinitionSchema } from "@/modules/campaigns/segment-schemas";
import { evaluateSegment, frequencyCapDays } from "@/modules/campaigns/segment-service";

/**
 * P12 — الإسناد («بداية المحادثة بتحكم») · الإحالات من القنوات · موافقة
 * التسويق · حملات إعادة التواصل من الكليبر · شرائح الكليبر الجديدة.
 */

const WS = "ws-p12-attr";
const WS_B = "ws-p12-attr-b";
const ctx = { userId: "agent-1", workspaceId: WS };
const DAY = 24 * 3600_000;
const HOUR = 3600_000;
const CLID = "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0";

beforeAll(() => setIntegrationDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]));
afterAll(() => setIntegrationDnsLookup(null));
afterEach(() => setSystemFetch(null));

type FakeDb = ReturnType<typeof createFakeDb>;
type Row = Record<string, any>;
const asDb = (db: FakeDb) => db as unknown as Db;

function fake(settings: Record<string, unknown> = {}): FakeDb {
  const db = createFakeDb();
  db._stores.workspace.push(
    { id: WS, name: "Zaki", slug: "zaki", timezone: "Asia/Amman", integrationSettings: settings },
    { id: WS_B, name: "Other", slug: "other", timezone: "UTC", integrationSettings: {} }
  );
  // معرّفات Prisma الحقيقية cuid (حروف صغيرة وأرقام) — rep_rt_<id> وعقد retarget.result يفترضانها.
  const baseCreate = db.campaign.create.bind(db.campaign);
  (db.campaign as Row).create = (args: Row) => baseCreate({ ...args, data: { id: `c${nodeCrypto.randomBytes(12).toString("hex")}`, ...args.data } } as never);
  return db;
}

let n = 0;
async function seedConv(db: FakeDb, o: { channelType?: string; ws?: string; customer?: Row; ext?: string } = {}) {
  n += 1;
  const ws = o.ws ?? WS;
  const type = o.channelType ?? "WHATSAPP";
  const customer = (await db.customer.create({ data: { workspaceId: ws, name: `زبون ${n}`, ...(o.customer ?? {}) } } as never)) as Row;
  let channel = db._stores.channel.find((c) => c.workspaceId === ws && c.type === type);
  if (!channel) channel = (await db.channel.create({ data: { workspaceId: ws, type, status: "CONNECTED", displayName: type, externalId: `acct-${type}-${ws}` } } as never)) as Row;
  const ext = o.ext ?? `ext-${n}`;
  await db.channelIdentity.create({ data: { workspaceId: ws, customerId: customer.id, channelType: type, channelExternalId: ext } } as never);
  const conversation = (await db.conversation.create({
    data: { workspaceId: ws, customerId: customer.id, channelId: channel.id, channelConversationId: ext, lastCustomerMessageAt: new Date() },
  } as never)) as Row;
  return { customer, channel, conversation, ext };
}

const AD = (adId = "120211000000000001", extra: Partial<InboundReferral> = {}): InboundReferral => ({
  source: "wa_referral",
  adId,
  adSourceType: "ad",
  ctwaClid: CLID,
  wabaId: "waba-1",
  ...extra,
});

async function capture(db: FakeDb, s: { customer: Row; conversation: Row }, o: { at: Date; key: string; referral?: InboundReferral | null; text?: string | null; channelType?: string; externalUserId?: string }) {
  return captureAttribution(asDb(db), {
    workspaceId: s.conversation.workspaceId,
    customerId: s.customer.id,
    conversationId: s.conversation.id,
    channelType: o.channelType ?? "WHATSAPP",
    eventKey: o.key,
    text: o.text ?? null,
    referral: o.referral ?? null,
    externalUserId: o.externalUserId ?? null,
    occurredAt: o.at,
  });
}

const touchRows = (db: FakeDb) => db._stores.attributionTouch;
const deliveries = (db: FakeDb, type?: string) => db._stores.integrationDelivery.filter((d) => !type || d.type === type);
const bodyOf = (row: Row) => JSON.parse(row.body) as { event_id: string; type: string; occurred_at: string; data: Row };

async function connectClipper(db: FakeDb) {
  const { generatedEventsSecret } = await saveIntegrationConnection(asDb(db), ctx, "clipper", {
    baseUrl: "https://clipper.zakai.io",
    token: "clipper-token-123456",
    generateEventsSecret: true,
  });
  return generatedEventsSecret!;
}

// ───────────────────────────── كشف الرمز من النص ─────────────────────────────

describe("P12 detectCodeInText — كلمة مفتاحية صريحة إلزامية", () => {
  it.each([
    ["رمز K7Q2", "K7Q2"],
    ["الرمز: K7Q2", "K7Q2"],
    ["كود k7q2", "K7Q2"],
    ["الكود #AB12", "AB12"],
    ["code K7Q2", "K7Q2"],
    ["Ref: Z9X1.", "Z9X1"],
    ["مرحبا، رمز K٧Q٢ من فضلك", "K7Q2"],
    ["(رمز K7Q2)", "K7Q2"],
  ])("«%s» = %s", (text, code) => {
    expect(detectCodeInText(text, "WHATSAPP")).toEqual({ code, source: "text_code" });
  });

  it.each([
    ["K7Q2"], // كلمة عارية بلا كلمة مفتاحية
    ["مرحبا K7Q2 بدي اطلب"],
    ["barcode K7Q2"], // الكلمة المفتاحية جزء من كلمة
    ["مرمز K7Q2"],
    ["رمز AB1"], // أقصر من 4
    ["رمز ABCDEFGHIJKLM"], // أطول من 12
    ["رمز K7-Q2"],
    [""],
  ])("لا رمز: «%s»", (text) => {
    expect(detectCodeInText(text, "WHATSAPP")).toBeNull();
  });

  it("رسالة أطول من 300 حرف = كلام لا رابط رمز", () => {
    expect(detectCodeInText(`رمز K7Q2 ${"ب".repeat(300)}`, "WHATSAPP")).toBeNull();
    expect(detectCodeInText(`رمز K7Q2 ${"ب".repeat(250)}`, "WHATSAPP")).toEqual({ code: "K7Q2", source: "text_code" });
  });

  it("تيليجرام: /start K7Q2 (وref_ / code_) — وعلى قناة أخرى /start لا يكفي", () => {
    expect(detectCodeInText("/start K7Q2", "TELEGRAM")).toEqual({ code: "K7Q2", source: "tg_start" });
    expect(detectCodeInText("/start ref_k7q2", "TELEGRAM")).toEqual({ code: "K7Q2", source: "tg_start" });
    expect(detectCodeInText("/start code-K7Q2", "TELEGRAM")).toEqual({ code: "K7Q2", source: "tg_start" });
    expect(detectCodeInText("/start", "TELEGRAM")).toBeNull();
    expect(detectCodeInText("/start K7Q2", "WHATSAPP")).toBeNull();
  });

  it("normalizeCode / codeLooksReal: حرف ورقم معًا = رمز حقيقي الشكل", () => {
    expect(normalizeCode(" k7q2 ")).toBe("K7Q2");
    // أرقام بس = مش رمز (ممكن رقم هاتف) — ما بينلقط ولا بينبعت للكليبر بالرابط.
    expect(normalizeCode("١٢٣٤")).toBeNull();
    expect(normalizeCode("0936654998")).toBeNull();
    expect(detectCodeInText("كود 0936654998")).toBeNull();
    expect(normalizeCode("k٧q٢")).toBe("K7Q2");
    expect(normalizeCode("K7")).toBeNull();
    expect(normalizeCode("K7-Q2")).toBeNull();
    expect(codeLooksReal("K7Q2")).toBe(true);
    expect(codeLooksReal("ABCD")).toBe(false);
    expect(codeLooksReal("1234")).toBe(false);
  });

  it("attributionCandidates: إعلان واتساب + رمز صريح = لمستين · ref رابط برمز = CODE · ref غير رمز = لا شيء", () => {
    const both = attributionCandidates({ channelType: "WHATSAPP", text: "رمز K7Q2", referral: AD("1202", { adSourceType: "AD" }) });
    expect(both.map((c) => c.kind)).toEqual(["AD", "CODE"]);
    expect(both[0]).toMatchObject({ adId: "1202", adSourceType: "ad", ctwaClid: CLID, wabaId: "waba-1" });
    const link = attributionCandidates({ channelType: "FACEBOOK", referral: { source: "fb_ref_link", ref: "k7q2", pageId: "PAGE-1" } });
    expect(link).toEqual([{ kind: "CODE", source: "fb_ref_link", refCode: "K7Q2", pageId: "PAGE-1" }]);
    expect(attributionCandidates({ channelType: "FACEBOOK", referral: { source: "fb_ref_link", ref: "summer-sale!" } })).toEqual([]);
    expect(attributionCandidates({ channelType: "WHATSAPP", text: "مرحبا" })).toEqual([]);
  });
});

// ───────────────────────── الحلقات: بداية المحادثة بتحكم ─────────────────────────

describe("P12 captureAttribution — «بداية المحادثة بتحكم»", () => {
  const T0 = new Date("2026-10-01T09:00:00.000Z");
  const at = (ms: number) => new Date(T0.getTime() + ms);

  it("أول لمسة تفتح حلقة، والتالية داخل النافذة (7 أيام افتراضيًا) لا تسرقها، وبعدها حلقة جديدة", async () => {
    const db = fake();
    const s = await seedConv(db);
    expect((await capture(db, s, { at: T0, key: "e1", referral: AD("AD-1") }))[0].episodeStart).toBe(true);
    expect((await capture(db, s, { at: at(6 * DAY), key: "e2", referral: AD("AD-2") }))[0].episodeStart).toBe(false);
    // النافذة تُقاس من بداية الحلقة لا من آخر لمسة.
    expect((await capture(db, s, { at: at(7 * DAY + 60_000), key: "e3", referral: AD("AD-3") }))[0].episodeStart).toBe(true);
    expect(touchRows(db).map((t) => [t.adId, t.episodeStart])).toEqual([
      ["AD-1", true],
      ["AD-2", false],
      ["AD-3", true],
    ]);
  });

  it("نافذة الإسناد من إعدادات المساحة (attributionWindowDays)", async () => {
    const db = fake({ attributionWindowDays: 2 });
    const s = await seedConv(db);
    await capture(db, s, { at: T0, key: "e1", referral: AD("AD-1") });
    expect((await capture(db, s, { at: at(DAY), key: "e2", referral: AD("AD-2") }))[0].episodeStart).toBe(false);
    expect((await capture(db, s, { at: at(3 * DAY), key: "e3", referral: AD("AD-3") }))[0].episodeStart).toBe(true);
  });

  it("رمز حقيقي الشكل يفتح حلقة ويمنع إعلانًا بعده من السرقة؛ رمز حروف/أرقام فقط لا يفتح حلقة", async () => {
    const db = fake();
    const s = await seedConv(db);
    const [code] = await capture(db, s, { at: T0, key: "c1", text: "رمز K7Q2" });
    expect(code).toMatchObject({ kind: "CODE", refCode: "K7Q2", episodeStart: true });
    expect((await capture(db, s, { at: at(HOUR), key: "a1", referral: AD() }))[0].episodeStart).toBe(false);

    const db2 = fake();
    const s2 = await seedConv(db2);
    expect(await capture(db2, s2, { at: T0, key: "c1", text: "كود 1234" })).toEqual([]);
    expect((await capture(db2, s2, { at: at(HOUR), key: "c2", text: "code ABCD" }))[0]).toMatchObject({ refCode: "ABCD", episodeStart: false });
    // رقم عابر/كلمة بلا كلمة مفتاحية لا تُلتقط أصلًا، والإعلان بعدها يفتح الحلقة.
    expect(await capture(db2, s2, { at: at(2 * HOUR), key: "w1", text: "K7Q2" })).toEqual([]);
    expect((await capture(db2, s2, { at: at(3 * HOUR), key: "a1", referral: AD() }))[0].episodeStart).toBe(true);
    expect(touchRows(db2).every((t) => t.codeStatus === null || t.codeStatus === "UNVERIFIED")).toBe(true);
  });

  it("إعادة إرسال نفس الحدث = لا لمسة مكررة (dedupeKey)", async () => {
    const db = fake();
    const s = await seedConv(db);
    expect(await capture(db, s, { at: T0, key: "same", referral: AD() })).toHaveLength(1);
    expect(await capture(db, s, { at: T0, key: "same", referral: AD() })).toEqual([]);
    expect(touchRows(db)).toHaveLength(1);
  });

  it("رمز النقرة مشفّر فقط؛ PSID لماسنجر مشفّر؛ رقم واتساب لا يُخزّن أبدًا كـ PSID", async () => {
    const db = fake();
    const wa = await seedConv(db, { ext: "963930000001" });
    await capture(db, wa, { at: T0, key: "w", referral: AD(), externalUserId: "963930000001" });
    const waRow = touchRows(db)[0];
    expect(decryptSecret(waRow.ctwaClidEnc)).toBe(CLID);
    expect(waRow.psidEnc).toBeNull();
    expect(JSON.stringify(waRow)).not.toContain(CLID);
    expect(JSON.stringify(waRow)).not.toContain("963930000001");

    const fb = await seedConv(db, { channelType: "FACEBOOK", ext: "PSID-777001" });
    await capture(db, fb, {
      at: T0,
      key: "f",
      channelType: "FACEBOOK",
      referral: { source: "fb_referral", adId: "AD-FB", adSourceType: "ad", ref: null, pageId: "PAGE-1" },
      externalUserId: "PSID-777001",
    });
    const fbRow = touchRows(db)[1];
    expect(fbRow).toMatchObject({ channel: "messenger", kind: "AD", adId: "AD-FB", pageId: "PAGE-1" });
    expect(decryptSecret(fbRow.psidEnc)).toBe("PSID-777001");
    expect(JSON.stringify(fbRow)).not.toContain("PSID-777001");
    // لمسة رمز لا تحمل PSID (تقليل البيانات).
    await capture(db, fb, { at: T0, key: "f2", channelType: "FACEBOOK", text: "رمز K7Q2", externalUserId: "PSID-777001" });
    expect(touchRows(db)[2]).toMatchObject({ kind: "CODE", psidEnc: null });
  });

  it("لا يرمي أبدًا (فشل الكتابة يُسجّل ويرجّع [])", async () => {
    const db = fake();
    const s = await seedConv(db);
    (db.attributionTouch as Row).create = async () => {
      throw new Error("db down");
    };
    await expect(capture(db, s, { at: T0, key: "x", referral: AD() })).resolves.toEqual([]);
  });
});

describe("P12 markCodeVerification — الرمز المرفوض لا يبقى بداية حلقة", () => {
  const T0 = new Date("2026-10-01T09:00:00.000Z");

  it("INVALID يُسقط بداية الحلقة، فإعلان بعده يفتح حلقة جديدة", async () => {
    const db = fake();
    const s = await seedConv(db);
    const [code] = await capture(db, s, { at: T0, key: "c", text: "رمز K7Q2" });
    await markCodeVerification(asDb(db), code.id, { valid: false });
    expect(touchRows(db)[0]).toMatchObject({ codeStatus: "INVALID", episodeStart: false });
    expect((await capture(db, s, { at: new Date(T0.getTime() + 2 * HOUR), key: "a", referral: AD() }))[0].episodeStart).toBe(true);
    expect((await resolveOrderAttribution(asDb(db), { workspaceId: WS, conversationId: s.conversation.id, at: new Date(T0.getTime() + 3 * HOUR) })).method).toBe("AD");
  });

  it("INVALID لرمز كان فاتح حلقة: أول إعلان بعده (كان محجوب) بيصير بداية الحلقة — الطلب ما بيضيع بلا إسناد", async () => {
    const db = fake();
    const s = await seedConv(db);
    const [code] = await capture(db, s, { at: T0, key: "c", text: "رمز K7Q2" });
    expect(code.episodeStart).toBe(true);
    const [ad] = await capture(db, s, { at: new Date(T0.getTime() + HOUR), key: "a", referral: AD("AD-77") });
    expect(ad.episodeStart).toBe(false);
    await markCodeVerification(asDb(db), code.id, { valid: false });
    const rows = touchRows(db);
    expect(rows.find((t) => t.id === code.id)).toMatchObject({ codeStatus: "INVALID", episodeStart: false });
    expect(rows.find((t) => t.id === ad.id)).toMatchObject({ episodeStart: true });
    const attr = await resolveOrderAttribution(asDb(db), { workspaceId: WS, conversationId: s.conversation.id, at: new Date(T0.getTime() + 2 * HOUR) });
    expect(attr).toMatchObject({ method: "AD", adId: "AD-77" });
  });

  it("VALID لرمز ما بيشبه رمز (حروف بس) يفتح الحلقة الآن (إذا ما في حلقة مفتوحة قبله ولا بعده) ويحفظ تفاصيل الكليبر", async () => {
    const db = fake();
    const s = await seedConv(db);
    const [code] = await capture(db, s, { at: T0, key: "c", text: "كود ABCD" });
    expect(code.episodeStart).toBe(false);
    const updated = await markCodeVerification(asDb(db), code.id, { valid: true, productCode: "TW-500", campaignRef: "cmp_9", windowDays: 14 });
    expect(updated).toMatchObject({ episodeStart: true, codeStatus: "VALID", codeProductCode: "TW-500", codeCampaignRef: "cmp_9", codeWindowDays: 14 });
  });

  it("VALID لا يفتح حلقة إذا كانت حلقة إعلان مفتوحة لحظته أو بدأت حلقة بعده", async () => {
    const db = fake();
    const s = await seedConv(db);
    await capture(db, s, { at: T0, key: "a", referral: AD() });
    const [c1] = await capture(db, s, { at: new Date(T0.getTime() + HOUR), key: "c1", text: "كود ABCD" });
    expect((await markCodeVerification(asDb(db), c1.id, { valid: true }))!.episodeStart).toBe(false);

    const db2 = fake();
    const s2 = await seedConv(db2);
    const [c2] = await capture(db2, s2, { at: T0, key: "c2", text: "كود WXYZ" });
    await capture(db2, s2, { at: new Date(T0.getTime() + HOUR), key: "a2", referral: AD() });
    expect((await markCodeVerification(asDb(db2), c2.id, { valid: true }))!.episodeStart).toBe(false);
  });
});

describe("P12 resolveOrderAttribution / snapshotOrderAttribution", () => {
  const T0 = new Date("2026-09-01T09:00:00.000Z");
  const at = (days: number) => new Date(T0.getTime() + days * DAY);

  it("آخر بداية حلقة صالحة عند لحظة الطلب أو قبلها", async () => {
    const db = fake();
    const s = await seedConv(db);
    await capture(db, s, { at: T0, key: "a1", referral: AD("AD-1") });
    await capture(db, s, { at: at(8), key: "a2", referral: AD("AD-2") });
    const r = (d: number) => resolveOrderAttribution(asDb(db), { workspaceId: WS, conversationId: s.conversation.id, at: at(d) });
    expect((await r(9)).adId).toBe("AD-2");
    expect((await r(5)).adId).toBe("AD-1"); // لمسة بعد الطلب لا تُحسب له
    expect((await r(-1)).method).toBe("NONE");
    const ad = await r(9);
    expect(ad).toMatchObject({ method: "AD", channel: "whatsapp", adSourceType: "ad", wabaId: "waba-1", refCode: null, refCodeAt: null });
    expect(decryptSecret(ad.ctwaClidEnc!)).toBe(CLID);
    expect(ad.touchAt!.toISOString()).toBe(at(8).toISOString());
  });

  it(`أقدم من ${MAX_ATTRIBUTION_AGE_DAYS} يوم = NONE بلا تخمين`, async () => {
    const db = fake();
    const s = await seedConv(db);
    await capture(db, s, { at: T0, key: "a1", referral: AD() });
    const r = (d: number) => resolveOrderAttribution(asDb(db), { workspaceId: WS, conversationId: s.conversation.id, at: at(d) });
    expect((await r(27)).method).toBe("AD");
    expect((await r(29)).method).toBe("NONE");
  });

  it("حلقة رمز = CODE بالرمز ووقته · محادثة مساحة أخرى أو بلا محادثة = NONE", async () => {
    const db = fake();
    const s = await seedConv(db);
    await capture(db, s, { at: T0, key: "c1", text: "رمز K7Q2" });
    const code = await resolveOrderAttribution(asDb(db), { workspaceId: WS, conversationId: s.conversation.id, at: at(1) });
    expect(code).toMatchObject({ method: "CODE", refCode: "K7Q2", adId: null, ctwaClidEnc: null, psidEnc: null });
    expect(code.refCodeAt!.toISOString()).toBe(T0.toISOString());
    expect((await resolveOrderAttribution(asDb(db), { workspaceId: WS_B, conversationId: s.conversation.id, at: at(1) })).method).toBe("NONE");
    expect((await resolveOrderAttribution(asDb(db), { workspaceId: WS, conversationId: null, at: at(1) })).method).toBe("NONE");
  });

  it("snapshotOrderAttribution يكتب اللقطة على الطلب (القناة من نوع القناة إذا ما في لمسة)", async () => {
    const db = fake();
    const s = await seedConv(db, { channelType: "INSTAGRAM" });
    const order = (await db.order.create({ data: { workspaceId: WS, orderNumber: "O-1", customerId: s.customer.id, conversationId: s.conversation.id } } as never)) as Row;
    const none = await snapshotOrderAttribution(asDb(db), { id: order.id, workspaceId: WS, conversationId: s.conversation.id, createdAt: at(1), channelType: "INSTAGRAM" });
    expect(none).toMatchObject({ method: "NONE", channel: "instagram" });
    expect(db._stores.order[0]).toMatchObject({ attributionMethod: "NONE", channel: "instagram", adId: null });
  });
});

// ─────────────────────── الإحالات من القنوات (المطبّعات) ───────────────────────

describe("P12 normalizers — إحالات واتساب/ماسنجر/إنستغرام", () => {
  it("واتساب: source_id = رقم الإعلان · ctwa_clid · WABA من entry.id — وبلا إحالة لا مفتاح referral", () => {
    const payload = {
      entry: [
        {
          id: "WABA-1001",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PN-1" },
                messages: [
                  { from: "963930000001", id: "wamid.1", timestamp: "1760160000", type: "text", text: { body: "مرحبا" }, referral: { source_url: "https://fb.me/x", source_id: "120211000000000001", source_type: "ad", ctwa_clid: CLID } },
                  { from: "963930000002", id: "wamid.2", timestamp: "1760160000", type: "text", text: { body: "هلا" } },
                  { from: "963930000003", id: "wamid.3", timestamp: "1760160000", type: "text", text: { body: "x" }, referral: { source_url: "https://fb.me/y" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const [a, b, c] = normalizeWhatsAppWebhook(payload, "wa:raw");
    expect(a.referral).toEqual({ source: "wa_referral", adId: "120211000000000001", adSourceType: "ad", ctwaClid: CLID, wabaId: "WABA-1001" });
    expect(b).not.toHaveProperty("referral");
    expect(c).not.toHaveProperty("referral");
  });

  it("ماسنجر: ad_id من الحدث أو الرسالة أو postback = fb_referral · ref وحده = fb_ref_link · لا هذا ولا ذاك = null", () => {
    const ev = (extra: Row) => ({ sender: { id: "PSID-1" }, recipient: { id: "PAGE-1" }, timestamp: 1760160000000, message: { mid: `m-${Math.random()}`, text: "مرحبا" }, ...extra });
    const payload: MetaWebhookPayload = {
      entry: [
        {
          id: "PAGE-1",
          messaging: [
            ev({ referral: { ad_id: "AD-9", ref: "K7Q2", source: "ADS", type: "OPEN_THREAD" } }),
            ev({ message: { mid: "m-in", text: "x", referral: { ad_id: "AD-10" } } }),
            ev({ postback: { referral: { ref: "Z9X1", source: "SHORTLINK" } } }),
            ev({}),
          ],
        },
      ],
    };
    const out = normalizeFacebookWebhook(payload, "acc-1", "PAGE-1", "fb:raw");
    expect(out[0].referral).toEqual({ source: "fb_referral", adId: "AD-9", adSourceType: "ad", ref: "K7Q2", pageId: "PAGE-1" });
    expect(out[1].referral).toMatchObject({ source: "fb_referral", adId: "AD-10" });
    expect(out[2].referral).toEqual({ source: "fb_ref_link", adId: null, adSourceType: null, ref: "Z9X1", pageId: "PAGE-1" });
    expect(out[3].referral).toBeNull();
    expect(normalizeMetaReferral({ ad_id: "  ", ref: "" }, "P", "fb")).toBeNull();
  });

  it("ماسنجر: إحالة بلا رسالة (messaging_referrals) = إشارة لمسة فقط — ولصفحتها فقط", () => {
    const payload: MetaWebhookPayload = {
      entry: [
        {
          id: "PAGE-1",
          messaging: [
            { sender: { id: "PSID-1" }, recipient: { id: "PAGE-1" }, timestamp: 1760160000000, referral: { ad_id: "AD-9", source: "ADS", type: "OPEN_THREAD" } },
            { sender: { id: "PSID-2" }, recipient: { id: "PAGE-1" }, timestamp: 1760160000000, message: { mid: "m1", text: "x" }, referral: { ad_id: "AD-9" } },
            { sender: { id: "PSID-3" }, recipient: { id: "PAGE-1" }, timestamp: 1760160000000 },
          ],
        },
        { id: "PAGE-OTHER", messaging: [{ sender: { id: "PSID-4" }, timestamp: 1, referral: { ad_id: "AD-1" } }] },
      ],
    };
    const signals = extractFacebookReferralSignals(payload, "PAGE-1", "fb:hash:abc");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ psid: "PSID-1", referral: { source: "fb_referral", adId: "AD-9", pageId: "PAGE-1" } });
    expect(signals[0].timestamp.toISOString()).toBe(new Date(1760160000000).toISOString());
  });

  it("إنستغرام: ad_id = ig_referral · ref = ig_ref_link (الصفحة من entry.id)", () => {
    const out = normalizeInstagramWebhook(
      {
        entry: [
          {
            id: "IG-1",
            messaging: [
              { sender: { id: "IGSID-1" }, timestamp: 1760160000000, message: { mid: "i1", text: "x" }, referral: { ad_id: "AD-IG" } },
              { sender: { id: "IGSID-2" }, timestamp: 1760160000000, message: { mid: "i2", text: "y", referral: { ref: "K7Q2" } } },
              { sender: { id: "IGSID-3" }, timestamp: 1760160000000, message: { mid: "i3", text: "z" } },
            ],
          },
        ],
      },
      "ig:raw"
    );
    expect(out[0].referral).toEqual({ source: "ig_referral", adId: "AD-IG", adSourceType: "ad", ref: null, pageId: "IG-1" });
    expect(out[1].referral).toEqual({ source: "ig_ref_link", adId: null, adSourceType: null, ref: "K7Q2", pageId: "IG-1" });
    expect(out[2]).not.toHaveProperty("referral");
  });

  it("parseReferral يقبل المصادر المسماة فقط · safeReferralForStorage يُسقط رمز النقرة", () => {
    expect(parseReferral({ referral: { source: "evil", adId: "1" } })).toBeNull();
    expect(parseReferral({ referral: "x" })).toBeNull();
    expect(parseReferral({})).toBeNull();
    expect(parseReferral({ referral: { source: "wa_referral", adId: " 12 ", ctwaClid: CLID } })).toMatchObject({ adId: "12", ctwaClid: CLID });
    const safe = safeReferralForStorage({ source: "wa_referral", adId: "12", adSourceType: "ad", ctwaClid: CLID, wabaId: "W", ref: null });
    expect(safe).toEqual({ source: "wa_referral", adId: "12", adSourceType: "ad", ref: null, pageId: null });
    expect(JSON.stringify(safe)).not.toContain(CLID);
  });
});

// ──────────────────── المسار الحي: رسالة واتساب من إعلان ────────────────────

describe("P12 inbound — رسالة أولى من إعلان «انقر للمراسلة» عبر المسار الحي", () => {
  async function waFirstMessage(db: FakeDb, text = "مرحبا بدي اسأل عن العرض") {
    const ch = (await db.channel.create({ data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "WA", externalId: "PN-1" } } as never)) as Row;
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1001",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PN-1" },
                messages: [
                  {
                    from: "963930000001",
                    id: "wamid.HBgM1",
                    timestamp: String(Math.floor(Date.now() / 1000) - 60),
                    type: "text",
                    text: { body: text },
                    referral: { source_url: "https://fb.me/1", source_id: "120211000000000001", source_type: "ad", ctwa_clid: CLID },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const messages = new WhatsAppChannelAdapter({ channelAccountId: "acc-1", channelId: ch.id }).receiveMessage(payload);
    expect(await handleChannelInbound(asDb(db), { workspaceId: WS, messages })).toEqual({ success: true });
  }

  it("لمسة إعلان مشفّرة + بيانات الرسالة بلا رمز النقرة + مصدر الزبون الأول + سجلات نظيفة", async () => {
    const db = fake();
    await waFirstMessage(db);
    const [t] = touchRows(db);
    expect(t).toMatchObject({ kind: "AD", channel: "whatsapp", source: "wa_referral", adId: "120211000000000001", adSourceType: "ad", wabaId: "WABA-1001", episodeStart: true, psidEnc: null });
    expect(decryptSecret(t.ctwaClidEnc)).toBe(CLID);
    const msg = db._stores.message.find((m) => m.direction === "INBOUND")!;
    expect(msg.metadata.referral).toEqual({ source: "wa_referral", adId: "120211000000000001", adSourceType: "ad", ref: null, pageId: null });
    expect(JSON.stringify(msg)).not.toContain(CLID);
    expect(JSON.stringify(db._stores.auditLog)).not.toContain(CLID);
    expect(JSON.stringify(db._stores.attributionTouch)).not.toContain(CLID);
    expect(db._stores.customer[0].adSource).toBe("ad:120211000000000001");
  });

  // BUG (src/modules/conversations/inbound.ts:56): processIncomingMessage يمرّر
  // input.metadata الخام (فيها referral.ctwaClid) لـ resolveCustomerByChannelIdentity
  // قبل التنقية (storedMetadata بالأسطر 200-205)، وزبون جديد يُنشأ بـ
  // ChannelIdentity.metadata = metadata كما هي (customers/service.ts:92) → رمز النقرة
  // محفوظ نصًا صريحًا. (ظهور "customer" بالنتيجة = نسخة الـ fake للإنشاء المتداخل لنفس الصف.)
  it("رمز النقرة لا يُحفظ نصًا صريحًا بأي جدول (ولا metadata هوية القناة لزبون جديد)", async () => {
    const db = fake();
    await waFirstMessage(db);
    const leaks = Object.entries(db._stores)
      .filter(([, rows]) => JSON.stringify(rows).includes(CLID))
      .map(([name]) => name);
    expect(leaks).toEqual([]);
  });

  it("رمز صريح بالرسالة + كليبر مربوط = مهمة تحقق بمفتاح ثابت؛ بلا كليبر = لا مهمة", async () => {
    const db = fake();
    await connectClipper(db);
    const r = await processIncomingMessage(asDb(db), {
      workspaceId: WS,
      channelType: "WHATSAPP",
      externalUserId: "963930000009",
      externalConversationId: "963930000009",
      externalMessageId: "wamid.c1",
      externalEventId: "wa:c1",
      provider: "whatsapp",
      type: "TEXT",
      text: "مرحبا رمز K7Q2",
    });
    const [t] = touchRows(db);
    expect(t).toMatchObject({ kind: "CODE", refCode: "K7Q2", codeStatus: "UNVERIFIED", conversationId: r.conversationId, episodeStart: true });
    const job = db._stores.backgroundJob.find((j) => j.type === "validate_attribution_code")!;
    expect(job).toMatchObject({ payload: { touchId: t.id }, idempotencyKey: `code-validate:${t.id}` });
    expect(db._stores.customer[0].adSource).toBe("code:K7Q2");

    const db2 = fake();
    await processIncomingMessage(asDb(db2), {
      workspaceId: WS,
      channelType: "WHATSAPP",
      externalUserId: "963930000010",
      externalConversationId: "963930000010",
      externalMessageId: "wamid.c2",
      externalEventId: "wa:c2",
      provider: "whatsapp",
      type: "TEXT",
      text: "رمز K7Q2",
    });
    expect(touchRows(db2)).toHaveLength(1);
    expect(db2._stores.backgroundJob.filter((j) => j.type === "validate_attribution_code")).toHaveLength(0);
  });

  it("ماسنجر: الإحالة من المطبّع تمر للمعالج وتُسجّل لمسة إعلان مع PSID مشفّر", async () => {
    const db = fake();
    const payload: MetaWebhookPayload = {
      entry: [{ id: "PAGE-1", messaging: [{ sender: { id: "PSID-55" }, recipient: { id: "PAGE-1" }, timestamp: Date.now(), message: { mid: "mid.1", text: "مرحبا" }, referral: { ad_id: "AD-FB-1", source: "ADS", type: "OPEN_THREAD" } }] }],
    };
    const [m] = normalizeFacebookWebhook(payload, "acc-1", "PAGE-1", "fb:mid.1");
    await processIncomingMessage(asDb(db), {
      workspaceId: WS,
      channelType: "FACEBOOK",
      externalUserId: m.externalCustomerId,
      externalConversationId: m.externalConversationId,
      externalMessageId: m.externalMessageId,
      externalEventId: m.externalEventId,
      provider: "facebook",
      type: "TEXT",
      text: m.text,
      // نفس شكل metadata بـ handlers.ts (process_webhook_event).
      metadata: { channelAccountId: "acc-1", attachments: [], adRef: m.adRef ?? null, ...(m.referral ? { referral: m.referral } : {}) },
    });
    const [t] = touchRows(db);
    expect(t).toMatchObject({ kind: "AD", channel: "messenger", adId: "AD-FB-1", pageId: "PAGE-1", source: "fb_referral" });
    expect(decryptSecret(t.psidEnc)).toBe("PSID-55");
    expect(JSON.stringify(t)).not.toContain("PSID-55");
  });
});

describe("P12 captureReferralSignals — إحالة بلا رسالة لزبون قائم", () => {
  it("تُسجّل لمسة على محادثته القائمة، ولا تُنشئ محادثات لمجهول", async () => {
    const db = fake();
    const s = await seedConv(db, { channelType: "FACEBOOK", ext: "PSID-1" });
    const payload: MetaWebhookPayload = {
      entry: [
        {
          id: "PAGE-1",
          messaging: [
            { sender: { id: "PSID-1" }, timestamp: Date.now(), referral: { ad_id: "AD-9", source: "ADS", type: "OPEN_THREAD" } },
            { sender: { id: "PSID-UNKNOWN" }, timestamp: Date.now(), referral: { ad_id: "AD-9" } },
          ],
        },
      ],
    };
    const signals = extractFacebookReferralSignals(payload, "PAGE-1", "fb:hash:abc") as unknown as Array<Record<string, unknown>>;
    const n = await captureReferralSignals(asDb(db), { workspaceId: WS, channelType: "FACEBOOK", signals });
    expect(n).toBe(1);
    expect(touchRows(db)).toHaveLength(1);
    expect(touchRows(db)[0]).toMatchObject({ conversationId: s.conversation.id, customerId: s.customer.id, adId: "AD-9", kind: "AD" });
    expect(decryptSecret(touchRows(db)[0].psidEnc)).toBe("PSID-1");
    expect(db._stores.conversation).toHaveLength(1);
    // نفس الإشارة مرتين = لمسة واحدة.
    expect(await captureReferralSignals(asDb(db), { workspaceId: WS, channelType: "FACEBOOK", signals })).toBe(0);
  });

  it("هوية بمساحة أخرى أو محادثة لزبون آخر = لا لمسة", async () => {
    const db = fake();
    await seedConv(db, { channelType: "FACEBOOK", ext: "PSID-B", ws: WS_B });
    const signals = [{ psid: "PSID-B", referral: { source: "fb_referral", adId: "AD-1", adSourceType: "ad", ref: null, pageId: "P" }, timestamp: new Date(), eventKey: "k1" }];
    expect(await captureReferralSignals(asDb(db), { workspaceId: WS, channelType: "FACEBOOK", signals })).toBe(0);
    expect(touchRows(db)).toHaveLength(0);
  });

  // BUG (src/modules/channels/facebook/normalizer.ts:153 eventKey =
  // `${rawEventId}:ref:${PSID}:${ts}` — وبديله referral-signals.ts:34 — ثم attribution.ts:223
  // dedupeKey = `${conversationId}:${kind}:${eventKey}`): الـ PSID يُخزّن نصًا صريحًا بعمود
  // AttributionTouch.dedupeKey، خلافًا لـ «PSID مشفّر فقط (psidEnc)».
  it("PSID لا يظهر نصًا صريحًا بأي عمود في AttributionTouch (ولا dedupeKey) لإحالة بلا رسالة", async () => {
    const db = fake();
    await seedConv(db, { channelType: "FACEBOOK", ext: "PSID-SECRET-42" });
    const payload: MetaWebhookPayload = {
      entry: [{ id: "PAGE-1", messaging: [{ sender: { id: "PSID-SECRET-42" }, timestamp: Date.now(), referral: { ad_id: "AD-9" } }] }],
    };
    const signals = extractFacebookReferralSignals(payload, "PAGE-1", "fb:hash:abc") as unknown as Array<Record<string, unknown>>;
    expect(await captureReferralSignals(asDb(db), { workspaceId: WS, channelType: "FACEBOOK", signals })).toBe(1);
    expect(JSON.stringify(touchRows(db))).not.toContain("PSID-SECRET-42");
  });
});

// ───────────────────────────── موافقة التسويق ─────────────────────────────

describe("P12 consent — الإلغاء أسهل من الاشتراك", () => {
  it.each(["ايقاف", "إيقاف", "إِيقاف", "ايقـاف", "STOP", " stop! ", "Stop.", "الغاء الاشتراك", "إلغاء الاشتراك", "unsubscribe", "ايقاف الرسائل", "لا ترسلوا", "توقف"])(
    "«%s» = إلغاء",
    (t) => expect(isOptOutMessage(t)).toBe(true)
  );

  it.each([
    "بدي ايقاف الطلب لو سمحت",
    "stop sending me this please",
    "ممكن إلغاء الاشتراك بالعرض التاني وبدي أطلب",
    "إلغاء",
    "لا",
    "",
    "ايقاف ".repeat(10),
  ])("«%s» ليست إلغاء (رسالة كاملة فقط)", (t) => expect(isOptOutMessage(t)).toBe(false));

  it("isOptOutMessage(null) = false", () => expect(isOptOutMessage(null)).toBe(false));

  it("applyOptOut: OPTED_OUT + وقت + مصدر + سجل، ومرة واحدة فقط", async () => {
    const db = fake();
    const s = await seedConv(db, { customer: { marketingConsent: "OPTED_IN" } });
    const res = await applyOptOut(asDb(db), { workspaceId: WS, customerId: s.customer.id, conversationId: s.conversation.id, channelType: "WHATSAPP", source: "CUSTOMER_KEYWORD" });
    expect(res).toEqual({ changed: true, consent: "OPTED_OUT" });
    const c = db._stores.customer[0];
    expect(c).toMatchObject({ marketingConsent: "OPTED_OUT", marketingConsentSource: "CUSTOMER_KEYWORD" });
    expect(c.marketingOptOutAt).toBeTruthy();
    expect(db._stores.auditLog.filter((a) => a.action === "customer.marketing_opted_out")).toHaveLength(1);
    expect(await applyOptOut(asDb(db), { workspaceId: WS, customerId: s.customer.id, source: "AGENT" })).toEqual({ changed: false, consent: "OPTED_OUT" });
    expect(db._stores.auditLog.filter((a) => a.action === "customer.marketing_opted_out")).toHaveLength(1);
    // زبون مساحة أخرى لا يُلمس.
    const other = await seedConv(db, { ws: WS_B });
    expect(await applyOptOut(asDb(db), { workspaceId: WS, customerId: other.customer.id, source: "AGENT" })).toEqual({ changed: false, consent: "UNKNOWN" });
    expect(db._stores.customer.find((x) => x.id === other.customer.id)!.marketingConsent).toBe("UNKNOWN");
  });

  it("رسالة «إيقاف» عبر المسار الحي تلغي فورًا · وكلمة داخل جملة لا تلغي", async () => {
    const db = fake();
    const base = { workspaceId: WS, channelType: "WHATSAPP" as const, externalUserId: "963930000020", externalConversationId: "963930000020", provider: "whatsapp", type: "TEXT" as const };
    await processIncomingMessage(asDb(db), { ...base, externalMessageId: "w1", externalEventId: "e1", text: "بدي ايقاف الطلب لو سمحت" });
    expect(db._stores.customer[0].marketingConsent).toBe("UNKNOWN");
    await processIncomingMessage(asDb(db), { ...base, externalMessageId: "w2", externalEventId: "e2", text: "إيقاف" });
    expect(db._stores.customer[0]).toMatchObject({ marketingConsent: "OPTED_OUT", marketingConsentSource: "CUSTOMER_KEYWORD" });
  });

  it("opt_out للكليبر فقط لزبون جه برمز (صالح/غير متحقق حقيقي الشكل) — بلا رمز أو برمز مرفوض = لا حدث", async () => {
    const db = fake();
    await connectClipper(db);
    const coded = await seedConv(db);
    await capture(db, coded, { at: new Date(Date.now() - HOUR), key: "c", text: "رمز K7Q2" });
    await applyOptOut(asDb(db), { workspaceId: WS, customerId: coded.customer.id, conversationId: coded.conversation.id, channelType: "WHATSAPP", source: "CUSTOMER_KEYWORD" });
    const rows = deliveries(db, "opt_out");
    expect(rows).toHaveLength(1);
    const data = bodyOf(rows[0]).data;
    expect(data).toEqual({ channel: "whatsapp", conversation_ref: conversationRef(coded.conversation.id), code: "K7Q2" });
    expect(EVENT_SCHEMAS.opt_out.safeParse(data).success).toBe(true);
    expect(findPii(data)).toEqual([]);

    const plain = await seedConv(db);
    await applyOptOut(asDb(db), { workspaceId: WS, customerId: plain.customer.id, conversationId: plain.conversation.id, channelType: "WHATSAPP", source: "CUSTOMER_KEYWORD" });
    const invalid = await seedConv(db);
    const [t] = await capture(db, invalid, { at: new Date(Date.now() - HOUR), key: "ci", text: "رمز Z9X1" });
    await markCodeVerification(asDb(db), t.id, { valid: false });
    await applyOptOut(asDb(db), { workspaceId: WS, customerId: invalid.customer.id, conversationId: invalid.conversation.id, channelType: "WHATSAPP", source: "CUSTOMER_KEYWORD" });
    const digits = await seedConv(db);
    await capture(db, digits, { at: new Date(Date.now() - HOUR), key: "cd", text: "كود 4321" });
    await applyOptOut(asDb(db), { workspaceId: WS, customerId: digits.customer.id, conversationId: digits.conversation.id, channelType: "WHATSAPP", source: "CUSTOMER_KEYWORD" });
    expect(deliveries(db, "opt_out")).toHaveLength(1);
    // emitOptOutIfCoded مباشرة: مفتاح يومي للزبون — لا تكرار بنفس اليوم.
    expect(await emitOptOutIfCoded(asDb(db), { workspaceId: WS, customerId: coded.customer.id, conversationId: coded.conversation.id, channel: "whatsapp" })).toBe(0);
  });

  it("setMarketingConsent: اشتراك صريح · بعد إلغاء سابق يحتاج reoptIn (409) · نفس الحالة = بلا تغيير", async () => {
    const db = fake();
    const s = await seedConv(db);
    expect(await setMarketingConsent(asDb(db), ctx, s.customer.id, { consent: "OPTED_IN" })).toEqual({ changed: true, consent: "OPTED_IN" });
    let c = db._stores.customer[0];
    expect(c).toMatchObject({ marketingConsent: "OPTED_IN", marketingConsentSource: "AGENT", marketingOptOutAt: null });
    expect(c.marketingConsentAt).toBeTruthy();
    expect(await setMarketingConsent(asDb(db), ctx, s.customer.id, { consent: "OPTED_IN" })).toEqual({ changed: false, consent: "OPTED_IN" });

    expect(await setMarketingConsent(asDb(db), ctx, s.customer.id, { consent: "OPTED_OUT" })).toEqual({ changed: true, consent: "OPTED_OUT" });
    const out = db._stores.auditLog.filter((a) => a.action === "customer.marketing_opted_out");
    expect(out[0]).toMatchObject({ userId: "agent-1", metadata: { source: "AGENT" } });

    await expect(setMarketingConsent(asDb(db), ctx, s.customer.id, { consent: "OPTED_IN" })).rejects.toMatchObject({
      code: "REOPT_IN_REQUIRES_CONFIRMATION",
      statusCode: 409,
    });
    expect(db._stores.customer[0].marketingConsent).toBe("OPTED_OUT");
    expect(await setMarketingConsent(asDb(db), ctx, s.customer.id, { consent: "OPTED_IN", reoptIn: true })).toEqual({ changed: true, consent: "OPTED_IN" });
    c = db._stores.customer[0];
    expect(c).toMatchObject({ marketingConsent: "OPTED_IN", marketingOptOutAt: null });
    expect(db._stores.auditLog.filter((a) => a.action === "customer.marketing_opted_in").map((a) => a.metadata.reoptIn)).toEqual([false, true]);
    // سجل قديم: موافقة غير معروفة لكن وقت إلغاء موجود = يحتاج تأكيد أيضًا.
    const legacy = await seedConv(db, { customer: { marketingOptOutAt: new Date() } });
    await expect(setMarketingConsent(asDb(db), ctx, legacy.customer.id, { consent: "OPTED_IN" })).rejects.toMatchObject({ code: "REOPT_IN_REQUIRES_CONFIRMATION" });
    const other = await seedConv(db, { ws: WS_B });
    await expect(setMarketingConsent(asDb(db), ctx, other.customer.id, { consent: "OPTED_IN" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("getCustomerMarketingView: الموافقة + آخر لمسة بلا الحقول المشفّرة", async () => {
    const db = fake();
    const s = await seedConv(db, { channelType: "FACEBOOK", ext: "PSID-9" });
    expect((await getCustomerMarketingView(asDb(db), WS, s.customer.id)).attribution).toBeNull();
    await capture(db, s, { at: new Date(Date.now() - 2 * HOUR), key: "a", channelType: "FACEBOOK", referral: { source: "fb_referral", adId: "AD-1", adSourceType: "ad", pageId: "P" }, externalUserId: "PSID-9" });
    await capture(db, s, { at: new Date(Date.now() - HOUR), key: "b", channelType: "FACEBOOK", referral: AD("AD-2", { source: "fb_referral", ctwaClid: null }), externalUserId: "PSID-9" });
    await setMarketingConsent(asDb(db), ctx, s.customer.id, { consent: "OPTED_IN" });
    const view = await getCustomerMarketingView(asDb(db), WS, s.customer.id);
    expect(view).toMatchObject({ consent: "OPTED_IN", consentSource: "AGENT", optOutAt: null });
    expect(Object.keys(view.attribution!).sort()).toEqual(["adId", "channel", "codeStatus", "kind", "occurredAt", "refCode", "source"]);
    expect(view.attribution).toMatchObject({ adId: "AD-2", kind: "AD", channel: "messenger" });
    const shown = JSON.stringify(view);
    for (const enc of touchRows(db).map((t) => t.psidEnc)) expect(shown).not.toContain(enc);
    expect(shown).not.toContain("PSID-9");
    await expect(getCustomerMarketingView(asDb(db), WS_B, s.customer.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ─────────────────────── الكليبر: تحقق الرمز و conversation.coded ───────────────────────

describe("P12 clipper — تحقق الرمز ثم conversation.coded مرة لكل حلقة", () => {
  type Call = { url: string; init: RequestInit };
  function stubClipper(res: () => Response | Promise<Response>): Call[] {
    const calls: Call[] = [];
    setSystemFetch((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return res();
    }) as unknown as typeof fetch);
    return calls;
  }

  it("رمز صالح: GET /api/v1/codes/{code} بالتوكن ← VALID بتفاصيله ← conversation.coded موقّع بالعقد", async () => {
    const db = fake();
    await connectClipper(db);
    const s = await seedConv(db);
    const [t] = await capture(db, s, { at: new Date(Date.now() - HOUR), key: "c", text: "رمز K7Q2" });
    const calls = stubClipper(() => Response.json({ valid: true, product_code: "TW-500", campaign_ref: "cmp_9", window_days: 14 }));
    expect(await validateCodeTouch(asDb(db), t.id)).toEqual({ success: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://clipper.zakai.io/api/v1/codes/K7Q2");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer clipper-token-123456");
    expect(h["x-request-id"]).toMatch(/^rep_[a-f0-9]{16}$/);
    expect(calls[0].init.redirect).toBe("manual");
    expect(touchRows(db)[0]).toMatchObject({ codeStatus: "VALID", codeProductCode: "TW-500", codeCampaignRef: "cmp_9", codeWindowDays: 14, episodeStart: true });
    const rows = deliveries(db, "conversation.coded");
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe(`${WS}:clipper:conversation.coded:coded:${t.id}`);
    const data = bodyOf(rows[0]).data;
    expect(data).toEqual({ code: "K7Q2", channel: "whatsapp", conversation_ref: conversationRef(s.conversation.id) });
    expect(EVENT_SCHEMAS["conversation.coded"].safeParse(data).success).toBe(true);
    // تحقق ثاني = لا نداء ولا حدث ثاني.
    expect(await validateCodeTouch(asDb(db), t.id)).toEqual({ success: true });
    expect(calls).toHaveLength(1);
    expect(deliveries(db, "conversation.coded")).toHaveLength(1);
  });

  it("404 أو valid:false = INVALID (لا حدث) · 5xx/انقطاع = إعادة المهمة والرمز يبقى غير متحقق", async () => {
    const db = fake();
    await connectClipper(db);
    const s = await seedConv(db);
    const [a] = await capture(db, s, { at: new Date(Date.now() - 3 * HOUR), key: "a", text: "رمز K7Q2" });
    stubClipper(() => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    expect(await validateCodeTouch(asDb(db), a.id)).toEqual({ success: true });
    expect(touchRows(db)[0]).toMatchObject({ codeStatus: "INVALID", episodeStart: false });

    const s2 = await seedConv(db);
    const [b] = await capture(db, s2, { at: new Date(Date.now() - HOUR), key: "b", text: "رمز Z9X1" });
    stubClipper(() => Response.json({ valid: false }));
    await validateCodeTouch(asDb(db), b.id);
    expect(touchRows(db).find((t) => t.id === b.id)).toMatchObject({ codeStatus: "INVALID" });

    const s3 = await seedConv(db);
    const [c] = await capture(db, s3, { at: new Date(Date.now() - HOUR), key: "c", text: "رمز Q1W2" });
    stubClipper(() => new Response("", { status: 503 }));
    expect(await validateCodeTouch(asDb(db), c.id)).toEqual({ success: false, error: "HTTP 503" });
    setSystemFetch((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect(await validateCodeTouch(asDb(db), c.id)).toEqual({ success: false, error: "NETWORK_ERROR" });
    expect(touchRows(db).find((t) => t.id === c.id)).toMatchObject({ codeStatus: "UNVERIFIED" });
    expect(deliveries(db, "conversation.coded")).toHaveLength(0);
  });

  it("رمز صالح لكنه ليس بداية حلقة (إعلان فتح المحادثة) = لا conversation.coded", async () => {
    const db = fake();
    await connectClipper(db);
    const s = await seedConv(db);
    await capture(db, s, { at: new Date(Date.now() - 2 * HOUR), key: "ad", referral: AD() });
    const [t] = await capture(db, s, { at: new Date(Date.now() - HOUR), key: "c", text: "رمز K7Q2" });
    stubClipper(() => Response.json({ valid: true }));
    await validateCodeTouch(asDb(db), t.id);
    expect(touchRows(db).find((x) => x.id === t.id)).toMatchObject({ codeStatus: "VALID", episodeStart: false });
    expect(deliveries(db, "conversation.coded")).toHaveLength(0);
  });

  it("كليبر غير مربوط: لا مهمة تحقق ولا نداء — والرمز يبقى غير متحقق", async () => {
    const db = fake();
    const s = await seedConv(db);
    const [t] = await capture(db, s, { at: new Date(), key: "c", text: "رمز K7Q2" });
    const calls = stubClipper(() => Response.json({ valid: true }));
    await afterCodeCaptured(asDb(db), WS, t.id);
    expect(db._stores.backgroundJob).toHaveLength(0);
    expect(await validateCodeTouch(asDb(db), t.id)).toEqual({ success: true });
    expect(calls).toHaveLength(0);
  });

  it("عقد الأحداث حرفي: conversation_ref حروف فقط (cv_[a-p]{12}) · حقل زائد أو مرجع بأرقام أو هاتف = لا كتابة", async () => {
    const db = fake();
    await connectClipper(db);
    const refs = Array.from({ length: 200 }, (_, i) => conversationRef(`c${nodeCrypto.randomBytes(12).toString("hex")}${i}`));
    for (const ref of refs) {
      expect(ref).toMatch(/^cv_[a-p]{12}$/);
      expect(findPii({ conversation_ref: ref, code: "K7Q2", channel: "whatsapp" })).toEqual([]);
    }
    const ok = { code: "K7Q2", channel: "whatsapp", conversation_ref: refs[0] };
    const emit = (data: Row, key: string) => emitIntegrationEvent(asDb(db), { workspaceId: WS, type: "conversation.coded", data, dedupeKey: key });
    expect(await emit({ ...ok, conversation_ref: "cv_0123456789ab" }, "k1")).toBe(0);
    expect(await emit({ ...ok, extra: 1 }, "k2")).toBe(0);
    expect(await emit({ ...ok, channel: "sms" }, "k3")).toBe(0);
    expect(await emit({ ...ok, code: "k7q2" }, "k4")).toBe(0);
    expect(await emitIntegrationEvent(asDb(db), { workspaceId: WS, type: "opt_out", data: { channel: "whatsapp", conversation_ref: refs[0], code: "0936654998" }, dedupeKey: "k5" })).toBe(0);
    expect(deliveries(db)).toHaveLength(0);
    expect(await emit(ok, "k6")).toBe(1);
  });
});

// ───────────────────────── الكليبر: حملات إعادة التواصل ─────────────────────────

describe("P12 clipper — حملات إعادة التواصل (POST /api/v1/retarget-campaigns)", () => {
  const body = (o: Row = {}): Row => ({
    external_ref: "clp_rt_001",
    channel: "whatsapp",
    segment: { kind: "messaged_no_order", code_prefix: "k7", days: [1, 7] },
    template_ref: "promo_k7",
    template_language: "ar",
    frequency_cap: { per_person_days: 7 },
    opt_in_required: true,
    approved_by: "owner@clipper",
    approved_at: "2026-10-11T08:00:00+03:00",
    ...o,
  });

  /** A مؤهل · B بادئة أخرى · C بلا موافقة · D طلب مؤخرًا · E وصلته حملة مؤخرًا · F لمسة أقدم من النافذة. */
  async function audience(db: FakeDb) {
    const mk = async (consent: string, code: string | null, daysAgo: number) => {
      const s = await seedConv(db, { customer: { marketingConsent: consent } });
      if (code) await capture(db, s, { at: new Date(Date.now() - daysAgo * DAY), key: `k-${s.customer.id}`, text: `رمز ${code}` });
      return s;
    };
    const A = await mk("OPTED_IN", "K7Q2", 2);
    const B = await mk("OPTED_IN", "Z9X1", 2);
    const C = await mk("UNKNOWN", "K7Q3", 2);
    const D = await mk("OPTED_IN", "K7Q4", 3);
    await db.order.create({ data: { workspaceId: WS, orderNumber: "O-D", customerId: D.customer.id, createdAt: new Date(Date.now() - DAY) } } as never);
    const E = await mk("OPTED_IN", "K7Q5", 2);
    db._stores.campaignRecipient.push({ id: "rcp-old", workspaceId: WS, campaignId: "c-old", customerId: E.customer.id, status: "SENT", sentAt: new Date(Date.now() - 2 * DAY) });
    const F = await mk("OPTED_IN", "K7Q6", 10);
    return { A, B, C, D, E, F };
  }

  it("أول طلب: حملة READY بانتظار الاعتماد + شريحة مقصورة على الموافقين + سقف التكرار — والرد أعداد فقط", async () => {
    const db = fake();
    await audience(db);
    const { created, response } = await createRetargetCampaign(asDb(db), { workspaceId: WS, idempotencyKey: "idem-rt-0001", body: body() });
    expect(created).toBe(true);
    expect(response.status).toBe("pending_approval");
    expect(response.eligible_count).toBe(1);
    expect(response.campaign_id).toMatch(/^rep_rt_[a-z0-9]{8,40}$/);
    expect(Object.keys(response).sort()).toEqual(["campaign_id", "eligible_count", "status"]);
    const camp = db._stores.campaign[0];
    expect(retargetCampaignId(camp.id)).toBe(response.campaign_id);
    expect(camp).toMatchObject({ status: "READY", approvedAt: null, source: "clipper", externalSystem: "clipper", externalRef: "clp_rt_001", externalIdempotencyKey: "idem-rt-0001", channelType: "WHATSAPP" });
    const version = db._stores.campaignContentVersion[0];
    expect(version).toMatchObject({ templateName: "promo_k7", templateLanguage: "ar" });
    const def = db._stores.audienceSegment[0].definition;
    expect(segmentDefinitionSchema.safeParse(def).success).toBe(true);
    expect(def.conditions).toEqual(
      expect.arrayContaining([
        { field: "customer.marketingConsent", op: "EQ", value: "OPTED_IN" },
        { field: "attribution.code", op: "PREFIX", value: "K7", minDays: 1, maxDays: 7 },
        { field: "orders.noneWithinDays", op: "EQ", days: 7 },
        { field: "campaign.notReceivedWithinDays", op: "EQ", days: 7 },
      ])
    );
    expect(db._stores.backgroundJob.filter((j) => j.type === "run_campaign")).toHaveLength(0);
    expect(db._stores.auditLog.find((a) => a.action === "integration.retarget_campaign_received")!.metadata).toMatchObject({ autoApproved: false, channel: "whatsapp" });
  });

  it("نفس Idempotency-Key = نفس الحملة (created:false) بلا شريحة/حملة جديدة", async () => {
    const db = fake();
    await audience(db);
    const first = await createRetargetCampaign(asDb(db), { workspaceId: WS, idempotencyKey: "idem-rt-0002", body: body() });
    const again = await createRetargetCampaign(asDb(db), { workspaceId: WS, idempotencyKey: "idem-rt-0002", body: body() });
    expect(again.created).toBe(false);
    expect(again.response).toEqual(first.response);
    expect(db._stores.campaign).toHaveLength(1);
    expect(db._stores.audienceSegment).toHaveLength(1);
    // نفس المفتاح بمساحة أخرى = حملة مستقلة لا تكشف حملة المساحة الأولى.
    await seedConv(db, { ws: WS_B });
    const other = await createRetargetCampaign(asDb(db), { workspaceId: WS_B, idempotencyKey: "idem-rt-0002", body: body() });
    expect(other.created).toBe(true);
    expect(other.response.campaign_id).not.toBe(first.response.campaign_id);
  });

  it("Idempotency-Key إلزامي بصيغته · مدخلات غلط = ZodError · قناة غير واتساب = RETARGET_WHATSAPP_ONLY — بلا أي كتابة", async () => {
    const db = fake();
    await audience(db);
    for (const key of ["", "abc", "has space key", "x".repeat(121)]) {
      await expect(createRetargetCampaign(asDb(db), { workspaceId: WS, idempotencyKey: key, body: body() })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    }
    await expect(createRetargetCampaign(asDb(db), { workspaceId: WS, idempotencyKey: "idem-rt-0003", body: body({ opt_in_required: false }) })).rejects.toMatchObject({ name: "ZodError" });
    await expect(createRetargetCampaign(asDb(db), { workspaceId: WS, idempotencyKey: "idem-rt-0003", body: body({ template_ref: "Promo K7" }) })).rejects.toMatchObject({ name: "ZodError" });
    for (const channel of ["messenger", "instagram", "telegram"]) {
      await expect(createRetargetCampaign(asDb(db), { workspaceId: WS, idempotencyKey: `idem-${channel}`, body: body({ channel }) })).rejects.toMatchObject({
        code: "RETARGET_WHATSAPP_ONLY",
        statusCode: 422,
      });
    }
    expect(db._stores.campaign).toHaveLength(0);
    expect(db._stores.audienceSegment).toHaveLength(0);
  });

  it("بلا قناة واتساب متصلة = CHANNEL_NOT_CONNECTED", async () => {
    const db = fake();
    await expect(createRetargetCampaign(asDb(db), { workspaceId: WS, idempotencyKey: "idem-rt-0004", body: body() })).rejects.toMatchObject({ code: "CHANNEL_NOT_CONNECTED" });
  });

  it("trustClipperApprovals: الحملة تُعتمد وتُجدول مباشرة (queued + مهمة run_campaign)", async () => {
    const db = fake({ trustClipperApprovals: true });
    await audience(db);
    const { response } = await createRetargetCampaign(asDb(db), { workspaceId: WS, idempotencyKey: "idem-rt-0005", body: body() });
    expect(response.status).toBe("queued");
    const camp = db._stores.campaign[0];
    expect(camp.status).toBe("SCHEDULED");
    expect(camp.approvedAt).toBeTruthy();
    expect(db._stores.backgroundJob.filter((j) => j.type === "run_campaign")).toHaveLength(1);
  });

  it("segmentForRetarget: الأنواع الثلاثة دائمًا مقصورة على OPTED_IN وبنوافذ افتراضية", () => {
    const base = body() as RetargetRequest;
    for (const kind of ["messaged_no_order", "cancelled_before_shipping", "repeat_product"] as const) {
      const def = segmentForRetarget({ ...base, segment: { kind }, frequency_cap: undefined });
      expect(def.conditions[0]).toEqual({ field: "customer.marketingConsent", op: "EQ", value: "OPTED_IN" });
      expect(segmentDefinitionSchema.safeParse(def).success).toBe(true);
      expect(frequencyCapDays(def)).toBeNull();
    }
    expect(segmentForRetarget({ ...base, segment: { kind: "messaged_no_order" } }).conditions[1]).toEqual({ field: "attribution.code", op: "ANY", minDays: 1, maxDays: 7 });
    expect(segmentForRetarget({ ...base, segment: { kind: "cancelled_before_shipping" } }).conditions[1]).toEqual({
      field: "orders.statusBetweenDays",
      op: "IN",
      value: ["CANCELLED"],
      minDays: 1,
      maxDays: 7,
    });
    expect(segmentForRetarget({ ...base, segment: { kind: "repeat_product" } }).conditions[1]).toMatchObject({ value: ["DELIVERED"], minDays: 30, maxDays: 45 });
    // نافذة أطول من 90 يوم تُقص لحد مخطط الرمز.
    const wide = segmentForRetarget({ ...base, segment: { kind: "messaged_no_order", days: [0, 365] } });
    expect(segmentDefinitionSchema.safeParse(wide).success).toBe(true);
    expect(wide.conditions[1]).toMatchObject({ maxDays: 90 });
  });

  it("buildRetargetCampaign (المسار المشترك) يرفض غير واتساب قبل أي كتابة", async () => {
    const db = fake();
    await seedConv(db);
    await expect(
      buildRetargetCampaign(asDb(db), {
        workspaceId: WS,
        source: "hermes",
        actor: "hermes",
        spec: { externalRef: "x", channel: "telegram", segment: { kind: "messaged_no_order" }, templateRef: "t", approvedBy: "u" },
      })
    ).rejects.toMatchObject({ code: "RETARGET_WHATSAPP_ONLY" });
    expect(db._stores.audienceSegment).toHaveLength(0);
  });
});

describe("P12 clipper — الحالة والأعداد والنتيجة (لا أشخاص)", () => {
  it("retargetStatus بلغة عقد الكليبر · المعرّف العام rep_rt_<id>", () => {
    expect(retargetStatus("RUNNING", null)).toBe("running");
    expect(retargetStatus("PAUSED", null)).toBe("running");
    expect(retargetStatus("COMPLETED", null)).toBe("completed");
    expect(retargetStatus("CANCELLED", null)).toBe("cancelled");
    expect(retargetStatus("FAILED", null)).toBe("failed");
    expect(retargetStatus("SCHEDULED", null)).toBe("queued");
    expect(retargetStatus("READY", null)).toBe("pending_approval");
    expect(retargetStatus("READY", new Date())).toBe("queued");
    expect(retargetStatus("DRAFT", null)).toBe("pending_approval");
    expect(parseRetargetCampaignId(retargetCampaignId("ckabc123def456ghi789jkl0"))).toBe("ckabc123def456ghi789jkl0");
    for (const bad of ["rep_rt_", "rep_rt_ABC12345", "rt_ckabc123", "rep_rt_ck-abc-123", "rep_rt_short"]) expect(parseRetargetCampaignId(bad)).toBeNull();
  });

  const T = new Date(Date.now() - 2 * DAY);
  async function ranCampaign(db: FakeDb, o: Row = {}) {
    const campaignId = `c${nodeCrypto.randomBytes(12).toString("hex")}`;
    db._stores.campaign.push({
      id: campaignId,
      workspaceId: WS,
      segmentId: "seg-x",
      channelType: "WHATSAPP",
      status: "COMPLETED",
      approvedAt: new Date(T.getTime() - HOUR),
      externalSystem: "clipper",
      externalRef: "clp_rt_9",
      resultsSentAt: null,
      finalResultsSentAt: null,
      ...o,
    });
    const A = await seedConv(db);
    const B = await seedConv(db);
    const mA = (await db.message.create({ data: { workspaceId: WS, conversationId: A.conversation.id, direction: "OUTBOUND", senderType: "HUMAN", senderId: "campaign-system", deliveryStatus: "READ", createdAt: T } } as never)) as Row;
    const mB = (await db.message.create({ data: { workspaceId: WS, conversationId: B.conversation.id, direction: "OUTBOUND", senderType: "HUMAN", senderId: "campaign-system", deliveryStatus: "DELIVERED", createdAt: T } } as never)) as Row;
    const rcp = (customerId: string, status: string, extra: Row = {}) =>
      db._stores.campaignRecipient.push({ id: `r-${nodeCrypto.randomBytes(4).toString("hex")}`, workspaceId: WS, campaignId, customerId, status, sentAt: null, messageId: null, ...extra });
    rcp(A.customer.id, "SENT", { sentAt: T, messageId: mA.id });
    rcp(B.customer.id, "SENT", { sentAt: T, messageId: mB.id });
    rcp("cust-failed", "FAILED");
    rcp("cust-excluded", "EXCLUDED");
    rcp("cust-cancelled", "CANCELLED");
    // A: رد بعد الإرسال + طلب بعده · B: رسالة قبل الإرسال + طلب قبله + إلغاء اشتراك بعده.
    await db.message.create({ data: { workspaceId: WS, conversationId: A.conversation.id, direction: "INBOUND", senderType: "CUSTOMER", text: "بكم؟", createdAt: new Date(T.getTime() + HOUR) } } as never);
    await db.message.create({ data: { workspaceId: WS, conversationId: B.conversation.id, direction: "INBOUND", senderType: "CUSTOMER", text: "قديم", createdAt: new Date(T.getTime() - HOUR) } } as never);
    await db.order.create({ data: { workspaceId: WS, orderNumber: "OA", customerId: A.customer.id, createdAt: new Date(T.getTime() + 2 * HOUR) } } as never);
    await db.order.create({ data: { workspaceId: WS, orderNumber: "OB", customerId: B.customer.id, createdAt: new Date(T.getTime() - 2 * HOUR) } } as never);
    db._stores.customer.find((c) => c.id === B.customer.id)!.marketingOptOutAt = new Date(T.getTime() + 3 * HOUR);
    return { campaignId, A, B };
  }

  it("retargetCounts: وصل · قرأ · رد · طلب · ألغى · فشل · استُبعد — بعد لحظة الإرسال فقط", async () => {
    const db = fake();
    const { campaignId } = await ranCampaign(db);
    expect(await retargetCounts(asDb(db), campaignId)).toEqual({
      eligible: 5,
      sent: 2,
      delivered: 2,
      read: 1,
      replied: 1,
      ordered: 1,
      opted_out: 1,
      failed: 1,
      excluded: 2,
    });
  });

  // BUG (src/modules/integrations/clipper.ts:393-396): استعلام «الردود» يعدّ كل رسالة
  // INBOUND بعد الإرسال بلا isNote:false — والملاحظات الداخلية (postNote) تُحفظ
  // direction:"INBOUND" — فملاحظة موظف تُحسب «رد زبون» بنتيجة الحملة للكليبر.
  it("ملاحظة داخلية من الموظف بعد الإرسال ليست ردًا من الزبون", async () => {
    const db = fake();
    const { campaignId, B } = await ranCampaign(db);
    await postNote(asDb(db), { userId: "agent-1", workspaceId: WS }, B.conversation.id, "اتصلت فيه وما رد");
    expect((await retargetCounts(asDb(db), campaignId)).replied).toBe(1);
  });

  it("getRetargetCampaign: حملة الكليبر فقط وبمساحتها — والجسم أعداد بلا أشخاص", async () => {
    const db = fake();
    const { campaignId } = await ranCampaign(db);
    const res = await getRetargetCampaign(asDb(db), WS, retargetCampaignId(campaignId));
    expect(res).toMatchObject({ campaign_id: retargetCampaignId(campaignId), external_ref: "clp_rt_9", status: "completed" });
    expect(res.counts.sent).toBe(2);
    expect(findPii(res)).toEqual([]);
    await expect(getRetargetCampaign(asDb(db), WS_B, retargetCampaignId(campaignId))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getRetargetCampaign(asDb(db), WS, "rep_rt_bad-format")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const manualId = `c${nodeCrypto.randomBytes(12).toString("hex")}`;
    db._stores.campaign.push({ id: manualId, workspaceId: WS, status: "COMPLETED", externalSystem: null, externalRef: null, approvedAt: null });
    await expect(getRetargetCampaign(asDb(db), WS, retargetCampaignId(manualId))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("emitRetargetResult: retarget.result حرفي بالعقد — مؤقتة لكل حالة مرة · نهائية مرة · حملات غير الكليبر لا", async () => {
    const db = fake();
    await connectClipper(db);
    const { campaignId } = await ranCampaign(db);
    expect(await emitRetargetResult(asDb(db), campaignId, false)).toBe(true);
    expect(await emitRetargetResult(asDb(db), campaignId, false)).toBe(false);
    const camp = db._stores.campaign.find((c) => c.id === campaignId)!;
    expect(camp.resultsSentAt).toBeTruthy();
    expect(camp.finalResultsSentAt).toBeNull();
    expect(await emitRetargetResult(asDb(db), campaignId, true)).toBe(true);
    expect(await emitRetargetResult(asDb(db), campaignId, true)).toBe(false);
    expect(camp.finalResultsSentAt).toBeTruthy();
    const rows = deliveries(db, "retarget.result");
    expect(rows).toHaveLength(2);
    const [interim, final] = rows.map((r) => bodyOf(r).data);
    for (const d of [interim, final]) {
      expect(EVENT_SCHEMAS["retarget.result"].safeParse(d).success).toBe(true);
      expect(findPii(d)).toEqual([]);
      expect(d).toMatchObject({ campaign_id: retargetCampaignId(campaignId), external_ref: "clp_rt_9", status: "completed" });
    }
    expect([interim.final, final.final]).toEqual([false, true]);
    expect(interim.counts).toMatchObject({ sent: 2, replied: 1, ordered: 1 });

    const manualId = `c${nodeCrypto.randomBytes(12).toString("hex")}`;
    db._stores.campaign.push({ id: manualId, workspaceId: WS, status: "COMPLETED", externalSystem: null, externalRef: null });
    expect(await emitRetargetResult(asDb(db), manualId, true)).toBe(false);
    expect(deliveries(db, "retarget.result")).toHaveLength(2);
  });
});

// ──────────────────────────── شرائح الكليبر الجديدة ────────────────────────────

describe("P12 segments — شروط الكليبر الجديدة", () => {
  const def = (conditions: Row[]) => ({ version: SEGMENT_VERSION, match: "ALL", conditions });
  const evalIds = async (db: FakeDb, conditions: Row[]) => {
    const r = await evaluateSegment(asDb(db), { workspaceId: WS, definition: def(conditions), channelType: "WHATSAPP" });
    return { eligible: r.eligible.map((c) => String(c.id)), candidates: r.candidates.map((c) => String(c.id)), byReason: r.byReason };
  };
  const opted = { marketingConsent: "OPTED_IN" };

  it("المخطط: مغلق وحرفي (قيم كبيرة · بلا مفاتيح زائدة · حدود الأيام)", () => {
    const ok = (c: Row) => segmentDefinitionSchema.safeParse(def([c])).success;
    expect(ok({ field: "attribution.code", op: "ANY", minDays: 0, maxDays: 90 })).toBe(true);
    expect(ok({ field: "attribution.code", op: "PREFIX", value: "K7", minDays: 1, maxDays: 7 })).toBe(true);
    expect(ok({ field: "attribution.code", op: "PREFIX", value: "k7", minDays: 1, maxDays: 7 })).toBe(false);
    expect(ok({ field: "attribution.code", op: "ANY", minDays: 1, maxDays: 91 })).toBe(false);
    expect(ok({ field: "attribution.code", op: "ANY", minDays: 1, maxDays: 7, sql: "1=1" })).toBe(false);
    expect(ok({ field: "orders.noneWithinDays", op: "EQ", days: 7 })).toBe(true);
    expect(ok({ field: "orders.noneWithinDays", op: "EQ", days: 0 })).toBe(false);
    expect(ok({ field: "orders.statusBetweenDays", op: "IN", value: [], minDays: 0, maxDays: 7 })).toBe(false);
    expect(ok({ field: "orders.statusBetweenDays", op: "IN", value: ["CANCELLED"], minDays: 0, maxDays: 7 })).toBe(true);
    expect(ok({ field: "campaign.notReceivedWithinDays", op: "EQ", days: 7 })).toBe(true);
    expect(ok({ field: "campaign.notReceivedWithinDays", op: "GT", days: 7 })).toBe(false);
  });

  it("attribution.code ANY/PREFIX/EQ: رمز غير مرفوض داخل [الآن-max, الآن-min] فقط", async () => {
    const db = fake();
    const mk = async (code: string | null, daysAgo: number, mark?: "VALID" | "INVALID", ad = false) => {
      const s = await seedConv(db, { customer: opted });
      if (code) {
        const [t] = await capture(db, s, { at: new Date(Date.now() - daysAgo * DAY), key: `k${s.customer.id}`, text: `رمز ${code}` });
        if (mark) await markCodeVerification(asDb(db), t.id, { valid: mark === "VALID" });
      }
      if (ad) await capture(db, s, { at: new Date(Date.now() - daysAgo * DAY), key: `a${s.customer.id}`, referral: AD() });
      return s.customer.id as string;
    };
    const k7 = await mk("K7Q2", 2);
    const k7valid = await mk("K7AB", 3, "VALID");
    const z9 = await mk("Z9X1", 2);
    const invalid = await mk("K7ZZ", 2, "INVALID");
    const tooOld = await mk("K7Q9", 10);
    const tooNew = await mk("K7Q8", 0);
    const adOnly = await mk(null, 2, undefined, true);
    expect((await evalIds(db, [{ field: "attribution.code", op: "ANY", minDays: 1, maxDays: 7 }])).eligible.sort()).toEqual([k7, k7valid, z9].sort());
    expect((await evalIds(db, [{ field: "attribution.code", op: "PREFIX", value: "K7", minDays: 1, maxDays: 7 }])).eligible.sort()).toEqual([k7, k7valid].sort());
    expect((await evalIds(db, [{ field: "attribution.code", op: "EQ", value: "Z9X1", minDays: 1, maxDays: 7 }])).eligible).toEqual([z9]);
    const all = await evalIds(db, [{ field: "attribution.code", op: "ANY", minDays: 0, maxDays: 30 }]);
    expect(all.eligible).toEqual(expect.arrayContaining([tooOld, tooNew]));
    expect(all.eligible).not.toContain(invalid);
    expect(all.eligible).not.toContain(adOnly);
  });

  it("orders.noneWithinDays و orders.statusBetweenDays (الحالة + وقت تغيّرها)", async () => {
    const db = fake();
    const mk = async (orders: Array<{ status: string; createdDaysAgo: number; updatedDaysAgo?: number }>) => {
      const s = await seedConv(db, { customer: opted });
      for (const o of orders) {
        db._stores.order.push({
          id: `o-${nodeCrypto.randomBytes(4).toString("hex")}`,
          workspaceId: WS,
          customerId: s.customer.id,
          orderNumber: `N-${Math.random()}`,
          status: o.status,
          createdAt: new Date(Date.now() - o.createdDaysAgo * DAY),
          updatedAt: new Date(Date.now() - (o.updatedDaysAgo ?? o.createdDaysAgo) * DAY),
        });
      }
      return s.customer.id as string;
    };
    const none = await mk([]);
    const recent = await mk([{ status: "CONFIRMED", createdDaysAgo: 3 }]);
    const old = await mk([{ status: "DELIVERED", createdDaysAgo: 40, updatedDaysAgo: 35 }]);
    const cancelled = await mk([{ status: "CANCELLED", createdDaysAgo: 5, updatedDaysAgo: 3 }]);
    const cancelledOld = await mk([{ status: "CANCELLED", createdDaysAgo: 20, updatedDaysAgo: 15 }]);
    const cancelledNow = await mk([{ status: "CANCELLED", createdDaysAgo: 1, updatedDaysAgo: 0.05 }]);
    expect((await evalIds(db, [{ field: "orders.noneWithinDays", op: "EQ", days: 7 }])).eligible.sort()).toEqual([none, old, cancelledOld].sort());
    expect((await evalIds(db, [{ field: "orders.statusBetweenDays", op: "IN", value: ["CANCELLED"], minDays: 1, maxDays: 7 }])).eligible).toEqual([cancelled]);
    expect((await evalIds(db, [{ field: "orders.statusBetweenDays", op: "IN", value: ["DELIVERED"], minDays: 30, maxDays: 45 }])).eligible).toEqual([old]);
    expect(cancelledNow).toBeTruthy();
  });

  it("حصر بالمنتج: orders.statusBetweenDays.productId · attribution.code.productCode (من تحقق الكليبر)", async () => {
    const db = fake();
    const ok = (c: Row) => segmentDefinitionSchema.safeParse(def([c])).success;
    expect(ok({ field: "orders.statusBetweenDays", op: "IN", value: ["DELIVERED"], minDays: 30, maxDays: 45, productId: "p-1" })).toBe(true);
    expect(ok({ field: "attribution.code", op: "ANY", minDays: 1, maxDays: 7, productCode: "TIN01" })).toBe(true);
    expect(ok({ field: "attribution.code", op: "ANY", minDays: 1, maxDays: 7, productCode: "TIN 01" })).toBe(false);
    const withOrder = async (productId: string) => {
      const s = await seedConv(db, { customer: opted });
      db._stores.order.push({ id: `o-${nodeCrypto.randomBytes(4).toString("hex")}`, workspaceId: WS, customerId: s.customer.id, orderNumber: `N-${Math.random()}`, status: "DELIVERED", createdAt: new Date(Date.now() - 40 * DAY), updatedAt: new Date(Date.now() - 35 * DAY), items: [{ productId }] });
      return s.customer.id as string;
    };
    const tin = await withOrder("p-tin");
    const soap = await withOrder("p-soap");
    expect((await evalIds(db, [{ field: "orders.statusBetweenDays", op: "IN", value: ["DELIVERED"], minDays: 30, maxDays: 45 }])).eligible.sort()).toEqual([tin, soap].sort());
    expect((await evalIds(db, [{ field: "orders.statusBetweenDays", op: "IN", value: ["DELIVERED"], minDays: 30, maxDays: 45, productId: "p-tin" }])).eligible).toEqual([tin]);
    const coded = async (productCode: string | null) => {
      const s = await seedConv(db, { customer: opted });
      const [t] = await capture(db, s, { at: new Date(Date.now() - 2 * DAY), key: `pc${s.customer.id}`, text: "رمز K7Q2" });
      if (productCode) await markCodeVerification(asDb(db), t.id, { valid: true, productCode });
      return s.customer.id as string;
    };
    const tinCode = await coded("TIN01");
    const soapCode = await coded("SOAP1");
    const unverified = await coded(null);
    const any = (await evalIds(db, [{ field: "attribution.code", op: "ANY", minDays: 1, maxDays: 7 }])).eligible;
    expect(any).toEqual(expect.arrayContaining([tinCode, soapCode, unverified]));
    expect((await evalIds(db, [{ field: "attribution.code", op: "ANY", minDays: 1, maxDays: 7, productCode: "TIN01" }])).eligible).toEqual([tinCode]);
  });

  it("campaign.notReceivedWithinDays = استبعاد FREQUENCY_CAP لمن وصلته حملة (SENT) خلال المدة فقط", async () => {
    const db = fake();
    const recentSent = (await seedConv(db, { customer: opted })).customer.id as string;
    const oldSent = (await seedConv(db, { customer: opted })).customer.id as string;
    const failedRecent = (await seedConv(db, { customer: opted })).customer.id as string;
    const push = (customerId: string, status: string, daysAgo: number) =>
      db._stores.campaignRecipient.push({ id: `r-${Math.random()}`, workspaceId: WS, campaignId: "c1", customerId, status, sentAt: new Date(Date.now() - daysAgo * DAY) });
    push(recentSent, "SENT", 2);
    push(oldSent, "SENT", 10);
    push(failedRecent, "FAILED", 1);
    const r = await evalIds(db, [
      { field: "customer.marketingConsent", op: "EQ", value: "OPTED_IN" },
      { field: "campaign.notReceivedWithinDays", op: "EQ", days: 7 },
    ]);
    expect(r.eligible.sort()).toEqual([oldSent, failedRecent].sort());
    expect(r.byReason.FREQUENCY_CAP).toBe(1);
    expect(frequencyCapDays(def([{ field: "campaign.notReceivedWithinDays", op: "EQ", days: 3 }, { field: "campaign.notReceivedWithinDays", op: "EQ", days: 9 }]) as never)).toBe(9);
  });

  it("customer.marketingConsent: OPTED_IN فقط يصير مؤهلًا (غير المعروف والملغى خارج الشريحة)", async () => {
    const db = fake();
    const inId = (await seedConv(db, { customer: opted })).customer.id as string;
    await seedConv(db, { customer: { marketingConsent: "UNKNOWN" } });
    await seedConv(db, { customer: { marketingConsent: "OPTED_OUT", marketingOptOutAt: new Date() } });
    const r = await evalIds(db, [{ field: "customer.marketingConsent", op: "EQ", value: "OPTED_IN" }]);
    expect(r.candidates).toEqual([inId]);
    expect(r.eligible).toEqual([inId]);
  });
});
