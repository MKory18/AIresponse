import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import type { Db } from "@/modules/customers/service";
import { saveIntegrationConnection, setIntegrationDnsLookup } from "@/modules/integrations/connections";
import { setSystemFetch } from "@/modules/integrations/http";
import { findPii } from "@/modules/integrations/pii-guard";
import { EVENT_SCHEMAS } from "@/modules/integrations/outbox";
import { capacityLevel, computeCapacity, evaluateCapacityAlerts } from "@/modules/integrations/capacity";
import {
  COMPLIANCE_STALE_HOURS,
  findBannedClaims,
  getProductCompliance,
  onComplianceUpdated,
  refreshComplianceJob,
  refreshProductCompliance,
  setProductS1Ref,
  toComplianceView,
} from "@/modules/integrations/compliance";
import {
  enqueueChannelHealthAlerts,
  enqueueDailyUsageReport,
  enqueueOverdueHandoffTask,
  enqueueWeeklyQuestionsIdea,
  zonedDayRange,
} from "@/modules/integrations/ops-signals";
import { RETARGET_FINAL_AFTER_HOURS, resetIntegrationScheduler, runIntegrationScheduler } from "@/modules/integrations/scheduler";
import { validateResponse } from "@/modules/ai/guardrails";
import { buildProductContext, type AIContext } from "@/modules/ai/context-builder";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { MockAIProvider, setMockAIProvider } from "@/modules/ai/provider";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { setWhatsAppClientFactory, WhatsAppClient } from "@/modules/channels/whatsapp/client";
import { processIncomingMessage } from "@/modules/conversations/service";
import { createProduct } from "@/modules/products/service";
import { createCampaign, validateCampaign, approveCampaign, scheduleCampaign } from "@/modules/campaigns/campaign-service";
import { campaignTick, startCampaignRun } from "@/modules/campaigns/campaign-runner";

/**
 * P12 — قدرة الرد وإنذاراتها · قواعد الادعاءات من سيستم 1 وحارس الرد ·
 * الإشارات التشغيلية للأنظمة الأخرى · مجدول الربط.
 */

const WS = "ws-p12-cap-0001";
const WS_B = "ws-p12-cap-b";
const ctx = { userId: "owner-1", workspaceId: WS };
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

beforeAll(() => setIntegrationDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]));
afterAll(() => setIntegrationDnsLookup(null));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setSystemFetch(null);
  resetIntegrationScheduler();
});

type FakeDb = ReturnType<typeof createFakeDb>;
type Row = Record<string, any>;
const asDb = (db: FakeDb) => db as unknown as Db;

function fake(settings: Record<string, unknown> = {}, ws: Row = {}): FakeDb {
  const db = createFakeDb();
  db._stores.workspace.push(
    { id: WS, name: "Zaki", slug: "zaki", timezone: "Asia/Amman", integrationSettings: settings, slaHandoffResolutionMinutes: null, ...ws },
    { id: WS_B, name: "Other", slug: "other", timezone: "UTC", integrationSettings: {} }
  );
  return db;
}

/** وقت النظام مضبوط (createdAt بالـ fake ومفاتيح الساعة تتبعه) — Date فقط، المؤقتات حقيقية. */
function freeze(at: Date | number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

async function channel(db: FakeDb, type: string, o: Row = {}) {
  return (await db.channel.create({ data: { workspaceId: WS, type, status: "CONNECTED", displayName: type, externalId: `acct-${type}-${Math.random()}`, ...o } } as never)) as Row;
}

let convN = 0;
async function conv(db: FakeDb, ch: Row, o: Row = {}) {
  convN += 1;
  const customer = (await db.customer.create({ data: { workspaceId: o.workspaceId ?? WS, name: `ز${convN}` } } as never)) as Row;
  return (await db.conversation.create({
    data: { workspaceId: WS, customerId: customer.id, channelId: ch.id, channelConversationId: `cc-${convN}`, status: "OPEN", lastAgentMessageAt: null, ...o },
  } as never)) as Row;
}

async function msg(db: FakeDb, c: Row, at: Date, o: Row = {}) {
  return db.message.create({
    data: { workspaceId: c.workspaceId, conversationId: c.id, direction: "INBOUND", senderType: "CUSTOMER", text: "x", createdAt: at, ...o },
  } as never);
}

const deliveries = (db: FakeDb, filter: Row = {}) => db._stores.integrationDelivery.filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
const bodyOf = (row: Row) => JSON.parse(row.body);

// ─────────────────────────────── قدرة الرد ───────────────────────────────

describe("P12 computeCapacity — الأرقام من قاعدة البيانات بتعريفات ثابتة", () => {
  const now = new Date("2026-10-11T09:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("unanswered: مفتوحة/معلّقة · آخر رسالة زبون خلال 24 ساعة · بلا رد بعدها — ولكل قناة", async () => {
    const db = fake();
    const wa = await channel(db, "WHATSAPP");
    const fb = await channel(db, "FACEBOOK");
    await conv(db, wa, { lastCustomerMessageAt: ago(30 * MIN) }); // ✔ بلا رد
    const answered = await conv(db, wa, { lastCustomerMessageAt: ago(30 * MIN), lastAgentMessageAt: ago(10 * MIN) }); // ✘ رُد عليها
    // رد حقيقي محفوظ (الحقل المختصر وحده ما بيكفي — رسالة حملة كمان بتحدّثه).
    await msg(db, answered, ago(10 * MIN), { direction: "OUTBOUND", senderType: "AI" });
    await conv(db, fb, { status: "PENDING", lastCustomerMessageAt: ago(5 * MIN), lastAgentMessageAt: ago(60 * MIN) }); // ✔ الرد قبل رسالة الزبون
    await conv(db, wa, { status: "RESOLVED", lastCustomerMessageAt: ago(5 * MIN) }); // ✘ مغلقة
    await conv(db, wa, { status: "CLOSED", lastCustomerMessageAt: ago(5 * MIN) }); // ✘
    await conv(db, wa, { lastCustomerMessageAt: ago(25 * HOUR) }); // ✘ أقدم من النافذة
    await conv(db, wa, { lastCustomerMessageAt: ago(5 * MIN), deletedAt: ago(MIN) }); // ✘ محذوفة
    await conv(db, wa, { lastCustomerMessageAt: null }); // ✘ ما في رسالة زبون
    await conv(db, wa, { workspaceId: WS_B, lastCustomerMessageAt: ago(5 * MIN) }); // ✘ مساحة أخرى
    const snap = await computeCapacity(asDb(db), WS, now);
    expect(snap.unanswered).toBe(2);
    expect(snap.by_channel).toEqual({ whatsapp: 1, messenger: 1 });
    expect(snap.first_response_p50_min).toBeNull();
    expect(snap.at).toBe("2026-10-11T12:00:00+03:00");
    expect(Object.keys(snap).sort()).toEqual(["at", "by_channel", "first_response_p50_min", "unanswered"]);
  });

  it("first_response_p50_min: وسيط زمن الرد على «دفعة» الزبون — الملاحظات ورسائل الحملات والنظام ليست ردودًا", async () => {
    const db = fake();
    const wa = await channel(db, "WHATSAPP");
    const a = await conv(db, wa);
    const b = await conv(db, wa);
    const c = await conv(db, wa);
    const d = await conv(db, wa);
    // A: دفعة (رسالتين) ← رد ذكاء بعد 4 دقائق من أول رسالة · ثم دفعة ثانية ← رد بعد دقيقتين.
    await msg(db, a, ago(60 * MIN));
    await msg(db, a, ago(59 * MIN));
    await msg(db, a, ago(56 * MIN), { direction: "OUTBOUND", senderType: "AI" });
    await msg(db, a, ago(20 * MIN));
    await msg(db, a, ago(18 * MIN), { direction: "OUTBOUND", senderType: "AI" });
    // B: ملاحظة داخلية + رسالة حملة + رسالة نظام لا تُحسب؛ رد الموظف بعد 10 دقائق.
    await msg(db, b, ago(50 * MIN));
    await msg(db, b, ago(49 * MIN), { senderType: "HUMAN", isNote: true });
    await msg(db, b, ago(48 * MIN), { direction: "OUTBOUND", senderType: "HUMAN", senderId: "campaign-system" });
    await msg(db, b, ago(47 * MIN), { direction: "OUTBOUND", senderType: "SYSTEM" });
    await msg(db, b, ago(40 * MIN), { direction: "OUTBOUND", senderType: "HUMAN", senderId: "agent-1" });
    // ملاحظة داخلية بعد الرد (تُحفظ INBOUND) لا تفتح «دفعة زبون» — والرد بعدها ليس عيّنة.
    await msg(db, b, ago(35 * MIN), { senderType: "HUMAN", senderId: "agent-1", isNote: true });
    await msg(db, b, ago(15 * MIN), { direction: "OUTBOUND", senderType: "HUMAN", senderId: "agent-1" });
    // C: رد بعد 6 دقائق.
    await msg(db, c, ago(30 * MIN));
    await msg(db, c, ago(24 * MIN), { direction: "OUTBOUND", senderType: "AI" });
    // D: دفعة بدأت قبل النافذة — الرد داخلها لا يصير عيّنة · رسالة محذوفة لا تبدأ دفعة.
    await msg(db, d, ago(25 * HOUR));
    await msg(db, d, ago(23 * HOUR), { direction: "OUTBOUND", senderType: "AI" });
    await msg(db, d, ago(10 * MIN), { deletedAt: ago(MIN) });
    await msg(db, d, ago(5 * MIN), { direction: "OUTBOUND", senderType: "AI" });
    const snap = await computeCapacity(asDb(db), WS, now);
    // العيّنات: 4 · 2 · 10 · 6 → الوسيط 5
    expect(snap.first_response_p50_min).toBe(5);
  });

  it("الوسيط بالدقائق (كسور الدقيقة محسوبة لا مقصوصة)", async () => {
    const db = fake();
    const c = await conv(db, await channel(db, "WHATSAPP"));
    await msg(db, c, ago(10 * MIN));
    await msg(db, c, new Date(ago(10 * MIN).getTime() + 75_000), { direction: "OUTBOUND", senderType: "AI" });
    const p50 = (await computeCapacity(asDb(db), WS, now)).first_response_p50_min!;
    expect(Math.abs(p50 - 1.25)).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  // BUG (src/modules/integrations/capacity.ts:62 مع channels/outbound.ts:705 (و:492 لماسنجر)):
  // (كان خطأ) unanswered كان يعتمد lastAgentMessageAt فقط، وإرسال الحملة عبر dispatchOutbound يختم
  // lastAgentMessageAt على محادثة الزبون القائمة — فرسالة حملة (senderId
  // "campaign-system") تُحسب «ردًا» وتُخفي زبونًا ينتظر، خلافًا لتعريف العقد
  // (ورسالة الحملة مستثناة صراحة من حساب الوسيط بنفس الملف).
  it("رسالة حملة تسويقية لزبون ينتظر ردًا لا تجعل محادثته «مردودًا عليها»", async () => {
    const db = fake();
    db._stores.workspaceMember.push({ id: "m1", workspaceId: WS, userId: "owner-1", status: "ACTIVE" });
    const wa = await channel(db, "WHATSAPP");
    await db.channelAccount.create({ data: { channelId: wa.id, provider: "WHATSAPP", externalAccountId: wa.externalId, encryptedCredentials: encryptSecret("tok") } } as never);
    const customer = (await db.customer.create({ data: { workspaceId: WS, name: "منتظر", phone: "+963930000111", marketingConsent: "OPTED_IN" } } as never)) as Row;
    await db.channelIdentity.create({ data: { workspaceId: WS, customerId: customer.id, channelType: "WHATSAPP", channelExternalId: "963930000111" } } as never);
    const waiting = new Date(Date.now() - 30 * MIN);
    const c = (await db.conversation.create({
      data: { workspaceId: WS, customerId: customer.id, channelId: wa.id, channelConversationId: "963930000111", status: "OPEN", lastCustomerMessageAt: waiting, lastAgentMessageAt: null },
    } as never)) as Row;
    await msg(db, c, waiting);
    expect((await computeCapacity(asDb(db), WS, new Date())).unanswered).toBe(1);

    setWhatsAppClientFactory(
      () =>
        new WhatsAppClient({
          fetchImpl: (async (_u: string, init?: { body?: string }) =>
            Response.json({ messaging_product: "whatsapp", messages: [{ id: `wamid-${JSON.parse(String(init?.body)).to}` }] })) as unknown as typeof fetch,
        })
    );
    try {
      const seg = (await db.audienceSegment.create({
        data: { workspaceId: WS, name: "opted", definition: { version: 1, match: "ALL", conditions: [{ field: "customer.marketingConsent", op: "EQ", value: "OPTED_IN" }] } },
      } as never)) as Row;
      const mgr = { userId: "owner-1", workspaceId: WS, can: () => true };
      const { campaign } = await createCampaign(asDb(db), mgr, {
        name: "عرض",
        segmentId: seg.id,
        channelType: "WHATSAPP",
        channelId: wa.id,
        content: { text: "عرض", templateName: "promo", templateLanguage: "ar" },
      });
      await validateCampaign(asDb(db), mgr, campaign.id);
      await approveCampaign(asDb(db), mgr as never, campaign.id);
      await scheduleCampaign(asDb(db), mgr, campaign.id, {});
      await startCampaignRun(asDb(db), campaign.id);
      expect((await campaignTick(asDb(db), campaign.id, 1)).sent).toBe(1);
      expect(db._stores.message.some((m) => m.senderId === "campaign-system" && m.conversationId === c.id)).toBe(true);
    } finally {
      setWhatsAppClientFactory(null as never);
    }
    expect((await computeCapacity(asDb(db), WS, new Date(Date.now() + 1000))).unanswered).toBe(1);
  });
});

describe("P12 capacityLevel — حدود الإنذار والحرج", () => {
  const t = { unanswered: 30, p50: 15, multiplier: 2 };
  it.each([
    [29, 14, "ok"],
    [30, null, "warning"],
    [59, 29, "warning"],
    [0, 15, "warning"],
    [60, 0, "critical"],
    [0, 30, "critical"],
    [0, null, "ok"],
  ] as const)("unanswered=%s p50=%s → %s", (unanswered, p50, level) => {
    expect(capacityLevel({ unanswered, first_response_p50_min: p50 }, t)).toBe(level);
  });
});

describe("P12 evaluateCapacityAlerts — مرة لكل مستوى بالساعة · recovered مرة · الحرج للأزمات", () => {
  const T = new Date("2026-10-11T09:10:00.000Z");
  let db: FakeDb;
  let wa: Row;
  const unansweredConvs: Row[] = [];

  beforeEach(async () => {
    freeze(T);
    db = fake({ capacityUnansweredWarn: 2, capacityP50WarnMin: 1000, capacityCriticalMultiplier: 2 });
    await saveIntegrationConnection(asDb(db), ctx, "mediabuyer", { baseUrl: "https://mb.zakai.io", generateEventsSecret: true });
    await saveIntegrationConnection(asDb(db), ctx, "bridge", { baseUrl: "https://bridge.zakai.io", generateEventsSecret: true });
    await saveIntegrationConnection(asDb(db), ctx, "crisis", { baseUrl: "https://crisis.zakai.io", token: "crisis-token-1" });
    wa = await channel(db, "WHATSAPP");
    unansweredConvs.length = 0;
  });

  const waiting = async (k: number) => {
    for (let i = 0; i < k; i += 1) unansweredConvs.push(await conv(db, wa, { lastCustomerMessageAt: new Date(Date.now() - 10 * MIN) }));
  };
  const alerts = () => deliveries(db, { type: "capacity.alert" });
  const levelsBySystem = () => alerts().map((d) => `${d.system}:${bodyOf(d).data.level}`);

  it("لا ضغط = لا شيء يُرسل", async () => {
    await waiting(1);
    expect(await evaluateCapacityAlerts(asDb(db), WS, new Date())).toBe("ok");
    expect(db._stores.integrationDelivery).toHaveLength(0);
  });

  it("إنذار للميديا باير والجسر بعقد حرفي — ولا يتكرر بنفس الساعة، ويعاد بعد ساعة", async () => {
    await waiting(2);
    expect(await evaluateCapacityAlerts(asDb(db), WS, new Date())).toBe("warning");
    expect(levelsBySystem().sort()).toEqual(["bridge:warning", "mediabuyer:warning"]);
    const data = bodyOf(alerts()[0]).data;
    expect(data).toEqual({ level: "warning", unanswered: 2, first_response_p50_min: null, by_channel: { whatsapp: 2 }, threshold_unanswered: 2, threshold_p50_min: 1000 });
    expect(EVENT_SCHEMAS["capacity.alert"].safeParse(data).success).toBe(true);
    expect(findPii(data)).toEqual([]);
    expect(deliveries(db, { system: "crisis" })).toHaveLength(0); // الإنذار العادي لا يروح للأزمات
    vi.setSystemTime(T.getTime() + 20 * MIN);
    await evaluateCapacityAlerts(asDb(db), WS, new Date());
    expect(alerts()).toHaveLength(2);
    vi.setSystemTime(T.getTime() + 61 * MIN);
    await evaluateCapacityAlerts(asDb(db), WS, new Date());
    expect(alerts()).toHaveLength(4);
  });

  it("حرج = capacity.alert حرج + نداء أزمات /api/v1/alerts بمفتاح الساعة — مرة واحدة", async () => {
    await waiting(2);
    await evaluateCapacityAlerts(asDb(db), WS, new Date());
    vi.setSystemTime(T.getTime() + 5 * MIN);
    await waiting(2);
    expect(await evaluateCapacityAlerts(asDb(db), WS, new Date())).toBe("critical");
    expect(levelsBySystem().filter((l) => l.endsWith(":critical")).sort()).toEqual(["bridge:critical", "mediabuyer:critical"]);
    const crisis = deliveries(db, { system: "crisis", type: "alerts" });
    expect(crisis).toHaveLength(1);
    const hourBucket = Math.floor((T.getTime() + 5 * MIN) / HOUR);
    expect(crisis[0]).toMatchObject({ kind: "call", url: "https://crisis.zakai.io/api/v1/alerts" });
    expect(crisis[0].idempotencyKey).toMatch(new RegExp(`-${hourBucket}$`)); // مفتاح ثابت للساعة
    const body = bodyOf(crisis[0]);
    expect(body).toMatchObject({ type: "replies_capacity_critical", severity: "high", unanswered: 4 });
    expect(findPii(body)).toEqual([]);
    vi.setSystemTime(T.getTime() + 10 * MIN);
    await evaluateCapacityAlerts(asDb(db), WS, new Date());
    expect(deliveries(db, { system: "crisis" })).toHaveLength(1);
    expect(alerts()).toHaveLength(4);
  });

  it("الرجوع للطبيعي = «recovered» مرة واحدة فقط", async () => {
    await waiting(2);
    await evaluateCapacityAlerts(asDb(db), WS, new Date());
    vi.setSystemTime(T.getTime() + 15 * MIN);
    for (const c of unansweredConvs) {
      db._stores.conversation.find((x) => x.id === c.id)!.lastAgentMessageAt = new Date();
      await msg(db, c, new Date(), { direction: "OUTBOUND", senderType: "HUMAN" });
    }
    expect(await evaluateCapacityAlerts(asDb(db), WS, new Date())).toBe("ok");
    expect(levelsBySystem().filter((l) => l.endsWith(":recovered")).sort()).toEqual(["bridge:recovered", "mediabuyer:recovered"]);
    const rec = bodyOf(alerts().find((d) => bodyOf(d).data.level === "recovered")!).data;
    expect(rec).toMatchObject({ level: "recovered", unanswered: 0 });
    expect(EVENT_SCHEMAS["capacity.alert"].safeParse(rec).success).toBe(true);
    vi.setSystemTime(T.getTime() + 20 * MIN);
    await evaluateCapacityAlerts(asDb(db), WS, new Date());
    vi.setSystemTime(T.getTime() + 90 * MIN);
    await evaluateCapacityAlerts(asDb(db), WS, new Date());
    expect(alerts()).toHaveLength(4);
  });
});

// ──────────────────────────── قواعد الادعاءات (سيستم 1) ────────────────────────────

describe("P12 compliance — قراءة القواعد من سيستم 1 وحفظ نسخة", () => {
  let db: FakeDb;
  let product: Row;
  const S1_JSON = {
    product_ref: "pf_2031",
    classification: "cosmetic",
    verdict: "allowed_with_rules",
    allowed_claims: [" يرطب البشرة ", "يرطب البشرة", "مكونات طبيعية"],
    banned_claims: ["يعالج الصدفية", "نتيجة مضمونة"],
    ad_rules: ["بلا صور قبل/بعد"],
    updated_at: "2026-10-10T12:00:00Z",
  };

  beforeEach(async () => {
    db = fake();
    product = (await db.product.create({ data: { workspaceId: WS, sku: "CR-1", name: "كريم", price: 100, s1ProductRef: "pf_2031" } } as never)) as Row;
    await saveIntegrationConnection(asDb(db), ctx, "s1", { baseUrl: "https://s1.zakai.io", token: "s1-token-123456", generateEventsSecret: true });
  });

  function stubS1(res: () => Response): Array<{ url: string; init: RequestInit }> {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    setSystemFetch((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return res();
    }) as unknown as typeof fetch);
    return calls;
  }

  it("GET /api/s1/v1/products/{ref}/compliance بالتوكن ← نسخة منظفة (بلا تكرار/مسافات) + سجل", async () => {
    const calls = stubS1(() => Response.json(S1_JSON));
    expect(await refreshProductCompliance(asDb(db), WS, product.id)).toEqual({ ok: true });
    expect(calls[0].url).toBe("https://s1.zakai.io/api/s1/v1/products/pf_2031/compliance");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer s1-token-123456");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.redirect).toBe("manual");
    const view = (await getProductCompliance(asDb(db), product.id))!;
    expect(view).toMatchObject({
      productRef: "pf_2031",
      classification: "cosmetic",
      verdict: "allowed_with_rules",
      allowedClaims: ["يرطب البشرة", "مكونات طبيعية"],
      bannedClaims: ["يعالج الصدفية", "نتيجة مضمونة"],
      adRules: ["بلا صور قبل/بعد"],
      sourceUpdatedAt: "2026-10-10T12:00:00.000Z",
      lastError: null,
      stale: false,
    });
    expect(db._stores.auditLog.find((a) => a.action === "compliance.refreshed")!.metadata).toMatchObject({ productRef: "pf_2031", banned: 2, allowed: 2 });
  });

  it("فشل القراءة لا يمسح النسخة السابقة ويسجّل الخطأ · رد لمنتج آخر = BAD_RESPONSE", async () => {
    stubS1(() => Response.json(S1_JSON));
    await refreshProductCompliance(asDb(db), WS, product.id);
    stubS1(() => new Response("", { status: 500 }));
    expect(await refreshProductCompliance(asDb(db), WS, product.id)).toEqual({ ok: false, error: "HTTP 500" });
    let view = (await getProductCompliance(asDb(db), product.id))!;
    expect(view.bannedClaims).toEqual(["يعالج الصدفية", "نتيجة مضمونة"]);
    expect(view.lastError).toBe("HTTP 500");
    stubS1(() => Response.json({ ...S1_JSON, product_ref: "pf_9999", banned_claims: [] }));
    expect(await refreshProductCompliance(asDb(db), WS, product.id)).toEqual({ ok: false, error: "BAD_RESPONSE" });
    view = (await getProductCompliance(asDb(db), product.id))!;
    expect(view.bannedClaims).toHaveLength(2);
    expect(view.lastError).toBe("BAD_RESPONSE");
    stubS1(() => new Response("<html>", { status: 200 }));
    expect(await refreshProductCompliance(asDb(db), WS, product.id)).toEqual({ ok: false, error: "BAD_JSON" });
  });

  it("منتج بلا مرجع · سيستم 1 غير مربوط = لا نداء · منتج مساحة أخرى = غير موجود", async () => {
    const calls = stubS1(() => Response.json(S1_JSON));
    const plain = (await db.product.create({ data: { workspaceId: WS, sku: "P-2", name: "بلا مرجع", price: 1 } } as never)) as Row;
    expect(await refreshProductCompliance(asDb(db), WS, plain.id)).toEqual({ ok: false, error: "NO_S1_REF" });
    await saveIntegrationConnection(asDb(db), ctx, "s1", { enabled: false });
    expect(await refreshProductCompliance(asDb(db), WS, product.id)).toEqual({ ok: false, error: "S1_NOT_CONNECTED" });
    expect(calls).toHaveLength(0);
    await expect(refreshProductCompliance(asDb(db), WS_B, product.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it(`النسخة «قديمة» بعد ${COMPLIANCE_STALE_HOURS} ساعة (أو بلا قراءة)`, () => {
    const now = new Date("2026-10-11T00:00:00Z");
    const row = (hoursAgo: number | null) => ({
      productRef: "pf",
      classification: null,
      verdict: null,
      allowedClaims: [],
      bannedClaims: [],
      adRules: [],
      sourceUpdatedAt: null,
      fetchedAt: hoursAgo === null ? null : new Date(now.getTime() - hoursAgo * HOUR),
      lastError: null,
    });
    expect(toComplianceView(row(COMPLIANCE_STALE_HOURS - 1), now)!.stale).toBe(false);
    expect(toComplianceView(row(COMPLIANCE_STALE_HOURS + 1), now)!.stale).toBe(true);
    expect(toComplianceView(row(null), now)!.stale).toBe(true);
    expect(toComplianceView(null, now)).toBeNull();
  });

  it("compliance.updated ← مهمة إعادة قراءة بمفتاح الحدث (لا قراءة داخل الطلب) — product_ref إلزامي", async () => {
    expect(await onComplianceUpdated(asDb(db), WS, "evt_s1_1", { product_ref: " pf_2031 " })).toBe(true);
    expect(await onComplianceUpdated(asDb(db), WS, "evt_s1_1", { product_ref: "pf_2031" })).toBe(true);
    const jobs = db._stores.backgroundJob.filter((j) => j.type === "refresh_product_compliance");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ workspaceId: WS, payload: { productRef: "pf_2031" }, idempotencyKey: "compliance:pf_2031:evt_s1_1" });
    await expect(onComplianceUpdated(asDb(db), WS, "evt_s1_2", {})).rejects.toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
    await expect(onComplianceUpdated(asDb(db), WS, "evt_s1_3", { product_ref: "x".repeat(65) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("مهمة refresh_product_compliance: كل منتجات المرجع · سيستم 1 واقف = إعادة · بلا مرجع/اتصال = لا إعادة", async () => {
    const twin = (await db.product.create({ data: { workspaceId: WS, sku: "CR-2", name: "كريم 2", price: 100, s1ProductRef: "pf_2031" } } as never)) as Row;
    stubS1(() => Response.json(S1_JSON));
    expect(await refreshComplianceJob(asDb(db), WS, { productRef: "pf_2031" })).toEqual({ success: true });
    expect(db._stores.productCompliance.map((r) => r.productId).sort()).toEqual([product.id, twin.id].sort());
    stubS1(() => new Response("", { status: 503 }));
    expect((await refreshComplianceJob(asDb(db), WS, { productId: product.id })).success).toBe(false);
    await saveIntegrationConnection(asDb(db), ctx, "s1", { enabled: false });
    expect(await refreshComplianceJob(asDb(db), WS, { productId: product.id })).toEqual({ success: true });
  });

  it("setProductS1Ref: صيغة المرجع ثم قراءة فورية", async () => {
    const p = (await db.product.create({ data: { workspaceId: WS, sku: "P-3", name: "منتج", price: 1 } } as never)) as Row;
    await expect(setProductS1Ref(asDb(db), ctx, p.id, "pf 1/../x")).rejects.toMatchObject({ code: "INVALID_S1_REF" });
    stubS1(() => Response.json({ ...S1_JSON, product_ref: "pf_77" }));
    const view = await setProductS1Ref(asDb(db), ctx, p.id, " pf_77 ");
    expect(db._stores.product.find((x) => x.id === p.id)!.s1ProductRef).toBe("pf_77");
    expect(view).toMatchObject({ productRef: "pf_77", bannedClaims: ["يعالج الصدفية", "نتيجة مضمونة"] });
  });
});

describe("P12 findBannedClaims — مطابقة بعد تطبيع العربي", () => {
  it.each([
    ["المنتج يُعالِج الصُّدَفِيّة بسرعة", ["يعالج الصدفية"]],
    ["نتيجه مضمونه من أول أسبوع", ["نتيجة مضمونة"]],
    ["نتيجةٌ، مضمونة!", ["نتيجة مضمونة"]],
    ["أفضل علاج طبيعي", ["افضل علاج طبيعي"]],
    ["إشفى بسرعة", ["اشفي بسرعه"]],
    ["مضمـــونة 100%", ["مضمونة 100"]],
    ["It CURES acne fast", ["cures acne"]],
  ])("«%s» يطابق %j", (text, banned) => {
    expect(findBannedClaims(text, banned)).toEqual(banned);
  });

  it("لا مطابقة لنص نظيف · ادعاء أقصر من 3 حروف يُتجاهل · قائمة فارغة = لا شيء", () => {
    expect(findBannedClaims("كريم مرطب بمكونات طبيعية", ["يعالج الصدفية", "نتيجة مضمونة"])).toEqual([]);
    expect(findBannedClaims("ب ب ب", ["ب"])).toEqual([]);
    expect(findBannedClaims("أي نص", [])).toEqual([]);
    expect(findBannedClaims("", ["نتيجة مضمونة"])).toEqual([]);
  });
});

// ───────────────────────────── حارس الرد بالذكاء ─────────────────────────────

describe("P12 AI guardrail — ادعاء ممنوع للمنتج = BANNED_CLAIM", () => {
  const product = (compliance?: { allowedClaims: string[]; bannedClaims: string[]; verdict: string | null } | null): AIContext => ({
    product: {
      id: "p1",
      name: "كريم",
      sku: "CR-1",
      price: "100",
      currency: "USD",
      compareAtPrice: null,
      stockStatus: "IN_STOCK",
      shortDescription: null,
      description: null,
      benefits: [],
      usage: null,
      warnings: null,
      ingredients: null,
      objections: [],
      salesNotes: null,
      faqs: [],
      ...(compliance !== undefined ? { compliance } : {}),
    },
    knowledge: { faqs: [], documents: [] },
    feedback: [],
    media: [],
    citations: [],
  });

  it("الرد اللي فيه ادعاء ممنوع (حتى بلا تشكيل/بتاء مربوطة مختلفة) يُرفض", () => {
    const ctxWith = product({ allowedClaims: [], bannedClaims: ["نتيجة مضمونة"], verdict: "restricted" });
    const res = validateResponse({ response: "كريمنا نتيجه مضمونه من أول أسبوع 🌹", context: ctxWith });
    expect(res.valid).toBe(false);
    expect(res.violations).toContain("BANNED_CLAIM");
    expect(validateResponse({ response: "كريمنا بيرطب البشرة 🌹", context: ctxWith }).valid).toBe(true);
  });

  it("بلا قواعد امتثال (أو قائمة فارغة) لا يوجد BANNED_CLAIM", () => {
    const text = "كريمنا نتيجة مضمونة";
    expect(validateResponse({ response: text, context: product() }).violations).not.toContain("BANNED_CLAIM");
    expect(validateResponse({ response: text, context: product(null) }).violations).not.toContain("BANNED_CLAIM");
    expect(validateResponse({ response: text, context: product({ allowedClaims: [], bannedClaims: [], verdict: null }) }).violations).not.toContain("BANNED_CLAIM");
  });

  it("buildProductContext يمرر قواعد المنتج للحارس (ولا يمرر شيئًا بلا نسخة)", async () => {
    const db = fake();
    const p = (await createProduct(asDb(db), ctx, { name: "كريم", sku: "CR-9", price: 100, currency: "USD" } as never)) as Row;
    expect((await buildProductContext(asDb(db), WS, p.id)).product).not.toHaveProperty("compliance");
    db._stores.productCompliance.push({ id: "pc1", workspaceId: WS, productId: p.id, productRef: "pf_1", verdict: "restricted", allowedClaims: ["يرطب"], bannedClaims: ["نتيجة مضمونة"], adRules: [], fetchedAt: new Date() });
    const built = await buildProductContext(asDb(db), WS, p.id);
    expect(built.product!.compliance).toEqual({ allowedClaims: ["يرطب"], bannedClaims: ["نتيجة مضمونة"], verdict: "restricted" });
  });
});

describe("P12 AI pipeline — الادعاء الممنوع لا يصل للزبون (مسار processAIMessage الحي)", () => {
  let db: FakeDb;
  let mock: MockAIProvider;
  let conversationId: string;
  let messageId: string;

  beforeEach(async () => {
    db = fake();
    mock = new MockAIProvider();
    setMockAIProvider(mock);
    db._stores.workspaceMember.push({ id: "m1", workspaceId: WS, userId: "owner-1", status: "ACTIVE" });
    const ch = (await db.channel.create({ data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "Page", externalId: "page-1" } } as never)) as Row;
    await db.channelAccount.create({
      data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-1", pageName: "Page", encryptedCredentials: encryptSecret("page-token") },
    } as never);
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async (url: string, init?: { body?: string }) => {
            if (new URL(String(url)).pathname.endsWith("/me/messages")) {
              const to = JSON.parse(String(init?.body ?? "{}"))?.recipient?.id ?? "psid";
              return Response.json({ recipient_id: to, message_id: `mid-${to}` });
            }
            return Response.json({ id: "page-1", name: "Page" });
          }) as unknown as typeof fetch,
        })
    );
    await db.aISettings.create({ data: { workspaceId: WS, provider: "mock", temperature: 0.4, maxTokens: 500 } } as never);
    const p = (await createProduct(asDb(db), ctx, { name: "ماء الكمأة", sku: "TW-500", price: 150000, currency: "SYP" } as never)) as Row;
    db._stores.productCompliance.push({ id: "pc1", workspaceId: WS, productId: p.id, productRef: "pf_1", verdict: "restricted", allowedClaims: ["مكونات طبيعية"], bannedClaims: ["نتيجة مضمونة"], adRules: [], fetchedAt: new Date() });
    await db.persona.create({ data: { workspaceId: WS, name: "سارة", dialect: "syrian", prohibitedPhrases: [], customRules: [] } } as never);
    const r = await processIncomingMessage(asDb(db), {
      workspaceId: WS,
      channelType: "FACEBOOK",
      externalUserId: "fb-user-1",
      externalConversationId: "fb-conv-1",
      externalMessageId: "fb-msg-1",
      externalEventId: "fb-evt-1",
      provider: "mock",
      type: "TEXT",
      text: "مرحبا، بكم ماء الكمأة؟",
    });
    conversationId = r.conversationId;
    messageId = r.messageId;
  });
  afterEach(() => {
    setMockAIProvider(undefined);
    setFacebookClientFactory(null as never);
  });
  const vectors = () => new InMemoryVectorStore(new Map(), new Map());
  const aiMessages = () => db._stores.message.filter((m) => m.senderType === "AI");

  it("القواعد تصل للموديل، والرد الممنوع مرتين = AI_FAILED بلا إرسال", async () => {
    const systems: string[] = [];
    mock.responseHandler = (_user, system) => {
      systems.push(system);
      return "ماء الكمأة نتيجه مضمونه من أول أسبوع 🌹";
    };
    const res = await processAIMessage(asDb(db), { workspaceId: WS, conversationId, messageId }, { vectorStore: vectors() });
    expect(res.status).toBe("AI_FAILED");
    expect(aiMessages()).toHaveLength(0);
    expect(systems).toHaveLength(2);
    expect(systems[0]).toContain("نتيجة مضمونة");
    expect(systems[1]).toContain("BANNED_CLAIM");
    expect(db._stores.aIUsageLog.some((l) => String(l.error ?? "").includes("BANNED_CLAIM"))).toBe(true);
  });

  it("إعادة توليد واحدة نظيفة تُرسل بدل الرد الممنوع", async () => {
    let n = 0;
    mock.responseHandler = () => (++n === 1 ? "نتيجة مضمونة 100% 🌹" : "ماء الكمأة بمكونات طبيعية 🌹");
    const res = await processAIMessage(asDb(db), { workspaceId: WS, conversationId, messageId }, { vectorStore: vectors() });
    expect(res.status).toBe("RESPONDED");
    expect(res.response).toBe("ماء الكمأة بمكونات طبيعية 🌹");
    expect(aiMessages().map((m) => m.text)).toEqual(["ماء الكمأة بمكونات طبيعية 🌹"]);
  });
});

// ───────────────────────────── الإشارات التشغيلية ─────────────────────────────

describe("P12 ops-signals — المالية · الأزمات · المهام · مساحة العمل", () => {
  let db: FakeDb;
  beforeEach(async () => {
    db = fake({ serverCostUsdPerDay: "3.50" }, { slaHandoffResolutionMinutes: 30 });
    await saveIntegrationConnection(asDb(db), ctx, "finance", { baseUrl: "https://finance.zakai.io", token: "fin-token-1" });
    await saveIntegrationConnection(asDb(db), ctx, "crisis", { baseUrl: "https://crisis.zakai.io", token: "crisis-token-1" });
    await saveIntegrationConnection(asDb(db), ctx, "tasks", { baseUrl: "https://tasks.zakai.io", token: "tasks-token-1" });
    await saveIntegrationConnection(asDb(db), ctx, "workspace", { baseUrl: "https://ws.zakai.io", token: "ws-token-1" });
  });
  const calls = (system: string) => deliveries(db, { system, kind: "call" });
  const log = (at: string, o: Row) => db._stores.aIUsageLog.push({ id: `l-${Math.random()}`, workspaceId: WS, provider: "openrouter", costUsd: 0, intent: null, messageId: null, createdAt: new Date(at), ...o });

  it("zonedDayRange: يوم المساحة بتوقيتها (عمّان +03:00)", () => {
    const r = zonedDayRange("2026-10-10", "Asia/Amman");
    expect(r.start.toISOString()).toBe("2026-10-09T21:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-10-10T21:00:00.000Z");
  });

  it("تقرير التكاليف اليومي: يوم مبارح بتوقيت المساحة · المعروف فقط · مفتاح replies-usage-التاريخ · مرة واحدة", async () => {
    log("2026-10-09T21:30:00Z", { costUsd: 1.0 }); // 00:30 عمّان يوم 10 ✔
    log("2026-10-10T15:00:00Z", { costUsd: 0.84 }); // ✔
    log("2026-10-10T15:00:00Z", { provider: "openai", costUsd: null }); // كلفة غير معروفة ✘
    log("2026-10-10T15:00:00Z", { provider: "anthropic", costUsd: 0 }); // صفر ✘
    log("2026-10-10T22:30:00Z", { costUsd: 9 }); // 01:30 عمّان يوم 11 ✘
    log("2026-10-10T15:00:00Z", { workspaceId: WS_B, costUsd: 5 }); // مساحة أخرى ✘
    const now = new Date("2026-10-11T06:00:00Z"); // 09:00 عمّان
    expect(await enqueueDailyUsageReport(asDb(db), WS, now)).toBe(true);
    const [row] = calls("finance");
    expect(row).toMatchObject({ type: "usage-costs", url: "https://finance.zakai.io/api/v1/usage-costs", idempotencyKey: "replies-usage-2026-10-10" });
    expect(bodyOf(row)).toEqual({
      system: "replies",
      date: "2026-10-10",
      items: [
        { kind: "model_api", provider: "openrouter", amount: "1.84", currency: "USD" },
        { kind: "server", provider: "main", amount: "3.50", currency: "USD" },
      ],
    });
    expect(findPii(bodyOf(row))).toEqual([]);
    expect(row.body).not.toContain("fin-token-1");
    await enqueueDailyUsageReport(asDb(db), WS, new Date(now.getTime() + HOUR));
    expect(calls("finance")).toHaveLength(1);
  });

  it("لا كلفة معروفة = لا قيد صفري مخترع · المالية غير مربوطة = لا شيء", async () => {
    const db2 = fake();
    await saveIntegrationConnection(asDb(db2), ctx, "finance", { baseUrl: "https://finance.zakai.io", token: "fin-token-1" });
    db2._stores.aIUsageLog.push({ id: "l1", workspaceId: WS, provider: "openai", costUsd: null, createdAt: new Date("2026-10-10T10:00:00Z") });
    expect(await enqueueDailyUsageReport(asDb(db2), WS, new Date("2026-10-11T06:00:00Z"))).toBe(false);
    expect(db2._stores.integrationDelivery).toHaveLength(0);
    const db3 = fake({ serverCostUsdPerDay: "3.50" });
    expect(await enqueueDailyUsageReport(asDb(db3), WS, new Date("2026-10-11T06:00:00Z"))).toBe(false);
  });

  it("توكن قناة انتهى/ينتهي خلال 72 ساعة = إنذار أزمات مرة باليوم لكل قناة", async () => {
    const now = new Date("2026-10-11T06:00:00Z");
    const mk = async (type: string, expiresInH: number | null, status = "CONNECTED") => {
      const ch = await channel(db, type, { status });
      await db.channelAccount.create({
        data: { channelId: ch.id, provider: type, externalAccountId: ch.externalId, encryptedCredentials: encryptSecret("t"), tokenExpiresAt: expiresInH === null ? null : new Date(now.getTime() + expiresInH * HOUR) },
      } as never);
      return ch;
    };
    const expiring = await mk("WHATSAPP", 48);
    const expired = await mk("FACEBOOK", -1);
    await mk("INSTAGRAM", 100);
    await mk("TELEGRAM", -5, "DISCONNECTED");
    await mk("TIKTOK", null);
    expect(await enqueueChannelHealthAlerts(asDb(db), WS, now)).toBe(2);
    const rows = calls("crisis");
    expect(rows).toHaveLength(2);
    const byType = new Map(rows.map((r) => [bodyOf(r).type, bodyOf(r)]));
    expect(byType.get("replies_channel_token_expiring")).toMatchObject({ severity: "medium", channel: "whatsapp" });
    expect(byType.get("replies_channel_token_expired")).toMatchObject({ severity: "high", channel: "facebook" });
    // مرجع/مفتاح لكل قناة لكل يوم (لا يتكرر باليوم نفسه).
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2);
    for (const ch of [expiring, expired]) {
      expect(rows.filter((r) => r.dedupeKey.includes(ch.id) && r.dedupeKey.includes("2026-10-11"))).toHaveLength(1);
    }
    for (const r of rows) {
      expect(bodyOf(r).external_ref).toMatch(/2026-10-11$/);
      expect(findPii(bodyOf(r))).toEqual([]);
    }
    await enqueueChannelHealthAlerts(asDb(db), WS, new Date(now.getTime() + 2 * HOUR));
    expect(calls("crisis")).toHaveLength(2);
  });

  it("تحويلات بشرية أقدم من مهلة الحل = مهمة واحدة باليوم (بلا بيانات زبون)", async () => {
    const now = new Date("2026-10-11T08:00:00Z");
    const handoff = (minsAgo: number, status = "OPEN") =>
      db._stores.humanHandoff.push({ id: `h-${Math.random()}`, workspaceId: WS, conversationId: "c", customerId: "cu", reason: "CUSTOMER_REQUEST", status, createdAt: new Date(now.getTime() - minsAgo * MIN) });
    handoff(10);
    handoff(120, "RESOLVED");
    expect(await enqueueOverdueHandoffTask(asDb(db), WS, now)).toBe(false);
    handoff(45);
    handoff(90);
    expect(await enqueueOverdueHandoffTask(asDb(db), WS, now)).toBe(true);
    const [row] = calls("tasks");
    expect(row.url).toBe("https://tasks.zakai.io/api/v1/tasks");
    expect(row.idempotencyKey).toMatch(/2026-10-11$/); // مهمة واحدة لليوم
    const body = bodyOf(row);
    expect(body).toMatchObject({ assignee_role: "support_lead", due: "2026-10-11" });
    expect(body.external_ref).toMatch(/2026-10-11$/);
    expect(body.title).toContain("2");
    expect(body.title).toContain("30");
    expect(findPii(body)).toEqual([]);
    await enqueueOverdueHandoffTask(asDb(db), WS, new Date(now.getTime() + HOUR));
    expect(calls("tasks")).toHaveLength(1);
  });

  it("فكرة الأسبوع: أكثر مواضيع الأسئلة (أعداد فقط) — رسالة واحدة تُعد مرة · أقدم من 7 أيام لا", async () => {
    const now = new Date("2026-10-11T08:00:00Z");
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY).toISOString();
    log(at(1), { intent: "PRICE_QUESTION", messageId: "m1" });
    log(at(1), { intent: "PRICE_QUESTION", messageId: "m1" }); // نفس الرسالة (استخراج + رد)
    log(at(2), { intent: "PRICE_QUESTION", messageId: "m2" });
    log(at(3), { intent: "PRICE_QUESTION", messageId: "m3" });
    log(at(2), { intent: "DELIVERY_QUESTION", messageId: "m4" });
    log(at(2), { intent: "DELIVERY_QUESTION", messageId: "m5" });
    log(at(2), { intent: "GREETING", messageId: "m6" }); // ليس سؤالًا معرّفًا
    log(at(8), { intent: "COMPLAINT", messageId: "m7" }); // خارج الأسبوع
    expect(await enqueueWeeklyQuestionsIdea(asDb(db), WS, now)).toBe(true);
    const [row] = calls("workspace");
    const body = bodyOf(row);
    expect(row.url).toBe("https://ws.zakai.io/api/v1/ideas");
    expect(body.summary).toContain("السعر 3");
    expect(body.summary).toContain("التوصيل 2");
    expect(body.summary).not.toContain("الشكاوى");
    expect(body.external_ref).toMatch(/^rep-idea-2026-w\d+$/);
    expect(findPii(body)).toEqual([]);
    expect(await enqueueWeeklyQuestionsIdea(asDb(fake()), WS, now)).toBe(false);
  });
});

// ─────────────────────────────── مجدول الربط ───────────────────────────────

describe("P12 runIntegrationScheduler — الإيقاع والشروط", () => {
  let fetchCalls: string[];
  beforeEach(() => {
    resetIntegrationScheduler();
    fetchCalls = [];
    vi.stubGlobal("fetch", (async (url: string) => {
      fetchCalls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
  });

  it("القدرة كل 5 دقائق والمهام الساعية كل ساعة — بين الدورات ما في تقييم", async () => {
    const T = new Date("2026-10-11T07:00:00.000Z"); // 10:00 عمّان
    freeze(T);
    const db = fake({ capacityUnansweredWarn: 1, capacityP50WarnMin: 1000, capacityCriticalMultiplier: 2 });
    await saveIntegrationConnection(asDb(db), ctx, "mediabuyer", { baseUrl: "https://mb.zakai.io", generateEventsSecret: true });
    await saveIntegrationConnection(asDb(db), ctx, "crisis", { baseUrl: "https://crisis.zakai.io", token: "crisis-token-1" });
    const wa = await channel(db, "WHATSAPP");
    const expiring = async (ch: Row) =>
      db.channelAccount.create({ data: { channelId: ch.id, provider: "WHATSAPP", externalAccountId: ch.externalId, encryptedCredentials: encryptSecret("t"), tokenExpiresAt: new Date(Date.now() + 24 * HOUR) } } as never);
    await expiring(wa);
    await conv(db, wa, { lastCustomerMessageAt: new Date(T.getTime() - 10 * MIN) });
    const capLevels = () => deliveries(db, { type: "capacity.alert" }).map((d) => bodyOf(d).data.level);
    const channelAlerts = () => deliveries(db, { system: "crisis" }).filter((d) => bodyOf(d).type?.startsWith("replies_channel_token"));

    await runIntegrationScheduler(asDb(db), new Date());
    expect(capLevels()).toEqual(["warning"]);
    expect(channelAlerts()).toHaveLength(1);

    // بعد دقيقة: صار حرج + قناة جديدة توكنها بينتهي — لا شيء قبل موعده.
    vi.setSystemTime(T.getTime() + MIN);
    await conv(db, wa, { lastCustomerMessageAt: new Date(Date.now() - MIN) });
    const wa2 = await channel(db, "WHATSAPP", { externalId: "wa-2" });
    await expiring(wa2);
    await runIntegrationScheduler(asDb(db), new Date());
    expect(capLevels()).toEqual(["warning"]);
    expect(channelAlerts()).toHaveLength(1);
    // الصادر المستحق يُرسل بكل دورة (fetch مستبدل — لا شبكة).
    expect(fetchCalls).toContain("https://mb.zakai.io/api/v1/webhooks/replies");

    vi.setSystemTime(T.getTime() + 5 * MIN);
    await runIntegrationScheduler(asDb(db), new Date());
    expect(capLevels()).toEqual(["warning", "critical"]);
    expect(channelAlerts()).toHaveLength(1);

    vi.setSystemTime(T.getTime() + 60 * MIN);
    await runIntegrationScheduler(asDb(db), new Date());
    expect(channelAlerts()).toHaveLength(2);
  });

  it("مساحة بلا اتصالات مفعّلة = لا تقييم قدرة · القدرة فقط مع ميديا باير/جسر/أزمات", async () => {
    freeze(new Date("2026-10-11T07:00:00.000Z"));
    const db = fake({ capacityUnansweredWarn: 1 });
    await saveIntegrationConnection(asDb(db), ctx, "mediabuyer", { baseUrl: "https://mb.zakai.io", generateEventsSecret: true, enabled: false });
    await saveIntegrationConnection(asDb(db), ctx, "finance", { baseUrl: "https://finance.zakai.io", token: "fin-token-1" });
    await conv(db, await channel(db, "WHATSAPP"), { lastCustomerMessageAt: new Date(Date.now() - MIN) });
    await runIntegrationScheduler(asDb(db), new Date());
    expect(deliveries(db, { type: "capacity.alert" })).toHaveLength(0);
  });

  it("ساعات العمل بتوقيت المساحة: المالية من الساعة 1 · المهام 9–22 · فكرة الأسبوع الأحد بعد 9", async () => {
    const db = fake({ serverCostUsdPerDay: "1.00" });
    await saveIntegrationConnection(asDb(db), ctx, "finance", { baseUrl: "https://finance.zakai.io", token: "fin-token-1" });
    await saveIntegrationConnection(asDb(db), ctx, "tasks", { baseUrl: "https://tasks.zakai.io", token: "tasks-token-1" });
    await saveIntegrationConnection(asDb(db), ctx, "workspace", { baseUrl: "https://ws.zakai.io", token: "ws-token-1" });
    db._stores.humanHandoff.push({ id: "h1", workspaceId: WS, status: "OPEN", createdAt: new Date("2026-10-01T00:00:00Z") });
    db._stores.aIUsageLog.push({ id: "l1", workspaceId: WS, provider: "x", costUsd: null, intent: "PRICE_QUESTION", messageId: "m1", createdAt: new Date("2026-10-10T10:00:00Z") });
    const run = async (iso: string) => {
      resetIntegrationScheduler();
      freeze(new Date(iso));
      await runIntegrationScheduler(asDb(db), new Date());
    };
    const count = (system: string) => deliveries(db, { system, kind: "call" }).length;

    await run("2026-10-10T21:30:00Z"); // الأحد 00:30 عمّان
    expect([count("finance"), count("tasks"), count("workspace")]).toEqual([0, 0, 0]);
    await run("2026-10-11T07:00:00Z"); // الأحد 10:00 عمّان
    expect([count("finance"), count("tasks"), count("workspace")]).toEqual([1, 1, 1]);
    await run("2026-10-12T20:00:00Z"); // الإثنين 23:00 عمّان
    expect([count("finance"), count("tasks"), count("workspace")]).toEqual([2, 1, 1]);
    const days = deliveries(db, { system: "finance" }).map((d) => bodyOf(d).date);
    expect(days).toEqual(["2026-10-10", "2026-10-11"]);
  });

  it("سيستم 1: منتجات مربوطة نسختها أقدم من 24 ساعة (أو بلا نسخة) ← مهمة قراءة يومية", async () => {
    const now = new Date("2026-10-11T07:00:00.000Z");
    freeze(now);
    const db = fake();
    await saveIntegrationConnection(asDb(db), ctx, "s1", { baseUrl: "https://s1.zakai.io", token: "s1-token-1", generateEventsSecret: true });
    const p = async (sku: string, o: Row) => (await db.product.create({ data: { workspaceId: WS, sku, name: sku, price: 1, ...o } } as never)) as Row;
    const never = await p("A", { s1ProductRef: "pf_a" });
    const stale = await p("B", { s1ProductRef: "pf_b" });
    const fresh = await p("C", { s1ProductRef: "pf_c" });
    await p("D", { s1ProductRef: "pf_d", isActive: false });
    await p("E", { s1ProductRef: null });
    db._stores.productCompliance.push(
      { id: "x1", workspaceId: WS, productId: stale.id, productRef: "pf_b", fetchedAt: new Date(now.getTime() - 25 * HOUR) },
      { id: "x2", workspaceId: WS, productId: fresh.id, productRef: "pf_c", fetchedAt: new Date(now.getTime() - 2 * HOUR) }
    );
    await runIntegrationScheduler(asDb(db), now);
    const jobs = db._stores.backgroundJob.filter((j) => j.type === "refresh_product_compliance");
    expect(jobs.map((j) => j.payload.productId).sort()).toEqual([never.id, stale.id].sort());
    expect(jobs.map((j) => j.idempotencyKey).sort()).toEqual([`compliance-daily:${never.id}:2026-10-11`, `compliance-daily:${stale.id}:2026-10-11`].sort());
  });

  it(`الكليبر: النتيجة النهائية بعد ${RETARGET_FINAL_AFTER_HOURS} ساعة من انتهاء الحملة — مرة واحدة`, async () => {
    const now = new Date("2026-10-11T07:00:00.000Z");
    freeze(now);
    const db = fake();
    await saveIntegrationConnection(asDb(db), ctx, "clipper", { baseUrl: "https://clipper.zakai.io", token: "clp-token-1", generateEventsSecret: true });
    const camp = (id: string, o: Row) =>
      db._stores.campaign.push({ id, workspaceId: WS, segmentId: "s", channelType: "WHATSAPP", status: "COMPLETED", approvedAt: now, externalSystem: "clipper", externalRef: `ref-${id}`, finalResultsSentAt: null, updatedAt: new Date(now.getTime() - 73 * HOUR), ...o });
    camp("cold0000000000000000000001", {});
    camp("crecent00000000000000000002", { updatedAt: new Date(now.getTime() - 10 * HOUR) });
    camp("crunning0000000000000000003", { status: "RUNNING" });
    camp("cmanual00000000000000000004", { externalSystem: null });
    camp("cdone0000000000000000000005", { finalResultsSentAt: new Date(now.getTime() - HOUR) });
    await runIntegrationScheduler(asDb(db), now);
    const results = deliveries(db, { type: "retarget.result" }).map((d) => bodyOf(d).data);
    expect(results.map((r) => r.campaign_id)).toEqual(["rep_rt_cold0000000000000000000001"]);
    expect(results[0]).toMatchObject({ final: true, status: "completed", external_ref: "ref-cold0000000000000000000001" });
    resetIntegrationScheduler();
    vi.setSystemTime(now.getTime() + 2 * HOUR);
    await runIntegrationScheduler(asDb(db), new Date());
    expect(deliveries(db, { type: "retarget.result" })).toHaveLength(1);
  });
});
