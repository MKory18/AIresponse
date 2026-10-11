import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/inmemory-db";
import type { Db } from "@/modules/customers/service";
import { handleOmsStatusChanged } from "@/modules/oms/webhook";
import { saveOmsConnection } from "@/modules/oms/connection";
import { evaluateCapacityAlerts, computeCapacity } from "@/modules/integrations/capacity";
import { saveIntegrationConnection, setIntegrationDnsLookup } from "@/modules/integrations/connections";
import { deliverDueIntegrations, emitIntegrationEvent } from "@/modules/integrations/outbox";
import { createRetargetCampaign, emitRetargetResult, validateCodeTouch } from "@/modules/integrations/clipper";
import { applyOptOut } from "@/modules/integrations/consent";
import { captureAttribution } from "@/modules/integrations/attribution";
import { setSystemFetch } from "@/modules/integrations/http";
import { enqueueJob } from "@/modules/jobs/service";
import { getAgentAnalytics } from "@/modules/analytics/agents";
import { buildProductContext } from "@/modules/ai/context-builder";
import { conversationRef } from "@/modules/integrations/format";

/**
 * P12 — تصليحات مراجعة الاختبارات المستقلة (كل اختبار هون كان رح يفشل
 * على الكود قبل التصليح): مطابقة الـ OMS · إلغاء بعد الشحن · إنذار بعد
 * «رجع طبيعي» بنفس الساعة · سباق طلبين بنفس المفتاح · نتيجة نهائية ما
 * بتنعلّم إذا ما انبعتت · قناة opt_out · DNS لحظة الإرسال · تكرار المهام ·
 * موظف وهمي «campaign-system» · قراءة قواعد ناقصة · رد رمز غامض.
 */

const WS = "ws-fix-0001";
const ctx = { userId: "owner-1", workspaceId: WS };
type FakeDb = ReturnType<typeof createFakeDb>;
type Row = Record<string, any>;
const asDb = (d: FakeDb) => d as unknown as Db;
const MIN = 60_000;

let dns: (host: string) => Promise<Array<{ address: string; family: number }>> = async () => [{ address: "93.184.216.34", family: 4 }];
beforeAll(() => setIntegrationDnsLookup((h) => dns(h)));
afterAll(() => setIntegrationDnsLookup(null));
afterEach(() => {
  vi.useRealTimers();
  setSystemFetch(null);
  dns = async () => [{ address: "93.184.216.34", family: 4 }];
});

function fake(settings: Row = {}): FakeDb {
  const db = createFakeDb();
  db._stores.workspace.push({ id: WS, name: "Zaki", slug: "zaki", timezone: "Asia/Amman", integrationSettings: settings });
  return db;
}

describe("OMS — الأحداث بعد التصليح", () => {
  it("إلغاء من الـ OMS بعد «بالتوصيل» = FAILED محليًا (مش تجاهل) والمرآة CANCELLED", async () => {
    const db = fake();
    const order = (await db.order.create({ data: { workspaceId: WS, orderNumber: "O1", status: "OUT_FOR_DELIVERY", omsOrderId: "oms-1" } } as never)) as Row;
    const r = await handleOmsStatusChanged(asDb(db), { event: "order-status-changed", workspaceId: WS, omsOrderId: "oms-1", status: "CANCELLED", eventId: "app:d1", occurredAt: "2026-10-11T08:00:00Z" } as never);
    expect(r.appliedLocalStatus).toBe("FAILED");
    const row = db._stores.order.find((o) => o.id === order.id)!;
    expect(row).toMatchObject({ status: "FAILED", omsStatus: "CANCELLED" });
  });

  it("حدثين بنفس اللحظة بمعرّفي تسليم مختلفين: التاني مش «قديم» · نفس التسليم مكرر = تكرار", async () => {
    const db = fake();
    await db.order.create({ data: { workspaceId: WS, orderNumber: "O2", status: "CONFIRMED", omsOrderId: "oms-2" } } as never);
    const at = "2026-10-11T08:00:00.000Z";
    const a = await handleOmsStatusChanged(asDb(db), { event: "order-status-changed", workspaceId: WS, omsOrderId: "oms-2", status: "SHIPPED", eventId: "app:d1", occurredAt: at } as never);
    const b = await handleOmsStatusChanged(asDb(db), { event: "order-status-changed", workspaceId: WS, omsOrderId: "oms-2", status: "DELIVERED", eventId: "app:d2", occurredAt: at } as never);
    expect(a.appliedLocalStatus).toBe("OUT_FOR_DELIVERY");
    expect(b).toMatchObject({ stale: false, appliedLocalStatus: "DELIVERED" });
    const dup = await handleOmsStatusChanged(asDb(db), { event: "order-status-changed", workspaceId: WS, omsOrderId: "oms-2", status: "DELIVERED", eventId: "app:d2", occurredAt: at } as never);
    expect(dup.duplicate).toBe(true);
  });

  it("التحويل للوضع اليدوي بيطفّي الترحيل التلقائي فعليًا — الرجوع للـ API ما بيرجّعه بصمت", async () => {
    const db = fake();
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zakai.io", token: "oms-real-token-1", mode: "api", autoHandoff: true });
    expect(db._stores.omsConnection[0].autoHandoff).toBe(true);
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zakai.io", mode: "manual" });
    expect(db._stores.omsConnection[0].autoHandoff).toBe(false);
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zakai.io", mode: "api" });
    expect(db._stores.omsConnection[0].autoHandoff).toBe(false);
  });
});

describe("قدرة الرد — إنذار بعد «رجع طبيعي» بنفس الساعة", () => {
  it("warning ← recovered ← warning بنفس الساعة = إنذار تاني فعلي (مش مبلوع بمفتاح الساعة)", async () => {
    const T = new Date("2026-10-11T09:05:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const db = fake({ capacityUnansweredWarn: 1, capacityP50WarnMin: 1000 });
    await saveIntegrationConnection(asDb(db), ctx, "mediabuyer", { baseUrl: "https://mb.zakai.io", generateEventsSecret: true });
    const wa = (await db.channel.create({ data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "wa", externalId: "pn" } } as never)) as Row;
    const cust = (await db.customer.create({ data: { workspaceId: WS } } as never)) as Row;
    const conv = (await db.conversation.create({ data: { workspaceId: WS, customerId: cust.id, channelId: wa.id, channelConversationId: "c1", status: "OPEN", lastCustomerMessageAt: new Date(T.getTime() - 5 * MIN), lastAgentMessageAt: null } } as never)) as Row;
    await db.message.create({ data: { workspaceId: WS, conversationId: conv.id, direction: "INBOUND", senderType: "CUSTOMER", isNote: false, createdAt: new Date(T.getTime() - 5 * MIN) } } as never);
    const levels = () => db._stores.integrationDelivery.map((d) => JSON.parse(d.body).data.level);

    expect(await evaluateCapacityAlerts(asDb(db), WS, new Date())).toBe("warning");
    // رد حقيقي → طبيعي.
    vi.setSystemTime(T.getTime() + 10 * MIN);
    db._stores.conversation[0].lastAgentMessageAt = new Date();
    await db.message.create({ data: { workspaceId: WS, conversationId: conv.id, direction: "OUTBOUND", senderType: "HUMAN", senderId: "u1", isNote: false, createdAt: new Date() } } as never);
    expect(await evaluateCapacityAlerts(asDb(db), WS, new Date())).toBe("ok");
    // الزبون رجع كتب → إنذار من جديد بنفس الساعة.
    vi.setSystemTime(T.getTime() + 20 * MIN);
    db._stores.conversation[0].lastCustomerMessageAt = new Date();
    await db.message.create({ data: { workspaceId: WS, conversationId: conv.id, direction: "INBOUND", senderType: "CUSTOMER", isNote: false, createdAt: new Date() } } as never);
    expect(await evaluateCapacityAlerts(asDb(db), WS, new Date())).toBe("warning");
    expect(levels()).toEqual(["warning", "recovered", "warning"]);
  });

  it("ملاحظة داخلية بعد رسالة الزبون مش رد — المحادثة بتضل بلا رد", async () => {
    const now = new Date("2026-10-11T09:00:00.000Z");
    const db = fake();
    const wa = (await db.channel.create({ data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "wa", externalId: "pn" } } as never)) as Row;
    const cust = (await db.customer.create({ data: { workspaceId: WS } } as never)) as Row;
    const conv = (await db.conversation.create({ data: { workspaceId: WS, customerId: cust.id, channelId: wa.id, channelConversationId: "c1", status: "OPEN", lastCustomerMessageAt: new Date(now.getTime() - 10 * MIN), lastAgentMessageAt: new Date(now.getTime() - 5 * MIN) } } as never)) as Row;
    await db.message.create({ data: { workspaceId: WS, conversationId: conv.id, direction: "INBOUND", senderType: "CUSTOMER", isNote: false, createdAt: new Date(now.getTime() - 10 * MIN) } } as never);
    await db.message.create({ data: { workspaceId: WS, conversationId: conv.id, direction: "OUTBOUND", senderType: "HUMAN", senderId: "u1", isNote: true, createdAt: new Date(now.getTime() - 5 * MIN) } } as never);
    expect((await computeCapacity(asDb(db), WS, now)).unanswered).toBe(1);
  });
});

describe("الكليبر — سباق · نتيجة نهائية · opt_out · رد رمز غامض", () => {
  async function clipperWorld(db: FakeDb) {
    await saveIntegrationConnection(asDb(db), ctx, "clipper", { baseUrl: "https://clipper.zakai.io", token: "clp-token-123", generateEventsSecret: true });
    await db.channel.create({ data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "wa", externalId: "pn" } } as never);
  }
  const body = {
    external_ref: "rt_19",
    channel: "whatsapp",
    segment: { kind: "messaged_no_order", code_prefix: null, days: [1, 7] },
    template_ref: "wa_tpl_offer_reminder_ar",
    frequency_cap: { per_person_days: 7 },
    opt_in_required: true,
    approved_by: "owner",
    approved_at: "2026-10-11T10:00:00+03:00",
  };

  it("طلبين متزامنين بنفس Idempotency-Key: التاني بيرجع حملة الأول (created:false) والنسخة اليتيمة ملغاة", async () => {
    const db = fake();
    await clipperWorld(db);
    const key = "clp-rt-rt_19-v1";
    const realUpdate = db.campaign.update.bind(db.campaign);
    let winnerId: string | null = null;
    (db.campaign as Row).update = async (args: Row) => {
      if (args.data?.externalIdempotencyKey === key && !winnerId) {
        // الطلب التاني كسب السباق لحظتها: حملة تانية أخدت المفتاح.
        const w = (await db.campaign.create({ data: { workspaceId: WS, status: "READY", externalIdempotencyKey: key, externalSystem: "clipper", externalRef: "rt_19", segmentId: "seg-w", channelType: "WHATSAPP" } } as never)) as Row;
        winnerId = w.id;
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      return realUpdate(args as never);
    };
    const res = await createRetargetCampaign(asDb(db), { workspaceId: WS, idempotencyKey: key, body });
    expect(res.created).toBe(false);
    expect(res.response.campaign_id).toBe(`rep_rt_${winnerId}`);
    const orphan = db._stores.campaign.find((c) => c.id !== winnerId)!;
    expect(orphan.status).toBe("CANCELLED");
  });

  it("إعادة تواصل بغير واتساب = RETARGET_WHATSAPP_ONLY (ما في حملة بنص «قالب واتساب» لتيليجرام)", async () => {
    const db = fake();
    await clipperWorld(db);
    await db.channel.create({ data: { workspaceId: WS, type: "TELEGRAM", status: "CONNECTED", displayName: "tg", externalId: "bot" } } as never);
    await expect(createRetargetCampaign(asDb(db), { workspaceId: WS, idempotencyKey: "clp-rt-tg-1", body: { ...body, channel: "telegram" } })).rejects.toMatchObject({
      code: "RETARGET_WHATSAPP_ONLY",
    });
    expect(db._stores.campaign).toHaveLength(0);
  });

  it("النتيجة النهائية ما بتنعلّم «انبعتت» إذا الكليبر موقوف — بتنبعت لما يرجع", async () => {
    const db = fake();
    await clipperWorld(db);
    const camp = (await db.campaign.create({ data: { workspaceId: WS, status: "COMPLETED", externalSystem: "clipper", externalRef: "rt_9", segmentId: "s", channelType: "WHATSAPP", finalResultsSentAt: null } } as never)) as Row;
    camp.id = `c${"a".repeat(24)}`;
    db._stores.campaign[0].id = camp.id;
    db._stores.integrationConnection[0].enabled = false;
    expect(await emitRetargetResult(asDb(db), camp.id, true)).toBe(false);
    expect(db._stores.campaign[0].finalResultsSentAt ?? null).toBeNull();
    db._stores.integrationConnection[0].enabled = true;
    expect(await emitRetargetResult(asDb(db), camp.id, true)).toBe(true);
    expect(db._stores.campaign[0].finalResultsSentAt).toBeTruthy();
  });

  it("opt_out بلا محادثة معروفة: القناة والمرجع من محادثة الرمز نفسها (مش web)", async () => {
    const db = fake();
    await clipperWorld(db);
    const cust = (await db.customer.create({ data: { workspaceId: WS, marketingConsent: "OPTED_IN" } } as never)) as Row;
    const conv = (await db.conversation.create({ data: { workspaceId: WS, customerId: cust.id, channelId: "ch", channelConversationId: "c9", status: "OPEN" } } as never)) as Row;
    await captureAttribution(asDb(db), { workspaceId: WS, customerId: cust.id, conversationId: conv.id, channelType: "WHATSAPP", eventKey: "m1", text: "رمز K7Q2" });
    await applyOptOut(asDb(db), { workspaceId: WS, customerId: cust.id, conversationId: null, channelType: null, source: "AGENT", userId: "u1" });
    const ev = db._stores.integrationDelivery.find((d) => d.type === "opt_out")!;
    expect(JSON.parse(ev.body).data).toEqual({ channel: "whatsapp", conversation_ref: conversationRef(conv.id), code: "K7Q2" });
  });

  it("رد الكليبر 200 بلا valid صريح = الرمز بيضل «غير متحقق» (مش صالح)", async () => {
    const db = fake();
    await clipperWorld(db);
    const cust = (await db.customer.create({ data: { workspaceId: WS } } as never)) as Row;
    const [touch] = await captureAttribution(asDb(db), { workspaceId: WS, customerId: cust.id, conversationId: "conv-x", channelType: "WHATSAPP", eventKey: "m1", text: "رمز K7Q2" });
    setSystemFetch((async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch);
    expect((await validateCodeTouch(asDb(db), touch.id)).success).toBe(true);
    expect(db._stores.attributionTouch[0].codeStatus).toBe("UNVERIFIED");
    expect(db._stores.integrationDelivery.filter((d) => d.type === "conversation.coded")).toHaveLength(0);
  });
});

describe("صندوق الصادر — DNS لحظة الإرسال", () => {
  it("اسم انحفظ سليم وبعدين صار يشير لعنوان بيانات السحابة = FAILED بلا ما ينبعت شي · فشل DNS مؤقت = إعادة", async () => {
    const db = fake();
    await saveIntegrationConnection(asDb(db), ctx, "clipper", { baseUrl: "https://clipper.zakai.io", generateEventsSecret: true });
    const conv = "conv-dns";
    await emitIntegrationEvent(asDb(db), { workspaceId: WS, type: "conversation.coded", data: { code: "K7Q2", channel: "whatsapp", conversation_ref: conversationRef(conv) }, dedupeKey: "d1" });
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    dns = async () => {
      throw new Error("ENOTFOUND");
    };
    await deliverDueIntegrations(asDb(db), { fetchImpl: fetchImpl as never });
    expect(db._stores.integrationDelivery[0]).toMatchObject({ status: "PENDING", error: "DNS_RESOLUTION_FAILED" });
    dns = async () => [{ address: "169.254.169.254", family: 4 }];
    db._stores.integrationDelivery[0].nextAttemptAt = new Date(0);
    await deliverDueIntegrations(asDb(db), { fetchImpl: fetchImpl as never });
    expect(db._stores.integrationDelivery[0]).toMatchObject({ status: "FAILED", error: "URL_REJECTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("تصليحات قديمة ظهرت مع P12", () => {
  it("enqueueJob بنفس المفتاح وهي نشطة = نفس المهمة (findFirst — مش findUnique على فريد جزئي)", async () => {
    const db = fake();
    const a = await enqueueJob(asDb(db), { workspaceId: WS, type: "refresh_product_compliance", payload: { productId: "p1" }, idempotencyKey: "k-1" });
    const b = await enqueueJob(asDb(db), { workspaceId: WS, type: "refresh_product_compliance", payload: { productId: "p1" }, idempotencyKey: "k-1" });
    expect(b).toMatchObject({ id: a.id, deduplicated: true });
    expect(db._stores.backgroundJob).toHaveLength(1);
  });

  it("أداء الموظفين: رسائل الحملات (HUMAN · campaign-system) مش موظف وهمي", async () => {
    const db = fake();
    const at = new Date("2026-10-10T10:00:00.000Z");
    await db.message.create({ data: { workspaceId: WS, conversationId: "c1", direction: "OUTBOUND", senderType: "HUMAN", senderId: "campaign-system", isNote: false, createdAt: at } } as never);
    await db.message.create({ data: { workspaceId: WS, conversationId: "c1", direction: "OUTBOUND", senderType: "HUMAN", senderId: "user-1", isNote: false, createdAt: at } } as never);
    const res = await getAgentAnalytics(asDb(db), WS, { range: "custom", from: "2026-10-10T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z", timezone: "UTC" } as never);
    expect(res.agents.map((a: Row) => a.agentId)).toEqual(["user-1"]);
  });

  it("منتج مربوط بسيستم 1 بلا نسخة قواعد: سياق الرد بيطلب قراءة فورية بالخلفية (مرة بالساعة)", async () => {
    const db = fake();
    const p = (await db.product.create({ data: { workspaceId: WS, name: "منتج", sku: "TIN01", price: "15.00", currency: "USD", s1ProductRef: "pf_1", isActive: true, faqs: [] } } as never)) as Row;
    await buildProductContext(asDb(db), WS, p.id);
    await buildProductContext(asDb(db), WS, p.id);
    const jobs = db._stores.backgroundJob.filter((j) => j.type === "refresh_product_compliance");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ productId: p.id });
  });
});
