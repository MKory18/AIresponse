import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import type { Db } from "@/modules/customers/service";
import { setIntegrationDnsLookup } from "@/modules/integrations/connections";
import { signZakiPayload, verifyZakiSignature } from "@/modules/integrations/signing";
import { saveOmsConnection } from "@/modules/oms/connection";
import { OMS_APP_EVENTS, omsAppEnvelopeSchema, omsStatusForAppEvent } from "@/modules/oms/app-webhook";
import { POST as omsWebhookPOST } from "@/app/api/webhooks/oms/[key]/route";
import { validateJsonSchema } from "./helpers/json-schema";

/**
 * عقد «أحداث تطبيقات الـ OMS v1» (contracts/oms-app-events.v1) — طرف سيستم 7.
 *
 * الأمثلة الذهبية مبنية حرفيًا من مُطلِقات الـ OMS الحقيقية (public-order.ts ·
 * orders/[id]/confirmation · orders/[id]/shipping) وتوقيع deliverOne(). نفس
 * الملفات بيمرّ عليها اختبار الـ OMS — أي تغيير بأي طرف بيطلع أحمر بالـ CI.
 */

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb } = await import("./helpers/inmemory-db");
  const db = createFakeDb();
  (globalThis as Record<string, unknown>).__contractsOmsDb = db;
  return { prisma: db };
});

type Row = Record<string, any>;
type FakeDb = ReturnType<typeof import("./helpers/inmemory-db").createFakeDb>;
const db = () => (globalThis as Record<string, unknown>).__contractsOmsDb as FakeDb;
const asDb = () => db() as unknown as Db;

const DIR = path.join(process.cwd(), "contracts", "oms-app-events.v1");
const readJson = (f: string) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Row;
const schema = readJson("schema.json");
const signed = readJson("signed-delivery.json");
const exampleFiles = readdirSync(DIR).filter((f) => f.startsWith("order.") && f.endsWith(".json")).sort();

/** الحالة المحلية المتوقعة لكل مثال (مرآة أسماء حالات الـ OMS نفسها). */
const EXPECTED_STATUS: Record<string, string> = {
  "order.created.json": "NEW",
  "order.confirmed.json": "CONFIRMED",
  "order.cancelled.confirmation.json": "CANCELLED",
  "order.shipped.json": "SHIPPED",
  "order.delivered.json": "DELIVERED",
  "order.returned.json": "RETURNED",
  "order.cancelled.shipping.json": "CANCELLED",
};

describe("عقد أحداث تطبيقات الـ OMS v1 — الأمثلة والمخطط", () => {
  it("كل الأمثلة موجودة (الأحداث الستة + الإلغاء من الشاشتين)", () => {
    expect(exampleFiles).toEqual(Object.keys(EXPECTED_STATUS).sort());
    const events = new Set(exampleFiles.map((f) => readJson(f).event));
    expect([...events].sort()).toEqual([...OMS_APP_EVENTS].sort());
  });

  it("قائمة الأحداث بالمخطط = قائمة سيستم 7 بالحرف (ولا حدث ناقص أو زايد)", () => {
    expect([...(schema.properties.event.enum as string[])].sort()).toEqual([...OMS_APP_EVENTS].sort());
  });

  it.each(Object.keys(EXPECTED_STATUS))("%s: مطابق للمخطط · بيقبله سيستم 7 · حالته المحلية صح", (file) => {
    const body = readJson(file);
    expect(validateJsonSchema(schema, body)).toEqual([]);
    const parsed = omsAppEnvelopeSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(omsStatusForAppEvent(parsed.data!)).toBe(EXPECTED_STATUS[file]);
  });

  it("المخطط بيرفض اللي بيكسر العقد (غلاف زايد · حدث مجهول · رقم طلب بصيغة غلط · بلا orderId)", () => {
    const ok = readJson("order.shipped.json");
    expect(validateJsonSchema(schema, { ...ok, id: "x" })).not.toEqual([]);
    expect(validateJsonSchema(schema, { ...ok, event: "order.paid" })).not.toEqual([]);
    expect(validateJsonSchema(schema, { ...ok, data: { ...ok.data, orderNumber: "148" } })).not.toEqual([]);
    const { orderId: _drop, ...noId } = ok.data;
    expect(validateJsonSchema(schema, { ...ok, data: noId })).not.toEqual([]);
    // إضافة حقل اختياري جوّا data مسموحة (تغيير غير كاسر).
    expect(validateJsonSchema(schema, { ...ok, data: { ...ok.data, courier: "ALBASHA" } })).toEqual([]);
  });
});

describe("عقد أحداث تطبيقات الـ OMS v1 — التوقيع", () => {
  const now = new Date(Number(signed.headers["X-Zaki-Timestamp"]) + 1000);

  it("المثال الموقّع محسوب صح: sha256= + HMAC على «الوقت.الجسم» (الوقت بالميلي ثانية)", () => {
    const ts = signed.headers["X-Zaki-Timestamp"] as string;
    expect(ts).toMatch(/^\d{13}$/);
    expect(signed.signature_example).toBe(`sha256=${signZakiPayload(signed.secret, ts, signed.body_raw)}`);
    expect(JSON.parse(signed.body_raw)).toEqual(readJson("order.shipped.json"));
    expect(signed.headers["X-Zaki-Event"]).toBe(JSON.parse(signed.body_raw).event);
  });

  it("المتحقق بسيستم 7 بيقبله · وبيرفض أي تلاعب أو تأخير", () => {
    const base = { secret: signed.secret, timestampHeader: signed.headers["X-Zaki-Timestamp"], signatureHeader: signed.signature_example, rawBody: signed.body_raw };
    expect(verifyZakiSignature({ ...base, now })).toMatchObject({ ok: true });
    expect(verifyZakiSignature({ ...base, rawBody: signed.body_raw.replace("185000", "1850"), now })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyZakiSignature({ ...base, secret: "test-other-secret", now })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyZakiSignature({ ...base, now: new Date(now.getTime() + 6 * 60_000) })).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
  });
});

describe("عقد أحداث تطبيقات الـ OMS v1 — المسار الحقيقي /api/webhooks/oms/[key]", () => {
  const WS = "ws-contracts-oms";
  const ctx = { userId: "owner-contracts", workspaceId: WS };
  let key: string;
  let orderId: string;

  beforeAll(() => setIntegrationDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]));
  afterAll(() => setIntegrationDnsLookup(null));

  beforeEach(async () => {
    const stores = db()._stores as Record<string, unknown[]>;
    for (const k of Object.keys(stores)) stores[k].length = 0;
    stores.workspace.push({ id: WS, name: "Zaki", slug: "zaki", timezone: "Asia/Amman", integrationSettings: {} });
    await saveOmsConnection(asDb(), ctx, { baseUrl: "https://oms.zaki.io", mode: "manual", webhookSecret: signed.secret });
    key = (db()._stores.omsConnection[0] as Row).webhookKey;
    const cu = (await db().customer.create({ data: { workspaceId: WS, phone: "0999000111" } } as never)) as Row;
    const example = JSON.parse(signed.body_raw) as Row;
    const order = (await db().order.create({
      data: {
        workspaceId: WS, orderNumber: "ORD-C-1", customerId: cu.id, status: "CONFIRMED", confirmationStatus: "CONFIRMED_BY_CUSTOMER",
        omsOrderId: example.data.orderId, omsOrderNumber: example.data.orderNumber, total: example.data.total, currency: example.data.currency,
      },
    } as never)) as Row;
    orderId = order.id;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Number(signed.headers["X-Zaki-Timestamp"]) + 1000));
  });
  afterEach(() => vi.useRealTimers());

  function post(headers: Record<string, string>, body: string) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return omsWebhookPOST(new NextRequest(`http://localhost/api/webhooks/oms/${key}`, { method: "POST", headers: lower, body }), { params: { key } });
  }

  it("التسليم الذهبي الموقّع (حرفيًا متل deliverOne) بيتطبّق على الطلب المربوط", async () => {
    const res = await post({ ...signed.headers, "X-Zaki-Signature": signed.signature_example }, signed.body_raw);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, outcome: "applied", orderId, duplicate: false });
    expect((db()._stores.order as Row[]).find((o) => o.id === orderId)).toMatchObject({ omsStatus: "SHIPPED" });
  });

  it("نفس التسليم بلا توقيع = 401 بلا أي أثر (الـ OMS بيبعت بلا توقيع إذا التطبيق بلا سر)", async () => {
    const res = await post(signed.headers, signed.body_raw);
    expect(res.status).toBe(401);
    expect((db()._stores.order as Row[]).find((o) => o.id === orderId)!.omsStatus ?? null).toBeNull();
  });
});
