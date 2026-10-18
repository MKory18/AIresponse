import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import nodeCrypto from "node:crypto";
import { NextRequest } from "next/server";
import type { Db } from "@/modules/customers/service";
import { clearRateLimitMemory } from "@/core/api/rate-limit";
import { saveIntegrationConnection, setIntegrationDnsLookup } from "@/modules/integrations/connections";
import { createIntegrationToken, revokeIntegrationToken } from "@/modules/integrations/tokens";
import { signZakiPayload, unixSeconds } from "@/modules/integrations/signing";
import { captureAttribution } from "@/modules/integrations/attribution";
import { GET as capacityGET } from "@/app/api/v1/capacity/route";
import { POST as retargetPOST } from "@/app/api/v1/retarget-campaigns/route";
import { GET as retargetGET } from "@/app/api/v1/retarget-campaigns/[id]/route";
import { POST as zakiWebhookPOST } from "@/app/api/v1/webhooks/[system]/route";

/**
 * P12 — مسارات HTTP الحقيقية التي تناديها أنظمة المنظومة، فوق حدود قاعدة
 * بيانات بالذاكرة (@/core/db/prisma مستبدل): توكن لكل نظام · صلاحية مسماة ·
 * X-Request-Id · توقيع الأحداث · لا تكرار · لا بيانات شخصية.
 */

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb } = await import("./helpers/inmemory-db");
  const db = createFakeDb();
  // معرّفات Prisma الحقيقية cuid — rep_rt_<id> يفترضها.
  const baseCreate = db.campaign.create.bind(db.campaign);
  (db.campaign as Record<string, unknown>).create = (args: Record<string, any>) =>
    baseCreate({ ...args, data: { id: `c${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`, ...args.data } } as never);
  (globalThis as Record<string, unknown>).__p12routesDb = db;
  return { prisma: db };
});

type FakeDb = ReturnType<typeof import("./helpers/inmemory-db").createFakeDb>;
type Row = Record<string, any>;
const db = () => (globalThis as Record<string, unknown>).__p12routesDb as FakeDb;
const asDb = () => db() as unknown as Db;

const WS = "ws-p12-routes-0001";
const WS_B = "ws-p12-routes-b";
const ctx = { userId: "owner-1", workspaceId: WS };
const ctxB = { userId: "owner-b", workspaceId: WS_B };

beforeAll(() => setIntegrationDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]));
afterAll(() => setIntegrationDnsLookup(null));

beforeEach(() => {
  const stores = db()._stores as Record<string, unknown[]>;
  for (const k of Object.keys(stores)) stores[k].length = 0;
  stores.workspace.push(
    { id: WS, name: "Zaki", slug: "zaki", timezone: "Asia/Amman", integrationSettings: {} },
    { id: WS_B, name: "Other", slug: "other", timezone: "UTC", integrationSettings: {} }
  );
  clearRateLimitMemory();
});

function req(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new NextRequest(`http://localhost${url}`, { method: init.method ?? "GET", headers: init.headers, body: init.body });
}
async function json(res: Response): Promise<Row> {
  return (await res.json()) as Row;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
async function token(system: "mediabuyer" | "clipper", c = ctx, extra: Row = {}) {
  return (await createIntegrationToken(asDb(), c, { system, ...extra })).token;
}

// ─────────────────────────── GET /api/v1/capacity ───────────────────────────

describe("P12 GET /api/v1/capacity — توكن الميديا باير فقط", () => {
  async function waiting(ws: string, type = "WHATSAPP") {
    const ch = (await db().channel.create({ data: { workspaceId: ws, type, status: "CONNECTED", externalId: `x-${Math.random()}` } } as never)) as Row;
    const cu = (await db().customer.create({ data: { workspaceId: ws } } as never)) as Row;
    await db().conversation.create({
      data: { workspaceId: ws, customerId: cu.id, channelId: ch.id, channelConversationId: `cc-${Math.random()}`, status: "OPEN", lastCustomerMessageAt: new Date(Date.now() - 60_000) },
    } as never);
  }

  it("بلا توكن / توكن غلط / مجهول = 401 بخطأ موحّد و X-Request-Id", async () => {
    const variants: Array<Record<string, string>> = [{}, { authorization: "Bearer abc" }, { authorization: `Bearer zr_mb_${"A".repeat(32)}` }, { authorization: "Basic dXNlcjpwYXNz" }];
    for (const headers of variants) {
      const res = await capacityGET(req("/api/v1/capacity", { headers: { ...headers, "x-request-id": "req-401-a" } }));
      expect(res.status).toBe(401);
      const body = await json(res);
      expect(body).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String), details: [] }, request_id: "req-401-a" });
      expect(res.headers.get("x-request-id")).toBe("req-401-a");
    }
  });

  it("توكن موقوف أو منتهي = 401 فورًا", async () => {
    const created = await createIntegrationToken(asDb(), ctx, { system: "mediabuyer" });
    expect((await capacityGET(req("/api/v1/capacity", { headers: bearer(created.token) }))).status).toBe(200);
    await revokeIntegrationToken(asDb(), ctx, created.view.id);
    expect((await capacityGET(req("/api/v1/capacity", { headers: bearer(created.token) }))).status).toBe(401);
    const t2 = await token("mediabuyer");
    db()._stores.integrationToken.find((r) => r.revokedAt === null)!.expiresAt = new Date(Date.now() - 1000);
    expect((await capacityGET(req("/api/v1/capacity", { headers: bearer(t2) }))).status).toBe(401);
  });

  it("توكن الكليبر (بلا capacity.read) = 403 SCOPE_NOT_ALLOWED", async () => {
    const res = await capacityGET(req("/api/v1/capacity", { headers: bearer(await token("clipper")) }));
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("SCOPE_NOT_ALLOWED");
  });

  it("200: الجسم حرفيًا {unanswered, first_response_p50_min, by_channel, at} لمساحة التوكن فقط", async () => {
    await waiting(WS);
    await waiting(WS, "FACEBOOK");
    await waiting(WS_B);
    await waiting(WS_B);
    const res = await capacityGET(req("/api/v1/capacity", { headers: { ...bearer(await token("mediabuyer")), "x-request-id": "mb-req-77" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("mb-req-77");
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(["at", "by_channel", "first_response_p50_min", "unanswered"]);
    expect(body).toMatchObject({ unanswered: 2, by_channel: { whatsapp: 1, messenger: 1 }, first_response_p50_min: null });
    expect(body.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+03:00$/);
    // آخر استخدام للتوكن يُسجّل.
    expect(db()._stores.integrationToken[0].lastUsedAt).toBeTruthy();
  });

  it("X-Request-Id غير صالح يُستبدل بمعرّف مولّد", async () => {
    const res = await capacityGET(req("/api/v1/capacity", { headers: { ...bearer(await token("mediabuyer")), "x-request-id": "bad id with spaces" } }));
    const id = res.headers.get("x-request-id")!;
    expect(id).not.toBe("bad id with spaces");
    expect(id).toMatch(/^rep_/);
  });

  it("حد الطلبات لكل توكن = 429 RATE_LIMITED", async () => {
    const t = await token("mediabuyer", ctx, { rateLimitPerMin: 2 });
    expect((await capacityGET(req("/api/v1/capacity", { headers: bearer(t) }))).status).toBe(200);
    expect((await capacityGET(req("/api/v1/capacity", { headers: bearer(t) }))).status).toBe(200);
    const res = await capacityGET(req("/api/v1/capacity", { headers: bearer(t) }));
    expect(res.status).toBe(429);
    expect((await json(res)).error.code).toBe("RATE_LIMITED");
    // توكن آخر لا يتأثر.
    expect((await capacityGET(req("/api/v1/capacity", { headers: bearer(await token("mediabuyer")) }))).status).toBe(200);
  });
});

// ─────────────────────── /api/v1/retarget-campaigns ───────────────────────

describe("P12 /api/v1/retarget-campaigns — توكن الكليبر", () => {
  const body = (o: Row = {}) =>
    JSON.stringify({
      external_ref: "clp_rt_42",
      channel: "whatsapp",
      segment: { kind: "messaged_no_order", days: [1, 7] },
      template_ref: "promo_k7",
      opt_in_required: true,
      approved_by: "owner@clipper",
      approved_at: "2026-10-11T08:00:00+03:00",
      ...o,
    });

  async function world() {
    const ch = (await db().channel.create({ data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", externalId: "pn-1" } } as never)) as Row;
    for (const consent of ["OPTED_IN", "OPTED_IN", "UNKNOWN"]) {
      const cu = (await db().customer.create({ data: { workspaceId: WS, marketingConsent: consent } } as never)) as Row;
      await db().channelIdentity.create({ data: { workspaceId: WS, customerId: cu.id, channelType: "WHATSAPP", channelExternalId: `wa-${cu.id}` } } as never);
      const cv = (await db().conversation.create({ data: { workspaceId: WS, customerId: cu.id, channelId: ch.id, channelConversationId: `wa-${cu.id}` } } as never)) as Row;
      await captureAttribution(asDb(), {
        workspaceId: WS,
        customerId: cu.id,
        conversationId: cv.id,
        channelType: "WHATSAPP",
        eventKey: `k-${cu.id}`,
        text: "رمز K7Q2",
        occurredAt: new Date(Date.now() - 2 * 86400_000),
      });
    }
  }
  const post = (t: string, b: string, headers: Record<string, string> = {}) =>
    retargetPOST(req("/api/v1/retarget-campaigns", { method: "POST", headers: { ...bearer(t), "content-type": "application/json", ...headers }, body: b }));

  it("201 أول مرة · 200 لنفس Idempotency-Key بنفس الجسم · أعداد بلا أشخاص", async () => {
    await world();
    const t = await token("clipper");
    const first = await post(t, body(), { "idempotency-key": "clp-idem-0001", "x-request-id": "clp-req-1" });
    expect(first.status).toBe(201);
    expect(first.headers.get("x-request-id")).toBe("clp-req-1");
    const created = await json(first);
    expect(created).toEqual({ campaign_id: expect.stringMatching(/^rep_rt_[a-z0-9]{8,40}$/), status: "pending_approval", eligible_count: 2 });
    const again = await post(t, body(), { "idempotency-key": "clp-idem-0001" });
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual(created);
    expect(db()._stores.campaign).toHaveLength(1);
  });

  it("422: بلا Idempotency-Key · JSON مكسور · مخطط غلط (مع التفاصيل) · قناة غير واتساب", async () => {
    await world();
    const t = await token("clipper");
    const noKey = await post(t, body());
    expect(noKey.status).toBe(422);
    expect((await json(noKey)).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const broken = await post(t, "{not json", { "idempotency-key": "clp-idem-0002" });
    expect(broken.status).toBe(422);
    expect((await json(broken)).error.code).toBe("VALIDATION_FAILED");
    const invalid = await post(t, body({ opt_in_required: false, template_ref: "Bad Ref" }), { "idempotency-key": "clp-idem-0003" });
    expect(invalid.status).toBe(422);
    const err = (await json(invalid)).error;
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.details.map((d: Row) => d.path).sort()).toEqual(["opt_in_required", "template_ref"]);
    const tg = await post(t, body({ channel: "telegram" }), { "idempotency-key": "clp-idem-0004" });
    expect(tg.status).toBe(422);
    expect((await json(tg)).error.code).toBe("RETARGET_WHATSAPP_ONLY");
    expect(db()._stores.campaign).toHaveLength(0);
  });

  it("الصلاحيات: توكن الميديا باير = 403 · توكن قراءة فقط لا ينشئ", async () => {
    await world();
    const mb = await post(await token("mediabuyer"), body(), { "idempotency-key": "clp-idem-0005" });
    expect(mb.status).toBe(403);
    const readOnly = await token("clipper", ctx, { scopes: ["retarget.read"] });
    const ro = await post(readOnly, body(), { "idempotency-key": "clp-idem-0006" });
    expect(ro.status).toBe(403);
    expect((await json(ro)).error.code).toBe("SCOPE_NOT_ALLOWED");
    expect(db()._stores.campaign).toHaveLength(0);
  });

  it("GET /{id}: الحالة والأعداد لحملة الكليبر بمساحة التوكن — ومساحة أخرى أو معرّف مجهول = 404", async () => {
    await world();
    const t = await token("clipper");
    const { campaign_id } = await json(await post(t, body(), { "idempotency-key": "clp-idem-0007" }));
    const res = await retargetGET(req(`/api/v1/retarget-campaigns/${campaign_id}`, { headers: bearer(t) }), { params: { id: campaign_id } });
    expect(res.status).toBe(200);
    const got = await json(res);
    expect(got).toMatchObject({ campaign_id, external_ref: "clp_rt_42", status: "pending_approval" });
    expect(Object.keys(got.counts).sort()).toEqual(["delivered", "eligible", "excluded", "failed", "opted_out", "ordered", "read", "replied", "sent"]);
    const other = await token("clipper", ctxB);
    expect((await retargetGET(req(`/api/v1/retarget-campaigns/${campaign_id}`, { headers: bearer(other) }), { params: { id: campaign_id } })).status).toBe(404);
    const missing = await retargetGET(req("/api/v1/retarget-campaigns/rep_rt_doesnotexist01", { headers: bearer(t) }), { params: { id: "rep_rt_doesnotexist01" } });
    expect(missing.status).toBe(404);
    expect((await json(missing)).error.code).toBe("NOT_FOUND");
    const readOnly = await token("clipper", ctx, { scopes: ["retarget.read"] });
    expect((await retargetGET(req(`/api/v1/retarget-campaigns/${campaign_id}`, { headers: bearer(readOnly) }), { params: { id: campaign_id } })).status).toBe(200);
  });
});

// ───────────────────── POST /api/v1/webhooks/{system}?ws= ─────────────────────

describe("P12 POST /api/v1/webhooks/[system] — أحداث سيستم 1 الموقّعة", () => {
  let secret: string;
  beforeEach(async () => {
    secret = (await saveIntegrationConnection(asDb(), ctx, "s1", { baseUrl: "https://s1.zakai.io", token: "s1-token-1", generateEventsSecret: true })).generatedEventsSecret!;
  });

  const envelope = (o: Row = {}) => JSON.stringify({ event_id: "evt_s1_0001", type: "compliance.updated", occurred_at: "2026-10-11T09:00:00+03:00", data: { product_ref: "pf_2031" }, ...o });
  function signed(raw: string, o: { system?: string; ws?: string | null; secret?: string; ts?: string; sig?: string } = {}) {
    const ts = o.ts ?? unixSeconds();
    const sig = o.sig ?? signZakiPayload(o.secret ?? secret, ts, raw);
    const qs = o.ws === null ? "" : `?ws=${o.ws ?? "zaki"}`;
    const system = o.system ?? "s1";
    return zakiWebhookPOST(
      req(`/api/v1/webhooks/${system}${qs}`, { method: "POST", headers: { "x-zaki-timestamp": ts, "x-zaki-signature": sig, "content-type": "application/json", "x-request-id": "s1-req-1" }, body: raw }),
      { params: { system } }
    );
  }
  const jobs = () => db()._stores.backgroundJob.filter((j) => j.type === "refresh_product_compliance");

  it("حدث موقّع صحيح = 200 + مهمة إعادة قراءة + الحدث مسجّل ومعالج", async () => {
    const res = await signed(envelope());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("s1-req-1");
    expect(await json(res)).toEqual({ ok: true, request_id: "s1-req-1" });
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ workspaceId: WS, payload: { productRef: "pf_2031" }, idempotencyKey: `compliance:${WS}:pf_2031:evt_s1_0001` });
    const ev = db()._stores.webhookEvent;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ source: `zaki:s1:${WS}`, externalEventId: "evt_s1_0001", workspaceId: WS });
    expect(ev[0].processedAt).toBeTruthy();
  });

  it("نفس الحدث لمساحتين (سيستم 1 وحدة) = كل مساحة بتعالجه — المكرر لكل مساحة لحالها", async () => {
    const secretB = (await saveIntegrationConnection(asDb(), ctxB, "s1", { baseUrl: "https://s1.zakai.io", token: "s1-token-b", generateEventsSecret: true })).generatedEventsSecret!;
    expect((await signed(envelope())).status).toBe(200);
    const b = await signed(envelope(), { ws: "other", secret: secretB });
    expect(b.status).toBe(200);
    expect(await json(b)).toEqual({ ok: true, request_id: "s1-req-1" });
    expect(jobs().map((j) => j.workspaceId).sort()).toEqual([WS, WS_B].sort());
    const again = await signed(envelope(), { ws: "other", secret: secretB });
    expect(await json(again)).toMatchObject({ duplicate: true });
    expect(jobs()).toHaveLength(2);
  });

  it("event_id مكرر = 200 duplicate بلا معالجة ثانية", async () => {
    await signed(envelope());
    const again = await signed(envelope({ data: { product_ref: "pf_9999" } }));
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ ok: true, duplicate: true });
    expect(jobs()).toHaveLength(1);
    expect(db()._stores.webhookEvent).toHaveLength(1);
  });

  it("بيانات شخصية بالحدث = 422 PII_BLOCKED بلا أي أثر", async () => {
    for (const data of [{ product_ref: "pf_1", note: "اتصل على 0936654998" }, { product_ref: "pf_1", phone: "x" }, { product_ref: "pf_1", contact: "a@b.co" }]) {
      const res = await signed(envelope({ event_id: `evt_pii_${Math.random()}`, data }));
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe("PII_BLOCKED");
    }
    expect(db()._stores.webhookEvent).toHaveLength(0);
    expect(jobs()).toHaveLength(0);
  });

  it("توقيع غلط · سر مساحة أخرى · وقت أقدم من 5 دقائق · رؤوس ناقصة = 401", async () => {
    const raw = envelope();
    expect((await signed(raw, { sig: "a".repeat(64) })).status).toBe(401);
    expect((await signed(raw, { secret: "zrs_other_secret_value" })).status).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 301);
    const stale = await signed(raw, { ts: old });
    expect(stale.status).toBe(401);
    expect((await json(stale)).error.message).toContain("STALE_TIMESTAMP");
    const res = await zakiWebhookPOST(req("/api/v1/webhooks/s1?ws=zaki", { method: "POST", body: raw }), { params: { system: "s1" } });
    expect(res.status).toBe(401);
    // جسم معدّل بعد التوقيع.
    const ts = unixSeconds();
    const sig = signZakiPayload(secret, ts, raw);
    expect((await signed(raw.replace("pf_2031", "pf_2032"), { ts, sig })).status).toBe(401);
    expect(db()._stores.webhookEvent).toHaveLength(0);
  });

  it("نظام بلا أحداث واردة أو غير معروف · مساحة ناقصة/مجهولة = 404", async () => {
    for (const system of ["clipper", "nope", "mediabuyer"]) expect((await signed(envelope(), { system })).status).toBe(404);
    expect((await signed(envelope(), { ws: null })).status).toBe(404);
    expect((await signed(envelope(), { ws: "ghost" })).status).toBe(404);
    expect((await signed(envelope(), { ws: "bad slug!" })).status).toBe(404);
  });

  it("اتصال موقوف أو بلا سر = 401", async () => {
    await saveIntegrationConnection(asDb(), ctx, "s1", { enabled: false });
    expect((await signed(envelope())).status).toBe(401);
    await saveIntegrationConnection(asDb(), ctx, "s1", { enabled: true, clearEventsSecret: true });
    expect((await signed(envelope())).status).toBe(401);
  });

  it("422: JSON مكسور (موقّع) · غلاف ناقص · نوع حدث غير مدعوم", async () => {
    for (const raw of ["{not json", JSON.stringify({ type: "compliance.updated", data: {} }), envelope({ type: "compliance.deleted" })]) {
      const res = await signed(raw);
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe("VALIDATION_FAILED");
    }
    expect(jobs()).toHaveLength(0);
  });

  // BUG (src/app/api/v1/webhooks/[system]/route.ts:83-95): onComplianceUpdated يرمي
  // AppError(422 VALIDATION_FAILED) لحدث compliance.updated بلا product_ref، لكن المسار
  // يلتقط كل خطأ ويرجّع 500 ويحذف الحدث — فسيستم 1 يعيد إرسال حدث مرفوض نهائيًا
  // للأبد، خلافًا لتوثيق المسار «شكل غلط … = 422».
  it("compliance.updated بلا product_ref = 422 (رفض نهائي — لا 500 يستدعي إعادة الإرسال)", async () => {
    const res = await signed(envelope({ event_id: "evt_s1_noref", data: { note: "تحديث" } }));
    expect(res.status).toBe(422);
  });
});

