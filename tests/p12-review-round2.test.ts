import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { parseOrderText } from "./helpers/oms-order-parser";
import type { Db } from "@/modules/customers/service";
import { encryptSecret } from "@/core/crypto";
import { eventBus, type DomainEvent } from "@/core/events/bus";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { setWhatsAppClientFactory, WhatsAppClient } from "@/modules/channels/whatsapp/client";
import { applyWhatsAppStatuses } from "@/modules/channels/whatsapp/statuses";
import { saveIntegrationConnection, setIntegrationDnsLookup, validateSystemUrl } from "@/modules/integrations/connections";
import { deliverDueIntegrations, deliveryDedupeKey, emitIntegrationEvent, enqueueSystemCall, retryDelivery } from "@/modules/integrations/outbox";
import { enqueueDailyUsageReport, enqueueOverdueHandoffTask } from "@/modules/integrations/ops-signals";
import { setSystemFetch } from "@/modules/integrations/http";
import { findPii } from "@/modules/integrations/pii-guard";
import { CODE_VALIDATION_MAX_ATTEMPTS, retargetRequestSchema, sweepUnverifiedCodes } from "@/modules/integrations/clipper";
import { resolveOrderAttribution } from "@/modules/integrations/attribution";
import { getProductCompliance, refreshProductCompliance, setProductS1Ref } from "@/modules/integrations/compliance";
import { resetIntegrationScheduler, runIntegrationScheduler } from "@/modules/integrations/scheduler";
import { OmsClient, setOmsClientFactory } from "@/modules/oms/client";
import { handoffOrderToOms } from "@/modules/oms/handoff";
import { buildOmsClient } from "@/modules/oms/sync";
import { handleOmsAppWebhook, manualLinkMismatch, type OmsAppEnvelope } from "@/modules/oms/app-webhook";
import { formatOmsIntakeText, linkManualOmsOrder } from "@/modules/oms/manual";
import {
  OMS_HANDOFF_MAX_ATTEMPTS,
  autoHandoffState,
  handleAutoHandoffJob,
  maybeEnqueueAutoHandoff,
  sweepStuckOmsHandoffs,
} from "@/modules/oms/auto-handoff";
import { ownerQueue, statusSummary } from "@/modules/agent-door/status";
import { createAgentDraft, decideAgentDraft, expireStaleDrafts } from "@/modules/agent-door/drafts";
import { TOOL_BY_NAME } from "@/modules/agent-door/tools";
import { eventToWorkflowTrigger } from "@/modules/automation/workflow-engine";
import { validateEndpointUrl } from "@/modules/ai/endpoint-guard";
import { buildProductContext } from "@/modules/ai/context-builder";
import { createProduct } from "@/modules/products/service";

/**
 * P12 — الجولة التانية من المراجعة المستقلة (كل اختبار هون كان رح يفشل على
 * الكود قبل التصليح): مفاتيح الصادر لكل مساحة · الإعادة لرابط الاتصال
 * الحالي · فحص رابط الـ OMS عند كل ترحيل · رقم OMS غلط ما بيسوق طلبنا ·
 * الترحيل/التحقق ما بيستسلم بعد 90 ثانية · حصر الحملة بالمنتج · قواعد
 * سيستم 1 القديمة · نص الإدخال مقابل محلّل الـ OMS الحقيقي · إعادة حدث
 * بمعرّف تسليم جديد · حدث ربط مستقل · IPv6 مضمّن · حارس المراجع · سباق القرار.
 */

const WS = "ws-r2-0001";
const WS_B = "ws-r2-0002";
const ctx = { userId: "owner-1", workspaceId: WS };
const ctxB = { userId: "owner-b", workspaceId: WS_B };
type FakeDb = ReturnType<typeof createFakeDb>;
type Row = Record<string, any>;
const asDb = (d: FakeDb) => d as unknown as Db;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];
let dns: (host: string) => Promise<Array<{ address: string; family: number }>> = PUBLIC;
beforeAll(() => setIntegrationDnsLookup((h) => dns(h)));
afterAll(() => setIntegrationDnsLookup(null));
afterEach(() => {
  vi.useRealTimers();
  setSystemFetch(null);
  setOmsClientFactory(null);
  setWhatsAppClientFactory(null);
  dns = PUBLIC;
  resetIntegrationScheduler();
});

function fake(settings: Row = {}): FakeDb {
  const db = createFakeDb();
  db._stores.workspace.push(
    { id: WS, name: "Zaki SY", slug: "zaki", timezone: "Asia/Amman", integrationSettings: settings, slaHandoffResolutionMinutes: 30 },
    { id: WS_B, name: "Zaki JO", slug: "zaki-jo", timezone: "Asia/Amman", integrationSettings: settings, slaHandoffResolutionMinutes: 30 }
  );
  return db;
}

let seq = 0;
async function seedOrder(db: FakeDb, o: Row = {}): Promise<Row> {
  seq += 1;
  const workspaceId = o.workspaceId ?? WS;
  const customer = (await db.customer.create({
    data: { workspaceId, name: "محمد", phone: `09300001${String(seq).padStart(2, "0")}`, ...(o.customer ?? {}) },
  } as never)) as Row;
  const { customer: _c, ...rest } = o;
  void _c;
  const order = (await db.order.create({
    data: {
      workspaceId,
      orderNumber: `ORD-R2-${seq}`,
      customerId: customer.id,
      status: "CONFIRMED",
      confirmationStatus: "CONFIRMED_BY_CUSTOMER",
      deliveryAddress: "المزة",
      province: "دمشق",
      subtotal: 30,
      discount: 0,
      deliveryFee: 3,
      total: 33,
      currency: "USD",
      omsOrderId: null,
      omsOrderNumber: null,
      omsStatus: null,
      ...rest,
    },
  } as never)) as Row;
  // البنود كصف مصفوفة (الـ fake ما بيحاكي create متعدد).
  order.items = [{ productNameSnapshot: "منتج الطنين", skuSnapshot: "TIN01", unitPrice: 15, quantity: 2, subtotal: 30, productId: "p-tin" }];
  db._stores.order.find((r) => r.id === order.id)!.items = order.items;
  return order;
}
const orderRow = (db: FakeDb, id: string) => db._stores.order.find((o) => o.id === id)!;
const audits = (db: FakeDb, action: string) => db._stores.auditLog.filter((a) => a.action === action);
const env = (event: string, data: Row = {}, at = new Date().toISOString()): OmsAppEnvelope => ({ event, at, data: { ...data } }) as OmsAppEnvelope;
const conn = { id: "oms-conn-1", workspaceId: WS };

// ─────────────────────── HIGH 1 — إشارات التسليم وعدم التكرار ───────────────────────

describe("HIGH 1 — «واصل/مقروء» ما بيفتح إرسال تاني بنفس المفتاح", () => {
  it("حملة: المحاولة بعد إشارة delivered ثم read = SKIPPED_DUPLICATE والمزوّد اتنادى مرة وحدة", async () => {
    const db = createFakeDb();
    const ch = (await db.channel.create({ data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "X", externalId: "num-1" } } as never)) as Row;
    await db.channelAccount.create({ data: { channelId: ch.id, provider: "WHATSAPP", externalAccountId: "num-1", encryptedCredentials: encryptSecret("t") } } as never);
    const cu = (await db.customer.create({ data: { workspaceId: WS, phone: "p1" } } as never)) as Row;
    await db.channelIdentity.create({ data: { workspaceId: WS, customerId: cu.id, channelType: "WHATSAPP", channelExternalId: "9631" } } as never);
    const conv = (await db.conversation.create({
      data: { workspaceId: WS, customerId: cu.id, channelId: ch.id, channelConversationId: "9631", lastCustomerMessageAt: new Date() },
    } as never)) as Row;
    let calls = 0;
    setWhatsAppClientFactory(
      () =>
        new WhatsAppClient({
          fetchImpl: (async () => {
            calls += 1;
            return Response.json({ messages: [{ id: `wamid.out.${calls}` }] });
          }) as typeof fetch,
        })
    );
    const p = { workspaceId: WS, conversationId: conv.id, sourceMessageId: "campaign:c1:r1", text: "عرض" };
    const first = await dispatchOutbound(db as unknown as Prisma.TransactionClient, p);
    expect(first.deliveryStatus).toBe("SENT");
    await applyWhatsAppStatuses(asDb(db), WS, [{ wamid: "wamid.out.1", status: "DELIVERED", at: new Date(), errorCode: null }]);
    const afterDelivered = await dispatchOutbound(db as unknown as Prisma.TransactionClient, p);
    expect(afterDelivered).toMatchObject({ deliveryStatus: "SKIPPED_DUPLICATE", existingStatus: "DELIVERED" });
    await applyWhatsAppStatuses(asDb(db), WS, [{ wamid: "wamid.out.1", status: "READ", at: new Date(), errorCode: null }]);
    const afterRead = await dispatchOutbound(db as unknown as Prisma.TransactionClient, p);
    expect(afterRead).toMatchObject({ deliveryStatus: "SKIPPED_DUPLICATE", existingStatus: "READ" });
    expect(calls).toBe(1);
    // الإشارة «مقروء» ما انكتب فوقها.
    expect(db._stores.message.filter((m) => m.direction === "OUTBOUND")).toHaveLength(1);
    expect(db._stores.message.find((m) => m.direction === "OUTBOUND")!.deliveryStatus).toBe("READ");
  });
});

// ─────────────────────── HIGH 2 — مفاتيح الصادر لكل مساحة ───────────────────────

describe("HIGH 2 — مساحتين بنفس الأنظمة ما بيبلعوا صفوف بعض", () => {
  it("تقرير التكاليف · مهمة التحويلات · إنذار القدرة: صف لكل مساحة · ونفس المساحة مرة تانية = بلا تكرار", async () => {
    const db = fake({ serverCostUsdPerDay: "3.50" });
    for (const c of [ctx, ctxB]) {
      await saveIntegrationConnection(asDb(db), c, "finance", { baseUrl: "https://finance.zakai.io", token: "fin-token-1" });
      await saveIntegrationConnection(asDb(db), c, "tasks", { baseUrl: "https://tasks.zakai.io", token: "tasks-token-1" });
      await saveIntegrationConnection(asDb(db), c, "mediabuyer", { baseUrl: "https://mb.zakai.io", generateEventsSecret: true });
    }
    const now = new Date("2026-10-11T08:00:00Z"); // 11:00 عمّان
    expect(await enqueueDailyUsageReport(asDb(db), WS, now)).toBe(true);
    expect(await enqueueDailyUsageReport(asDb(db), WS_B, now)).toBe(true);
    await enqueueDailyUsageReport(asDb(db), WS, new Date(now.getTime() + HOUR));
    const usage = db._stores.integrationDelivery.filter((r) => r.type === "usage-costs");
    expect(usage.map((r) => r.workspaceId).sort()).toEqual([WS, WS_B].sort());
    // مفتاح عدم التكرار عند المالية فيه وسم المساحة — شركة مالية وحدة لمساحتين ما بتبلع تقرير.
    expect(new Set(usage.map((r) => r.idempotencyKey)).size).toBe(2);
    for (const r of usage) expect(r.idempotencyKey).toMatch(/^replies-usage-[a-p]{6}-2026-10-10$/);
    expect(usage.find((r) => r.workspaceId === WS)!.dedupeKey).toBe(deliveryDedupeKey(WS, "finance", "usage-costs", "2026-10-10"));

    for (const ws of [WS, WS_B]) {
      for (const minsAgo of [45, 90]) {
        db._stores.humanHandoff.push({ id: `h-${ws}-${minsAgo}`, workspaceId: ws, conversationId: "c", customerId: "cu", reason: "CUSTOMER_REQUEST", status: "OPEN", createdAt: new Date(now.getTime() - minsAgo * MIN) });
      }
      expect(await enqueueOverdueHandoffTask(asDb(db), ws, now)).toBe(true);
    }
    const tasks = db._stores.integrationDelivery.filter((r) => r.type === "tasks");
    expect(tasks.map((r) => r.workspaceId).sort()).toEqual([WS, WS_B].sort());
    const refs = tasks.map((r) => JSON.parse(r.body).external_ref as string);
    expect(new Set(refs).size).toBe(2);
    for (const ref of refs) expect(ref).toMatch(/^rep-handoff-[a-p]{6}-2026-10-11$/);

    const data = { level: "warning", unanswered: 31, first_response_p50_min: 4, by_channel: { whatsapp: 31 }, threshold_unanswered: 30, threshold_p50_min: 15 };
    expect(await emitIntegrationEvent(asDb(db), { workspaceId: WS, type: "capacity.alert", data, dedupeKey: "warning:2026-10-11T11:first" })).toBe(1);
    expect(await emitIntegrationEvent(asDb(db), { workspaceId: WS_B, type: "capacity.alert", data, dedupeKey: "warning:2026-10-11T11:first" })).toBe(1);
    expect(await emitIntegrationEvent(asDb(db), { workspaceId: WS, type: "capacity.alert", data, dedupeKey: "warning:2026-10-11T11:first" })).toBe(0);
  });
});

// ─────────────────────── M3 — الإعادة لرابط الاتصال الحالي ───────────────────────

describe("M3 — الصف المنتظر بيروح لرابط الاتصال الحالي (مش القديم بالتوكن الجديد)", () => {
  function recorder(statuses: number[]) {
    const seen: Array<{ url: string; auth: string | null; signature: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const h = (init.headers ?? {}) as Record<string, string>;
      seen.push({ url: String(url), auth: h.authorization ?? null, signature: h["x-zaki-signature"] ?? null });
      return new Response("", { status: statuses.shift() ?? 200 });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  it("نداء: المالية انتقلت لعنوان جديد وتوكن جديد ← الإعادة للعنوان الجديد بالتوكن الجديد، والسجل بيبيّن الجديد", async () => {
    const db = fake();
    await saveIntegrationConnection(asDb(db), ctx, "finance", { baseUrl: "https://old-finance.zakai.io", token: "OLD-TOKEN-1" });
    await enqueueSystemCall(asDb(db), {
      workspaceId: WS,
      system: "finance",
      type: "usage-costs",
      path: "/api/v1/usage-costs",
      body: { system: "replies", date: "2026-10-10", items: [] },
      idempotencyKey: "replies-usage-x-2026-10-10",
      dedupeKey: "2026-10-10",
    });
    const { seen, fetchImpl } = recorder([503, 200]);
    await deliverDueIntegrations(asDb(db), { fetchImpl });
    expect(seen[0]).toMatchObject({ url: "https://old-finance.zakai.io/api/v1/usage-costs", auth: "Bearer OLD-TOKEN-1" });
    await saveIntegrationConnection(asDb(db), ctx, "finance", { baseUrl: "https://new-finance.zakai.io", token: "NEW-TOKEN-2" });
    await deliverDueIntegrations(asDb(db), { fetchImpl, now: new Date(Date.now() + 2 * MIN) });
    expect(seen[1]).toEqual({ url: "https://new-finance.zakai.io/api/v1/usage-costs", auth: "Bearer NEW-TOKEN-2", signature: null });
    expect(seen.some((s) => s.url.includes("old-finance") && s.auth === "Bearer NEW-TOKEN-2")).toBe(false);
    expect(db._stores.integrationDelivery[0]).toMatchObject({ status: "OK", url: "https://new-finance.zakai.io/api/v1/usage-costs" });
  });

  it("حدث: «صلّح الإعداد وأعد المحاولة» بعد فشل نهائي = رابط الاستقبال الجديد بتوقيع السر الحالي", async () => {
    const db = fake();
    await saveIntegrationConnection(asDb(db), ctx, "clipper", { baseUrl: "https://clipper.zakai.io", eventsUrl: "https://old-hooks.zakai.io/in", token: "clp-token-1", generateEventsSecret: true });
    await emitIntegrationEvent(asDb(db), { workspaceId: WS, type: "conversation.coded", data: { code: "K7Q2", channel: "whatsapp", conversation_ref: "cv_abcdefghijkl" }, dedupeKey: "coded:t1" });
    const { seen, fetchImpl } = recorder([422, 200]);
    await deliverDueIntegrations(asDb(db), { fetchImpl });
    expect(db._stores.integrationDelivery[0]).toMatchObject({ status: "FAILED", responseCode: 422 });
    await saveIntegrationConnection(asDb(db), ctx, "clipper", { eventsUrl: "https://new-hooks.zakai.io/in" });
    await retryDelivery(asDb(db), ctx, db._stores.integrationDelivery[0].id);
    await deliverDueIntegrations(asDb(db), { fetchImpl });
    expect(seen.map((s) => s.url)).toEqual(["https://old-hooks.zakai.io/in", "https://new-hooks.zakai.io/in"]);
    expect(seen[1].signature).toMatch(/^[0-9a-f]{64}$/);
    expect(db._stores.integrationDelivery[0]).toMatchObject({ status: "OK", url: "https://new-hooks.zakai.io/in" });
  });

  it("اتصال صار بلا رابط = CANCELLED (CONNECTION_URL_MISSING) بلا أي نداء ولا توكن", async () => {
    const db = fake();
    await saveIntegrationConnection(asDb(db), ctx, "crisis", { baseUrl: "https://crisis.zakai.io", token: "crisis-token-1" });
    await enqueueSystemCall(asDb(db), { workspaceId: WS, system: "crisis", type: "alerts", path: "/api/v1/alerts", body: { external_ref: "rep-x", type: "t", severity: "high", message: "م" }, idempotencyKey: "k", dedupeKey: "d" });
    await saveIntegrationConnection(asDb(db), ctx, "crisis", { baseUrl: null });
    const { seen, fetchImpl } = recorder([200]);
    const res = await deliverDueIntegrations(asDb(db), { fetchImpl });
    expect(res.cancelled).toBe(1);
    expect(seen).toHaveLength(0);
    expect(db._stores.integrationDelivery[0]).toMatchObject({ status: "CANCELLED", error: "CONNECTION_URL_MISSING" });
  });
});

// ─────────────────────── M4 — فحص رابط الـ OMS عند كل ترحيل ───────────────────────

describe("M4 — رابط الـ OMS بينفحص (مع DNS) عند كل ترحيل ومزامنة", () => {
  function installOms() {
    const calls: string[] = [];
    setOmsClientFactory(
      (deps) =>
        new OmsClient({
          ...deps,
          fetchImpl: (async (url: string) => {
            calls.push(String(url));
            return Response.json({ order_id: "oms-1", order_number: "SY-2026-0001", status: "NEW" }, { status: 201 });
          }) as unknown as typeof fetch,
        })
    );
    return calls;
  }

  it("اتصال قديم (قبل P12) برابط داخلي http = OMS_URL_REJECTED قبل أي نداء — ولا توكن ولا بيانات زبون", async () => {
    const db = fake();
    db._stores.omsConnection.push({ id: "oc-1", workspaceId: WS, baseUrl: "http://10.0.0.5:3000", tokenEncrypted: encryptSecret("legacy-token"), isActive: true, mode: "api", apiVersion: "v1" });
    const calls = installOms();
    const o = await seedOrder(db);
    await expect(handoffOrderToOms(asDb(db), ctx, o.id)).rejects.toMatchObject({ code: "OMS_URL_REJECTED" });
    await expect(buildOmsClient(asDb(db), WS)).rejects.toMatchObject({ code: "OMS_URL_REJECTED" });
    expect(calls).toHaveLength(0);
    expect(orderRow(db, o.id).omsOrderId).toBeNull();
    expect(db._stores.omsConnection[0].lastError).toContain("OMS_URL_REJECTED");
  });

  it("اسم صار يشير لعنوان محجوب (rebinding) = مرفوض · فشل حل مؤقت = OMS_UNREACHABLE (المهمة بتعيد)", async () => {
    const db = fake();
    db._stores.omsConnection.push({ id: "oc-2", workspaceId: WS, baseUrl: "https://oms.rebind.example", tokenEncrypted: encryptSecret("tok"), isActive: true, mode: "api", apiVersion: "v1" });
    const calls = installOms();
    const o = await seedOrder(db);
    dns = async () => [{ address: "169.254.169.254", family: 4 }];
    await expect(handoffOrderToOms(asDb(db), ctx, o.id)).rejects.toMatchObject({ code: "OMS_URL_REJECTED" });
    dns = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(handoffOrderToOms(asDb(db), ctx, o.id)).rejects.toMatchObject({ code: "OMS_UNREACHABLE" });
    await expect(buildOmsClient(asDb(db), WS)).rejects.toMatchObject({ code: "OMS_UNREACHABLE" });
    const job = await handleAutoHandoffJob(asDb(db), { orderId: o.id }, WS);
    expect(job).toEqual({ success: false, error: "OMS_UNREACHABLE" });
    expect(calls).toHaveLength(0);
    dns = PUBLIC;
    await expect(handoffOrderToOms(asDb(db), ctx, o.id)).resolves.toMatchObject({ omsOrderId: "oms-1", handedOff: true });
    expect(calls).toHaveLength(1);
  });

  it("رابط داخلي مسموح بس تحت INTEGRATIONS_ALLOW_PRIVATE_NETWORK الصريح", async () => {
    const db = fake();
    db._stores.omsConnection.push({ id: "oc-3", workspaceId: WS, baseUrl: "http://oms:3000", tokenEncrypted: encryptSecret("tok"), isActive: true, mode: "api", apiVersion: "v1" });
    installOms();
    const o = await seedOrder(db);
    await expect(handoffOrderToOms(asDb(db), ctx, o.id)).rejects.toMatchObject({ code: "OMS_URL_REJECTED" });
    process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORK = "1";
    try {
      await expect(handoffOrderToOms(asDb(db), ctx, o.id)).resolves.toMatchObject({ handedOff: true });
    } finally {
      delete process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORK;
    }
  });
});

// ─────────────────────── M5 — رقم OMS غلط ما بيسوق طلبنا ───────────────────────

describe("M5 — ربط يدوي برقم غلط: الحدث لازم يطابق قبل ما يكمّل الربط", () => {
  const ORDER_AT = new Date(Date.now() - 2 * HOUR);

  it("مجموع بعيد / عملة تانية / حدث أقدم من طلبنا = LINK_MISMATCH: لا معرّف ولا حالة — وسجل مرة وحدة للرقم", async () => {
    const db = fake();
    const o = await seedOrder(db, { createdAt: ORDER_AT });
    await linkManualOmsOrder(asDb(db), ctx, o.id, "SY-2026-0184");
    const shipped = await handleOmsAppWebhook(asDb(db), {
      connection: conn,
      envelope: env("order.shipped", { orderId: "cm_other", orderNumber: "SY-2026-0184", total: 120, currency: "USD", shippingStatus: "SHIPPED" }),
      deliveryId: "d1",
    });
    expect(shipped).toEqual({ outcome: "ignored", reason: "LINK_MISMATCH" });
    expect(orderRow(db, o.id)).toMatchObject({ omsOrderId: null, status: "CONFIRMED", omsStatus: "NEW" });
    const again = await handleOmsAppWebhook(asDb(db), {
      connection: conn,
      envelope: env("order.delivered", { orderId: "cm_other", orderNumber: "SY-2026-0184", total: 120, currency: "USD" }),
      deliveryId: "d2",
    });
    expect(again).toEqual({ outcome: "ignored", reason: "LINK_MISMATCH" });
    expect(orderRow(db, o.id).status).toBe("CONFIRMED");
    const mm = audits(db, "oms.manual_link_mismatch");
    expect(mm).toHaveLength(1);
    expect(mm[0]).toMatchObject({ entityId: o.id, metadata: { omsOrderNumber: "SY-2026-0184", reason: "TOTAL", omsTotal: 120, omsCurrency: "USD" } });

    const e = (data: Row, at?: string) => env("order.confirmed", { orderNumber: "SY-2026-0184", orderId: "cm_x", ...data }, at);
    const order = orderRow(db, o.id);
    expect(manualLinkMismatch(order as never, e({ total: 33, currency: "SYP" }))).toBe("CURRENCY");
    expect(manualLinkMismatch(order as never, e({ total: 33, currency: "usd" }, new Date(ORDER_AT.getTime() - HOUR).toISOString()))).toBe("BEFORE_ORDER");
    expect(manualLinkMismatch(order as never, e({ total: 36, currency: "USD" }))).toBeNull(); // توصيل مختلف شوي = مقبول
    expect(manualLinkMismatch(order as never, e({}))).toBeNull(); // حدث بلا مجموع/عملة = ما في دليل ضد
  });

  it("رقم صحيح بمجموع قريب = الربط بيكمل والحالة بتمشي · الرقم بيتوحّد (حروف صغيرة/مسافات) بالطرفين", async () => {
    const db = fake();
    const o = await seedOrder(db, { createdAt: ORDER_AT });
    await linkManualOmsOrder(asDb(db), ctx, o.id, " sy-2026-0148 ");
    expect(orderRow(db, o.id).omsOrderNumber).toBe("SY-2026-0148");
    const res = await handleOmsAppWebhook(asDb(db), {
      connection: conn,
      envelope: env("order.confirmed", { orderId: "cm_right", orderNumber: "sy-2026-0148", total: 34, currency: "USD", confirmationStatus: "CONFIRMED" }),
      deliveryId: "ok1",
    });
    expect(res.outcome).toBe("applied");
    expect(orderRow(db, o.id)).toMatchObject({ omsOrderId: "cm_right", omsStatus: "CONFIRMED" });
    expect(audits(db, "oms.manual_link_mismatch")).toHaveLength(0);
  });

  it("الطابور: ربط ما طابق بيطلع للمالك «راجع الرقم» — وبعد الفك والتصحيح بيختفي", async () => {
    const db = fake();
    db._stores.omsConnection.push({ id: "oc-m", workspaceId: WS, baseUrl: "https://oms.zakai.io", tokenEncrypted: encryptSecret("t"), isActive: true, mode: "manual" });
    const o = await seedOrder(db, { createdAt: ORDER_AT });
    await linkManualOmsOrder(asDb(db), ctx, o.id, "SY-2026-0184");
    await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.shipped", { orderId: "cm_o", orderNumber: "SY-2026-0184", total: 999, currency: "USD" }), deliveryId: "q1" });
    const q = await ownerQueue(asDb(db), WS, new Date());
    expect(q.items.map((i) => i.type)).toContain("oms.link_mismatch");
    expect(q.items.find((i) => i.type === "oms.link_mismatch")!.url).toContain(`/orders/${o.id}`);
    await linkManualOmsOrder(asDb(db), ctx, o.id, "SY-2026-0148");
    const q2 = await ownerQueue(asDb(db), WS, new Date());
    expect(q2.items.map((i) => i.type)).not.toContain("oms.link_mismatch");
  });
});

// ─────────────────────── M6 — الترحيل/التحقق ما بيستسلم بعد 90 ثانية ───────────────────────

describe("M6 — ميزانية إعادة أطول + كنس ساعي + ظهور بالأحمر", () => {
  async function apiConn(db: FakeDb, o: Row = {}) {
    db._stores.omsConnection.push({ id: `oc-${Math.random()}`, workspaceId: WS, baseUrl: "https://oms.zakai.io", tokenEncrypted: encryptSecret("t"), isActive: true, mode: "api", apiVersion: "v1", autoHandoff: true, ...o });
  }
  const failedJob = (db: FakeDb, orderId: string, finishedAgoH: number, o: Row = {}) =>
    db._stores.backgroundJob.push({
      id: `j-${Math.random()}`,
      type: "handoff_order_to_oms",
      workspaceId: WS,
      payload: { orderId },
      status: "FAILED",
      attempts: OMS_HANDOFF_MAX_ATTEMPTS,
      maxAttempts: OMS_HANDOFF_MAX_ATTEMPTS,
      lastError: "OMS_UNREACHABLE",
      idempotencyKey: `oms-handoff:${orderId}`,
      finishedAt: new Date(Date.now() - finishedAgoH * HOUR),
      createdAt: new Date(Date.now() - finishedAgoH * HOUR - HOUR),
      ...o,
    });

  it("مهمة الترحيل التلقائي بـ 8 محاولات (≈ 35 دقيقة) بدل 3", async () => {
    const db = fake();
    await apiConn(db);
    const o = await seedOrder(db);
    expect(await maybeEnqueueAutoHandoff(asDb(db), WS, o.id)).toBe(true);
    expect(db._stores.backgroundJob[0]).toMatchObject({ type: "handoff_order_to_oms", maxAttempts: OMS_HANDOFF_MAX_ATTEMPTS, idempotencyKey: `oms-handoff:${o.id}` });
    expect(OMS_HANDOFF_MAX_ATTEMPTS).toBe(8);
  });

  it("الكنس: مهمة فشلت لطلب لسا مش مرحّل = مهمة جديدة · مرحّل/ملغى/أقدم من 3 أيام/عنده مهمة نشطة = لا", async () => {
    const db = fake();
    await apiConn(db);
    const stuck = await seedOrder(db);
    const done = await seedOrder(db, { omsOrderId: "oms-done" });
    const cancelled = await seedOrder(db, { status: "CANCELLED" });
    const old = await seedOrder(db);
    const active = await seedOrder(db);
    failedJob(db, stuck.id, 2);
    failedJob(db, done.id, 2);
    failedJob(db, cancelled.id, 2);
    failedJob(db, old.id, 80);
    failedJob(db, active.id, 2);
    db._stores.backgroundJob.push({ id: "j-active", type: "handoff_order_to_oms", workspaceId: WS, payload: { orderId: active.id }, status: "PENDING", attempts: 1, maxAttempts: 8, idempotencyKey: `oms-handoff:${active.id}`, createdAt: new Date() });
    expect(await sweepStuckOmsHandoffs(asDb(db))).toBe(1);
    const fresh = db._stores.backgroundJob.filter((j) => j.status === "PENDING" && j.payload.orderId === stuck.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ maxAttempts: OMS_HANDOFF_MAX_ATTEMPTS, idempotencyKey: `oms-handoff:${stuck.id}` });
    // دورة تانية: المهمة نشطة = ما في تكرار.
    expect(await sweepStuckOmsHandoffs(asDb(db))).toBe(0);
    // اتصال يدوي أو بلا تلقائي = ما في كنس.
    const db2 = fake();
    await apiConn(db2, { autoHandoff: false });
    const s2 = await seedOrder(db2);
    failedJob(db2, s2.id, 1);
    expect(await sweepStuckOmsHandoffs(asDb(db2))).toBe(0);
  });

  it("المجدول بيكنس كل ساعة حتى بلا أي اتصال عام (الـ OMS بجدوله)", async () => {
    const db = fake();
    await apiConn(db);
    const stuck = await seedOrder(db);
    failedJob(db, stuck.id, 1);
    await runIntegrationScheduler(asDb(db), new Date());
    expect(db._stores.backgroundJob.filter((j) => j.status === "PENDING" && j.payload.orderId === stuck.id)).toHaveLength(1);
  });

  it("حالة الترحيل التلقائي للصفحة: بانتظار · بيعيد · فشل · انرفض (برمز السبب)", async () => {
    const db = fake();
    await apiConn(db);
    const o = await seedOrder(db);
    expect(await autoHandoffState(asDb(db), WS, o.id, false)).toBeNull();
    await maybeEnqueueAutoHandoff(asDb(db), WS, o.id);
    expect(await autoHandoffState(asDb(db), WS, o.id, false)).toMatchObject({ state: "queued", attempts: 0 });
    const job = db._stores.backgroundJob[0];
    Object.assign(job, { attempts: 2, lastError: "OMS_TIMEOUT", runAfter: new Date(Date.now() + MIN) });
    expect(await autoHandoffState(asDb(db), WS, o.id, false)).toMatchObject({ state: "retrying", attempts: 2, lastError: "OMS_TIMEOUT" });
    Object.assign(job, { status: "FAILED", attempts: 8 });
    expect(await autoHandoffState(asDb(db), WS, o.id, false)).toMatchObject({ state: "failed", attempts: 8 });
    // رفض نهائي: زبون بالقائمة السوداء — المهمة بتخلص «نجاح» بس الصفحة بتقول ليش.
    const black = await seedOrder(db, { customer: { isBlacklisted: true } });
    await maybeEnqueueAutoHandoff(asDb(db), WS, black.id);
    expect(await handleAutoHandoffJob(asDb(db), { orderId: black.id }, WS)).toEqual({ success: true });
    db._stores.backgroundJob.find((j) => j.payload.orderId === black.id)!.status = "DONE";
    expect(audits(db, "oms.auto_handoff_refused")[0]).toMatchObject({ entityId: black.id, metadata: { code: "ORDER_CUSTOMER_BLACKLISTED" } });
    expect(await autoHandoffState(asDb(db), WS, black.id, false)).toMatchObject({ state: "refused", lastError: "ORDER_CUSTOMER_BLACKLISTED" });
    expect(await autoHandoffState(asDb(db), WS, black.id, true)).toMatchObject({ state: "done" });
  });

  it("الطابور والموجز: طلب مؤكد ما انرحّل من > 15 دقيقة بوضع API = بند «ما انرحّل» + تحذير", async () => {
    const db = fake();
    await apiConn(db);
    const stuck = await seedOrder(db, { updatedAt: new Date(Date.now() - 20 * MIN), createdAt: new Date(Date.now() - 25 * MIN) });
    await seedOrder(db, { updatedAt: new Date(Date.now() - 2 * MIN) }); // لسا بالدقايق الأولى
    await seedOrder(db, { omsOrderId: "oms-ok", updatedAt: new Date(Date.now() - HOUR) });
    const q = await ownerQueue(asDb(db), WS, new Date());
    const pending = q.items.filter((i) => i.type === "oms.handoff_pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toContain(`/orders/${stuck.id}`);
    const summary = await statusSummary(asDb(db), WS, "Asia/Amman", new Date());
    expect(summary.warnings_ar.join(" ")).toContain("1 طلب مؤكد ما انرحّل للـ OMS");
  });

  it("تحقق الرموز: 8 محاولات · الكنس بيعيد الرمز «غير المتحقق» الحديث بس", async () => {
    const db = fake();
    await saveIntegrationConnection(asDb(db), ctx, "clipper", { baseUrl: "https://clipper.zakai.io", token: "clp-token-1", generateEventsSecret: true });
    const touch = (id: string, o: Row) =>
      db._stores.attributionTouch.push({ id, workspaceId: WS, customerId: "cu", conversationId: "cv", channel: "whatsapp", kind: "CODE", source: "text", refCode: "K7Q2", codeStatus: null, episodeStart: true, dedupeKey: id, occurredAt: new Date(Date.now() - DAY), ...o });
    touch("t-unv", {});
    touch("t-unv2", { codeStatus: "UNVERIFIED" });
    touch("t-valid", { codeStatus: "VALID" });
    touch("t-old", { occurredAt: new Date(Date.now() - 9 * DAY) });
    for (const id of ["t-unv", "t-unv2", "t-valid", "t-old"]) {
      db._stores.backgroundJob.push({ id: `vj-${id}`, type: "validate_attribution_code", workspaceId: WS, payload: { touchId: id }, status: "FAILED", attempts: 3, maxAttempts: 3, idempotencyKey: `code-validate:${id}`, finishedAt: new Date(Date.now() - HOUR) });
    }
    expect(await sweepUnverifiedCodes(asDb(db), WS)).toBe(2);
    const fresh = db._stores.backgroundJob.filter((j) => j.status === "PENDING");
    expect(fresh.map((j) => j.payload.touchId).sort()).toEqual(["t-unv", "t-unv2"]);
    for (const j of fresh) expect(j.maxAttempts).toBe(CODE_VALIDATION_MAX_ATTEMPTS);
    expect(await sweepUnverifiedCodes(asDb(db), WS)).toBe(0);
  });
});

// ─────────────────────── M7 — حصر حملة Hermes بالمنتج ───────────────────────

describe("M7 — product_code بيحصر جمهور الحملة فعليًا (وقت المسودة ووقت الاعتماد)", () => {
  it("مسودة بمنتج: بس الي طلباتهم فيها المنتج · الاعتماد بيبني نفس الحصر", async () => {
    const db = fake();
    const can = ((p: string) => p === "campaigns.write") as never;
    await db.channel.create({ data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "wa", externalId: "pn-1" } } as never);
    const tin = (await db.product.create({ data: { workspaceId: WS, name: "منتج الطنين", sku: "TIN01", isActive: true } } as never)) as Row;
    const other = (await db.product.create({ data: { workspaceId: WS, name: "صابون", sku: "SOAP1", isActive: true } } as never)) as Row;
    const mk = async (productId: string) => {
      const cu = (await db.customer.create({ data: { workspaceId: WS, name: "ز", marketingConsent: "OPTED_IN" } } as never)) as Row;
      await db.channelIdentity.create({ data: { workspaceId: WS, customerId: cu.id, channelType: "WHATSAPP", channelExternalId: `wa-${cu.id}` } } as never);
      db._stores.order.push({ id: `o-${cu.id}`, workspaceId: WS, customerId: cu.id, orderNumber: `N-${cu.id}`, status: "DELIVERED", createdAt: new Date(Date.now() - 40 * DAY), updatedAt: new Date(Date.now() - 35 * DAY), items: [{ productId }] });
      return cu.id as string;
    };
    await mk(tin.id);
    await mk(other.id);
    const tool = TOOL_BY_NAME.get("draft_retarget_campaign")!;
    const run = (input: Row, dryRun: boolean, key: string | null = null) =>
      tool.run(
        {
          db: asDb(db),
          workspaceId: WS,
          token: { id: "tok-1" } as never,
          tz: "Asia/Amman",
          now: new Date(),
          dryRun,
          idempotencyKey: key,
          agentRef: "hermes:zaki",
          requestId: "r",
        } as never,
        tool.input.parse(input) as never
      );
    const base = { segment: { kind: "repeat_product" }, template_ref: "wa_tpl_offer_ar" };
    expect(((await run(base, true)) as Row).data.eligible_count).toBe(2);
    const scoped = (await run({ ...base, product_code: "TIN01" }, true)) as Row;
    expect(scoped.data.eligible_count).toBe(1);
    expect(scoped.data.checks.find((c: Row) => c.code === "PRODUCT_SCOPE")).toMatchObject({ ok: true });
    await expect(run({ ...base, product_code: "NOPE1" }, true)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const created = (await run({ ...base, product_code: "TIN01" }, false, "hermes-zaki-00000000000000aa-20261011")) as Row;
    expect(created.status).toBe("draft_created");
    const draft = db._stores.agentDraft[0];
    expect(draft.payload.spec.product).toEqual({ productId: tin.id, productCode: "TIN01" });
    await decideAgentDraft(asDb(db), { userId: "owner-1", workspaceId: WS, can }, draft.id, { decision: "approve" });
    const seg = db._stores.audienceSegment[0];
    expect(seg.definition.conditions).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "orders.statusBetweenDays", productId: tin.id })])
    );
  });
});

// ─────────────────────── M8 — قواعد سيستم 1 القديمة ───────────────────────

describe("M8 — تغيير مرجع سيستم 1 بيشيل قواعد المرجع القديم", () => {
  const S1 = (ref: string) => ({ product_ref: ref, verdict: "restricted", allowed_claims: [`مسموح ${ref}`], banned_claims: [`ممنوع ${ref}`], ad_rules: [] });

  async function world() {
    const db = fake();
    await saveIntegrationConnection(asDb(db), ctx, "s1", { baseUrl: "https://s1.zakai.io", token: "s1-token-1", generateEventsSecret: true });
    const p = (await createProduct(asDb(db), ctx, { name: "كريم", sku: "CR-1", price: 10, currency: "USD" } as never)) as Row;
    return { db, p };
  }

  it("pf_A ← pf_B وقراءة سيستم 1 فشلت: قواعد pf_A انشالت · الخطأ راجع للشاشة · الذكاء ما بياخد قواعد قديمة", async () => {
    const { db, p } = await world();
    setSystemFetch((async () => Response.json(S1("pf_A"))) as unknown as typeof fetch);
    expect(await setProductS1Ref(asDb(db), ctx, p.id, "pf_A")).toMatchObject({ refreshError: null, compliance: { productRef: "pf_A" } });
    setSystemFetch((async () => new Response("", { status: 503 })) as unknown as typeof fetch);
    const res = await setProductS1Ref(asDb(db), ctx, p.id, "pf_B");
    expect(res.refreshError).toBe("HTTP 503");
    expect(res.compliance).toBeNull();
    expect(db._stores.productCompliance).toHaveLength(0);
    const built = await buildProductContext(asDb(db), WS, p.id);
    expect(built.product).not.toHaveProperty("compliance");
    // مربوط بلا قواعد = مهمة قراءة بالخلفية.
    expect(db._stores.backgroundJob.filter((j) => j.type === "refresh_product_compliance")).toHaveLength(1);
  });

  it("نسخة لمرجع تاني (سباق) ما بتنطبق · مسح المرجع بيشيل القواعد", async () => {
    const { db, p } = await world();
    setSystemFetch((async () => Response.json(S1("pf_A"))) as unknown as typeof fetch);
    await setProductS1Ref(asDb(db), ctx, p.id, "pf_A");
    // سباق: نسخة pf_A باقية والمنتج صار pf_B.
    db._stores.product.find((x) => x.id === p.id)!.s1ProductRef = "pf_B";
    expect(await getProductCompliance(asDb(db), p.id, "pf_B")).toBeNull();
    expect((await buildProductContext(asDb(db), WS, p.id)).product).not.toHaveProperty("compliance");
    db._stores.product.find((x) => x.id === p.id)!.s1ProductRef = "pf_A";
    expect((await buildProductContext(asDb(db), WS, p.id)).product!.compliance).toMatchObject({ bannedClaims: ["ممنوع pf_A"] });
    expect(await setProductS1Ref(asDb(db), ctx, p.id, null)).toEqual({ compliance: null, refreshError: null });
    expect(db._stores.productCompliance).toHaveLength(0);
  });

  it("المرجع تغيّر وإحنا عم نقرأ = REF_CHANGED بلا كتابة قواعد المرجع القديم", async () => {
    const { db, p } = await world();
    db._stores.product.find((x) => x.id === p.id)!.s1ProductRef = "pf_A";
    setSystemFetch((async () => {
      db._stores.product.find((x) => x.id === p.id)!.s1ProductRef = "pf_B"; // حفظ مرجع جديد بنفس اللحظة
      return Response.json(S1("pf_A"));
    }) as unknown as typeof fetch);
    expect(await refreshProductCompliance(asDb(db), WS, p.id)).toEqual({ ok: false, error: "REF_CHANGED" });
    expect(db._stores.productCompliance).toHaveLength(0);
  });
});

// ─────────────────────── L9 — نص الإدخال مقابل محلّل الـ OMS ───────────────────────

describe("L9 — نص «إدخال الطلب بالذكاء» بينقرأ صح بمحلّل الـ OMS الحرفي", () => {
  const base = {
    customerName: "أبو-علي",
    phone: "0936 654 998",
    province: "حمص",
    address: "حمص؛ الإنشاءات؛ جانب الصيدلية - الطابق 2",
    items: [{ productNameSnapshot: "ماء الكمأة", skuSnapshot: "TW-500", unitPrice: 15, quantity: 2, subtotal: 30 }],
    discount: 0,
    deliveryFee: 3,
    total: 33,
    currency: "USD",
    notes: "الزبون قال: العدد: 3 علب للعيلة؛ المصدر: فيسبوك - الكمية - 5",
    orderNumber: "ORD-MG8K2J-X7Q",
    source: "واتساب · رمز K7Q2",
  };

  it("ملاحظات فيها «العدد: 3» و«المصدر:» وعنوان فيه «؛» = نفس الحقول المقصودة بالضبط", () => {
    const { text } = formatOmsIntakeText(base);
    const parsed = parseOrderText(text);
    expect(parsed.quantity).toBe(2);
    expect(parsed.price).toBe(30);
    expect(parsed.source).toBe("واتساب · رمز K7Q2");
    expect(parsed.address).toBe("حمص، الإنشاءات، جانب الصيدلية – الطابق 2");
    expect(parsed.customerName).toBe("أبو–علي");
    expect(parsed.phone).toBe("0936654998");
    expect(parsed.governorate).toBe("حمص");
    expect(parsed.productQuery).toBe("ماء الكمأة");
    expect(parsed.notes).toContain("العدد 3 علب للعيلة");
    expect(parsed.notes).toContain("مرجع الردود ORD-MG8K2J-X7Q");
    expect(parsed.source.length).toBeLessThanOrEqual(40);
  });

  it("حقل فاضي «-» ما بيتعبّى من الملاحظات · منتجات إضافية ما بتغيّر المنتج الرئيسي", () => {
    const { text } = formatOmsIntakeText({
      ...base,
      address: "",
      notes: "العنوان - شارع بغداد · الطلب: زيت",
      items: [...base.items, { productNameSnapshot: "زيت: إكليل", skuSnapshot: "O-1", unitPrice: 5, quantity: 1, subtotal: 5 }],
    });
    const parsed = parseOrderText(text);
    expect(parsed.address).toBe("");
    expect(parsed.productQuery).toBe("ماء الكمأة");
    expect(parsed.quantity).toBe(2);
    expect(parsed.notes).toContain("زيت إكليل × 1");
  });
});

// ─────────────────────── L10 · L11 — أحداث الـ OMS ───────────────────────

describe("L10/L11 — إعادة حدث بمعرّف تسليم جديد · حدث ربط مستقل", () => {
  it("نفس الجسم الموقّع بـ X-Zaki-Delivery جديد = تكرار (المفتاح من الحدث · الطلب · وقته)", async () => {
    const db = fake();
    const o = await seedOrder(db, { omsOrderId: "cm_replay" });
    const envelope = env("order.delivered", { orderId: "cm_replay" }, "2026-10-11T09:00:00.000Z");
    const a = await handleOmsAppWebhook(asDb(db), { connection: conn, envelope, deliveryId: "dlv-original" });
    const b = await handleOmsAppWebhook(asDb(db), { connection: conn, envelope, deliveryId: "dlv-attacker-new" });
    expect(a).toMatchObject({ outcome: "applied", duplicate: false, appliedLocalStatus: "DELIVERED" });
    expect(b).toMatchObject({ outcome: "applied", duplicate: true, appliedLocalStatus: null });
    expect(audits(db, "oms.status_changed")).toHaveLength(1);
    expect(orderRow(db, o.id).status).toBe("DELIVERED");
  });

  it("الربط اليدوي بينشر OrderOmsLinked (مش OrderStateChanged) — وما بيشغّل محفّز «تحديث حالة من الـ OMS»", async () => {
    const db = fake();
    const o = await seedOrder(db);
    const seen: DomainEvent[] = [];
    const off = eventBus.subscribe("*", async (e) => {
      seen.push(e);
    });
    try {
      await linkManualOmsOrder(asDb(db), ctx, o.id, "SY-2026-0148");
    } finally {
      off();
    }
    expect(seen.map((e) => e.name)).toEqual(["OrderOmsLinked"]);
    expect(seen[0].payload).toEqual({ orderId: o.id, mode: "manual", omsOrderNumber: "SY-2026-0148" });
    expect(eventToWorkflowTrigger("OrderOmsLinked", seen[0].payload as Row)).toBeNull();
    expect(eventToWorkflowTrigger("OrderStateChanged", { orderId: o.id })).toBe("ORDER_STATUS_CHANGED_FROM_OMS");
  });
});

// ─────────────────────── L13 · L14 — الحرّاس ───────────────────────

describe("L13 — IPv4 مضمّن بـ IPv6 ما بيتجاوز حارس الشبكة الخاصة", () => {
  it.each([
    "https://[::ffff:127.0.0.1]:8443",
    "https://[::ffff:169.254.169.254]",
    "https://[::ffff:10.0.0.5]",
    "https://[::ffff:7f00:1]",
    "https://[::ffff:0:127.0.0.1]",
    "https://[::127.0.0.1]",
    "https://[2002:a9fe:a9fe::]",
  ])("%s مرفوض (روابط الأنظمة ونقاط الموديلات)", (url) => {
    expect(validateSystemUrl(url).ok).toBe(false);
    expect(validateEndpointUrl(url).ok).toBe(false);
  });

  it("عناوين IPv6 عامة (ومنها ::ffff:عام) مقبولة", () => {
    for (const url of ["https://[2606:4700:4700::1111]", "https://[::ffff:8.8.8.8]"]) {
      expect(validateSystemUrl(url).ok).toBe(true);
      expect(validateEndpointUrl(url).ok).toBe(true);
    }
  });
});

describe("L14 — حارس البيانات: المراجع بصيغها المعروفة · الروابط بمعرّفاتها", () => {
  it("رقم هاتف ورا حرف تحت مفتاح _ref/_id = ممسوك · المعرّفات الحقيقية مستثناة", () => {
    expect(findPii({ source_ref: "p0791234567" })).toEqual([{ path: "$.source_ref", kind: "PHONE" }]);
    expect(findPii({ external_ref: "rt_963936654998" })).toHaveLength(1);
    expect(findPii({ draft_id: "c9381234567890123456789ab" })).toEqual([]); // cuid فيه أرقام متتالية
    expect(findPii({ campaign_id: "rep_rt_c9381234567890123456789ab" })).toEqual([]);
    expect(findPii({ external_ref: "hrm_1234567890abcdef1234" })).toEqual([]);
    expect(findPii({ external_ref: "rt_19", payee_ref: "clp_118", ref: "rep-ch-abcdefgh-2026-10-11" })).toEqual([]);
  });

  it("روابط المراجعة بمعرّفات cuid ما بتوقف الأداة · رابط فيه رقم هاتف ممسوك", () => {
    expect(findPii({ review_url: "https://replies.zaki.io/settings/agents?draft=c9381234567890123456789ab" })).toEqual([]);
    expect(findPii({ links: [{ title_ar: "راجع", url: "/orders/c9381234567890123456789ab" }] })).toEqual([]);
    expect(findPii({ url: "https://wa.me/963936654998" })).toEqual([{ path: "$.url", kind: "PHONE" }]);
  });

  it("طلب الكليبر بمرجع بيشبه رقم هاتف = مرفوض من البداية (بدل نتيجة ما بتطلع أبدًا)", () => {
    const req = (external_ref: string) => ({
      external_ref,
      channel: "whatsapp",
      segment: { kind: "messaged_no_order" },
      template_ref: "wa_tpl_x",
      opt_in_required: true,
      approved_by: "owner",
      approved_at: "2026-10-11T10:00:00+03:00",
    });
    expect(retargetRequestSchema.safeParse(req("rt_19")).success).toBe(true);
    expect(retargetRequestSchema.safeParse(req("rt_0936654998")).success).toBe(false);
  });
});

// ─────────────────────── L15 — سباق القرار على المسودة ───────────────────────

describe("L15 — قرار المسودة بحجز ذري", () => {
  const payload = { topic: "التوصيل", question: "قديش التوصيل؟", answer: "من يوم ليومين.", dialect: null, productId: null, productCode: null };
  const can = ((p: string) => p === "knowledge.write") as never;

  it("موافقين بنفس اللحظة = سؤال شائع واحد والتاني 409", async () => {
    const db = fake();
    const { row } = await createAgentDraft(asDb(db), { workspaceId: WS, tokenId: "tok", source: "hermes", kind: "reply_template", title: "قالب", payload, idempotencyKey: "k-race" });
    const results = await Promise.allSettled([
      decideAgentDraft(asDb(db), { userId: "owner-1", workspaceId: WS, can }, row.id, { decision: "approve" }),
      decideAgentDraft(asDb(db), { userId: "owner-2", workspaceId: WS, can }, row.id, { decision: "approve" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "DRAFT_ALREADY_DECIDED" });
    expect(db._stores.faq).toHaveLength(1);
    expect(db._stores.agentDraft[0].status).toBe("APPROVED");
  });

  it("فشل التنفيذ (تعديل فيه رقم هاتف) = المسودة بترجع «بانتظار» · وحجز علق 10 دقايق بيرجع لحاله", async () => {
    const db = fake();
    const { row } = await createAgentDraft(asDb(db), { workspaceId: WS, tokenId: "tok", source: "hermes", kind: "reply_template", title: "قالب", payload, idempotencyKey: "k-fail" });
    await expect(
      decideAgentDraft(asDb(db), { userId: "owner-1", workspaceId: WS, can }, row.id, { decision: "approve", edits: { answer: "اتصل 0936654998" } })
    ).rejects.toMatchObject({ code: "PII_BLOCKED" });
    expect(db._stores.agentDraft[0]).toMatchObject({ status: "PENDING", decidedBy: null });
    expect(db._stores.faq).toHaveLength(0);
    Object.assign(db._stores.agentDraft[0], { status: "DECIDING", updatedAt: new Date(Date.now() - 11 * MIN) });
    await expireStaleDrafts(asDb(db), WS);
    expect(db._stores.agentDraft[0].status).toBe("PENDING");
  });
});

// ─────────────────────── L16 — مخطط days بالدليل = zod ───────────────────────

describe("L16 — segment.days بالـ JSON Schema نفس حدود zod", () => {
  it("tuple: الأول 0–90 والتاني 1–365 · بلا خانات زيادة", () => {
    const days = ((TOOL_BY_NAME.get("draft_retarget_campaign")!.input_schema as Row).properties.segment.properties.days) as Row;
    expect(days).toEqual({
      type: "array",
      items: [
        { type: "integer", minimum: 0, maximum: 90 },
        { type: "integer", minimum: 1, maximum: 365 },
      ],
      minItems: 2,
      maxItems: 2,
      additionalItems: false,
    });
    const zod = TOOL_BY_NAME.get("draft_retarget_campaign")!.input;
    expect(zod.safeParse({ segment: { kind: "messaged_no_order", days: [100, 50] }, template_ref: "wa_tpl_x" }).success).toBe(false);
    expect(zod.safeParse({ segment: { kind: "messaged_no_order", days: [1, 7] }, template_ref: "wa_tpl_x" }).success).toBe(true);
  });
});

// ─────────────────────── نافذة رمز الكليبر ───────────────────────

describe("window_days من الكليبر بيحدد عمر إسناد الرمز", () => {
  it("رمز نافذته 7 أيام: طلب بعد 5 أيام = CODE · بعد 10 = NONE (والحد العام 28 لرمز بلا نافذة)", async () => {
    const db = fake();
    const at = new Date("2026-10-01T10:00:00Z");
    db._stores.attributionTouch.push(
      { id: "w1", workspaceId: WS, customerId: "cu", conversationId: "cv-w", channel: "whatsapp", kind: "CODE", source: "text", refCode: "K7Q2", codeStatus: "VALID", codeWindowDays: 7, episodeStart: true, dedupeKey: "w1", occurredAt: at },
      { id: "w2", workspaceId: WS, customerId: "cu", conversationId: "cv-n", channel: "whatsapp", kind: "CODE", source: "text", refCode: "K7Q3", codeStatus: "VALID", codeWindowDays: null, episodeStart: true, dedupeKey: "w2", occurredAt: at }
    );
    const r = (conversationId: string, days: number) => resolveOrderAttribution(asDb(db), { workspaceId: WS, conversationId, at: new Date(at.getTime() + days * DAY) });
    expect((await r("cv-w", 5)).method).toBe("CODE");
    expect((await r("cv-w", 10)).method).toBe("NONE");
    expect((await r("cv-n", 10)).method).toBe("CODE");
    expect((await r("cv-n", 29)).method).toBe("NONE");
  });
});
