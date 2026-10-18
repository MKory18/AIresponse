import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import nodeCrypto from "node:crypto";
import { createFakeDb } from "./helpers/inmemory-db";
import { decryptSecret, encryptSecret } from "@/core/crypto";
import {
  signZakiPayload,
  verifyZakiSignature,
  parseZakiTimestamp,
  unixSeconds,
} from "@/modules/integrations/signing";
import { findPii } from "@/modules/integrations/pii-guard";
import { decimalString, isoInZone, conversationRef, agentRef, channelKey } from "@/modules/integrations/format";
import {
  BACKOFF_SEC,
  MAX_ATTEMPTS,
  deliverDueIntegrations,
  emitIntegrationEvent,
  enqueueSystemCall,
  retryDelivery,
} from "@/modules/integrations/outbox";
import { saveIntegrationConnection, validateSystemUrl, listConnectionViews, setIntegrationDnsLookup } from "@/modules/integrations/connections";
import {
  createIntegrationToken,
  revokeIntegrationToken,
  verifyIntegrationToken,
  hashToken,
} from "@/modules/integrations/tokens";
import { resolveIntegrationSettings, DEFAULT_INTEGRATION_SETTINGS } from "@/modules/integrations/settings";
import type { Db } from "@/modules/customers/service";

/**
 * P12 — أساس الربط مع المنظومة: التوقيع · حارس البيانات الشخصية · أشكال
 * القيم · صندوق الصادر (إعادة المحاولة · عدم التكرار · التوقيع) · التوكنات.
 */

const WS = "ws-p12";

// الاختبارات لا تلمس الشبكة: محلّل DNS ثابت (اسم يشير لبيانات السحابة الوصفية يُرفض).
beforeAll(() =>
  setIntegrationDnsLookup(async (host) =>
    host === "metadata.evil.example" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]
  )
);
afterAll(() => setIntegrationDnsLookup(null));
const ctx = { userId: "owner-1", workspaceId: WS };

function fake() {
  const db = createFakeDb();
  (db as any).workspace.create({ data: { id: WS, name: "Zaki", slug: "zaki", timezone: "Asia/Amman" } });
  return db as unknown as Db & { _stores: Record<string, any[]> };
}

describe("P12 signing — صيغة المنظومة وصيغة الـ OMS الحقيقية", () => {
  const secret = "s3cret-for-tests";
  const body = JSON.stringify({ event_id: "evt_1", type: "compliance.updated", data: { product_ref: "pf_1" } });

  it("يقبل التوقيع بالثواني وhex بلا بادئة (عقد الجسر والكليبر)", () => {
    const ts = unixSeconds();
    const sig = signZakiPayload(secret, ts, body);
    expect(verifyZakiSignature({ secret, timestampHeader: ts, signatureHeader: sig, rawBody: body }).ok).toBe(true);
  });

  it("يقبل صيغة الـ OMS: الوقت بالميلي ثانية والتوقيع sha256=hex على `${ts}.${body}`", () => {
    const ts = String(Date.now());
    const sig = "sha256=" + nodeCrypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(verifyZakiSignature({ secret, timestampHeader: ts, signatureHeader: sig, rawBody: body }).ok).toBe(true);
  });

  it("يرفض جسمًا معدّلًا وسرًا غلط ووقتًا أقدم من 5 دقايق", () => {
    const ts = unixSeconds();
    const sig = signZakiPayload(secret, ts, body);
    expect(verifyZakiSignature({ secret, timestampHeader: ts, signatureHeader: sig, rawBody: body + " " })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyZakiSignature({ secret: "other", timestampHeader: ts, signatureHeader: sig, rawBody: body }).ok).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 301);
    const oldSig = signZakiPayload(secret, old, body);
    expect(verifyZakiSignature({ secret, timestampHeader: old, signatureHeader: oldSig, rawBody: body })).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
  });

  it("الوقت يُوقَّع كما وصل حرفيًا — تحويل الميلي لثواني لا يمرّر توقيعًا محسوبًا على شكل آخر", () => {
    const ms = String(Date.now());
    const sec = String(Math.floor(Number(ms) / 1000));
    const sigOverSeconds = signZakiPayload(secret, sec, body);
    expect(verifyZakiSignature({ secret, timestampHeader: ms, signatureHeader: sigOverSeconds, rawBody: body }).ok).toBe(false);
  });

  it("رؤوس ناقصة أو وقت غير رقمي = رفض", () => {
    expect(verifyZakiSignature({ secret, timestampHeader: null, signatureHeader: "x", rawBody: body }).ok).toBe(false);
    expect(verifyZakiSignature({ secret, timestampHeader: "abc", signatureHeader: "a".repeat(64), rawBody: body })).toEqual({ ok: false, reason: "BAD_TIMESTAMP" });
    expect(parseZakiTimestamp("1760149440")).toBe(1760149440);
    expect(parseZakiTimestamp("1760149440123")).toBe(1760149440);
  });
});

describe("P12 PII guard — ولا اسم ولا هاتف ولا إيميل يطلع", () => {
  it("يلتقط الهاتف بكل أشكاله (عربي/لاتيني/دولي) والإيميل والمفاتيح الشخصية", () => {
    expect(findPii({ note: "اتصل على 0936654998" }).map((f) => f.kind)).toContain("PHONE");
    expect(findPii({ note: "+963 936 654 998" }).map((f) => f.kind)).toContain("PHONE");
    expect(findPii({ note: "٠٩٣٦٦٥٤٩٩٨" }).map((f) => f.kind)).toContain("PHONE");
    expect(findPii({ x: "a@b.co" }).map((f) => f.kind)).toContain("EMAIL");
    expect(findPii({ phone: "x" }).map((f) => f.kind)).toContain("PERSONAL_KEY");
    expect(findPii({ n: 963936654998 }).map((f) => f.kind)).toContain("PHONE");
  });

  it("يسمح بالمبالغ والتواريخ والعدّادات ورقم الإعلان تحت مفتاحه", () => {
    expect(findPii({ amount: "1500.00", at: "2026-10-11T09:00:00+03:00", count: 37, ad_id: "120211000000000001", code: "K7Q2" })).toEqual([]);
  });

  it("رقم الإعلان الطويل تحت مفتاح غير معرّف = مشبوه", () => {
    expect(findPii({ note: "120211000000000001" }).length).toBeGreaterThan(0);
  });
});

describe("P12 format — أشكال العقد", () => {
  it("المبالغ نص بخانتين بلا أخطاء كسور", () => {
    expect(decimalString(0.1 + 0.2)).toBe("0.30");
    expect(decimalString("20")).toBe("20.00");
    expect(decimalString(1234.5)).toBe("1234.50");
    expect(decimalString(null)).toBeNull();
    expect(decimalString("abc")).toBeNull();
  });
  it("ISO بإزاحة المنطقة", () => {
    expect(isoInZone(new Date("2026-10-11T06:00:00Z"), "Asia/Amman")).toBe("2026-10-11T09:00:00+03:00");
    expect(isoInZone(new Date("2026-10-11T06:00:00Z"), "UTC")).toBe("2026-10-11T06:00:00+00:00");
  });
  it("مراجع معتمة ثابتة", () => {
    expect(conversationRef("c1")).toMatch(/^cv_[a-p]{12}$/);
    expect(conversationRef("c1")).toBe(conversationRef("c1"));
    expect(conversationRef("c1")).not.toBe(conversationRef("c2"));
    expect(agentRef("u1")).toMatch(/^agt_[a-p]{10}$/);
    expect(channelKey("FACEBOOK")).toBe("messenger");
    expect(channelKey("WHATSAPP")).toBe("whatsapp");
  });
});

describe("P12 system URLs — حارس الروابط", () => {
  beforeEach(() => {
    delete process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORK;
  });
  it("https عام مقبول · http عام مرفوض · بيانات دخول بالرابط مرفوضة", () => {
    expect(validateSystemUrl("https://clipper.zakai.io").ok).toBe(true);
    expect(validateSystemUrl("http://clipper.zakai.io")).toEqual({ ok: false, reason: "HTTPS_REQUIRED" });
    expect(validateSystemUrl("https://user:pw@clipper.zakai.io").ok).toBe(false);
  });
  it("الشبكة الخاصة مرفوضة إلا بعلم المشغّل — والبيانات الوصفية للسحابة مرفوضة دائمًا", () => {
    expect(validateSystemUrl("http://127.0.0.1:8791").ok).toBe(false);
    expect(validateSystemUrl("http://zaki-bridge:8791").ok).toBe(false);
    process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORK = "true";
    expect(validateSystemUrl("http://127.0.0.1:8791").ok).toBe(true);
    expect(validateSystemUrl("http://zaki-bridge:8791").ok).toBe(true);
    expect(validateSystemUrl("https://169.254.169.254/latest").ok).toBe(false);
    expect(validateSystemUrl("http://[fd00:ec2::254]/").ok).toBe(false);
  });
});

describe("P12 connections — الأسرار مشفّرة ولا ترجع", () => {
  it("اسم يُحلّ لعنوان بيانات السحابة الوصفية يُرفض عند الحفظ", async () => {
    const db = fake();
    await expect(saveIntegrationConnection(db, ctx, "clipper", { baseUrl: "https://metadata.evil.example" })).rejects.toMatchObject({
      code: "INVALID_SYSTEM_URL",
    });
  });

  it("يحفظ التوكن والسر مشفّرين، والعرض يقول موجود/لا فقط، والحقل الفارغ لا يمسح", async () => {
    const db = fake();
    const { view, generatedEventsSecret } = await saveIntegrationConnection(db, ctx, "clipper", {
      baseUrl: "https://clipper.zakai.io/",
      token: "clipper-token-123456",
      generateEventsSecret: true,
    });
    expect(view.baseUrl).toBe("https://clipper.zakai.io");
    expect(view.hasToken).toBe(true);
    expect(view.hasEventsSecret).toBe(true);
    expect(view.effectiveEventsUrl).toBe("https://clipper.zakai.io/api/v1/webhooks/replies");
    expect(JSON.stringify(view)).not.toContain("clipper-token-123456");
    expect(generatedEventsSecret).toMatch(/^zrs_[a-f0-9]{64}$/);
    const row = db._stores.integrationConnection[0];
    expect(row.tokenEncrypted).not.toContain("clipper-token");
    expect(decryptSecret(row.tokenEncrypted)).toBe("clipper-token-123456");
    // حفظ تاني بلا توكن = لا تغيير على التوكن
    await saveIntegrationConnection(db, ctx, "clipper", { enabled: false });
    expect(decryptSecret(db._stores.integrationConnection[0].tokenEncrypted)).toBe("clipper-token-123456");
    const views = await listConnectionViews(db, WS);
    expect(views.find((v) => v.system === "clipper")?.enabled).toBe(false);
    // السجل بلا أسرار
    const audit = db._stores.auditLog.find((a) => a.action === "integration.connection_saved");
    expect(JSON.stringify(audit.metadata)).not.toContain("clipper-token");
  });
});

describe("P12 outbox — يُكتب أولًا ثم يُرسل موقّعًا بإعادة محاولة", () => {
  async function setupClipper(db: Db) {
    const { generatedEventsSecret } = await saveIntegrationConnection(db, ctx, "clipper", {
      baseUrl: "https://clipper.zakai.io",
      token: "clipper-token-123456",
      generateEventsSecret: true,
    });
    return generatedEventsSecret!;
  }

  it("حدث صالح يُكتب مرة واحدة لكل نظام مستقبِل (dedupeKey)", async () => {
    const db = fake();
    await setupClipper(db);
    const data = { code: "K7Q2", channel: "whatsapp", conversation_ref: conversationRef("c1") };
    expect(await emitIntegrationEvent(db, { workspaceId: WS, type: "conversation.coded", data, dedupeKey: "c1:e1" })).toBe(1);
    expect(await emitIntegrationEvent(db, { workspaceId: WS, type: "conversation.coded", data, dedupeKey: "c1:e1" })).toBe(0);
    const rows = (db as any)._stores.integrationDelivery;
    expect(rows).toHaveLength(1);
    const body = JSON.parse(rows[0].body);
    expect(body.type).toBe("conversation.coded");
    expect(body.event_id).toMatch(/^evt_rep_[a-f0-9]{20}$/);
    expect(body.occurred_at).toMatch(/\+03:00$/);
    expect(body.data).toEqual(data);
  });

  it("حدث فيه هاتف أو حقل خارج العقد لا يُكتب أبدًا", async () => {
    const db = fake();
    await setupClipper(db);
    expect(
      await emitIntegrationEvent(db, {
        workspaceId: WS,
        type: "conversation.coded",
        data: { code: "K7Q2", channel: "whatsapp", conversation_ref: conversationRef("c1"), phone: "0936654998" },
        dedupeKey: "x",
      })
    ).toBe(0);
    expect((db as any)._stores.integrationDelivery).toHaveLength(0);
  });

  it("نظام بلا سر توقيع أو موقوف = لا كتابة", async () => {
    const db = fake();
    await saveIntegrationConnection(db, ctx, "clipper", { baseUrl: "https://clipper.zakai.io" });
    const data = { code: "K7Q2", channel: "whatsapp", conversation_ref: conversationRef("c1") };
    expect(await emitIntegrationEvent(db, { workspaceId: WS, type: "conversation.coded", data, dedupeKey: "a" })).toBe(0);
  });

  it("الإرسال موقّع بالعقد حرفيًا، ونجاح 2xx يغلق الصف", async () => {
    const db = fake();
    const secret = await setupClipper(db);
    const data = { code: "K7Q2", channel: "whatsapp", conversation_ref: conversationRef("c1") };
    await emitIntegrationEvent(db, { workspaceId: WS, type: "conversation.coded", data, dedupeKey: "ok" });
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await deliverDueIntegrations(db, { fetchImpl });
    expect(res.sent).toBe(1);
    expect(seen[0].url).toBe("https://clipper.zakai.io/api/v1/webhooks/replies");
    const h = seen[0].headers;
    expect(h["x-zaki-event"]).toBe("conversation.coded");
    expect(verifyZakiSignature({ secret, timestampHeader: h["x-zaki-timestamp"], signatureHeader: h["x-zaki-signature"], rawBody: seen[0].body }).ok).toBe(true);
    expect(h["x-request-id"]).toMatch(/^rep_/);
    const row = (db as any)._stores.integrationDelivery[0];
    expect(row.status).toBe("OK");
    expect(row.attempts).toBe(1);
  });

  it("فشل الشبكة/5xx = إعادة بعد 30 ثانية ثم الجدول · 422 = فشل نهائي بلا إعادة", async () => {
    const db = fake();
    await setupClipper(db);
    const data = { code: "K7Q2", channel: "whatsapp", conversation_ref: conversationRef("c1") };
    await emitIntegrationEvent(db, { workspaceId: WS, type: "conversation.coded", data, dedupeKey: "r" });
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const r1 = await deliverDueIntegrations(db, { fetchImpl: down });
    expect(r1.retrying).toBe(1);
    const row = (db as any)._stores.integrationDelivery[0];
    expect(row.status).toBe("PENDING");
    const waitSec = (new Date(row.nextAttemptAt).getTime() - Date.now()) / 1000;
    expect(waitSec).toBeGreaterThan(BACKOFF_SEC[0] - 3);
    expect(waitSec).toBeLessThanOrEqual(BACKOFF_SEC[0] + 1);
    // ليس مستحقًا بعد → لا إرسال
    expect((await deliverDueIntegrations(db, { fetchImpl: down })).retrying).toBe(0);

    await emitIntegrationEvent(db, { workspaceId: WS, type: "conversation.coded", data, dedupeKey: "bad" });
    const reject = (async () => new Response("", { status: 422 })) as unknown as typeof fetch;
    const r2 = await deliverDueIntegrations(db, { fetchImpl: reject });
    expect(r2.failed).toBe(1);
    const bad = (db as any)._stores.integrationDelivery.find((d: any) => d.dedupeKey.endsWith(":bad"));
    expect(bad.status).toBe("FAILED");
    expect(bad.nextAttemptAt).toBeNull();
  });

  it("بعد آخر محاولة يصير FAILED، وإعادة المحاولة اليدوية ترجعه", async () => {
    const db = fake();
    await setupClipper(db);
    const data = { code: "K7Q2", channel: "whatsapp", conversation_ref: conversationRef("c1") };
    await emitIntegrationEvent(db, { workspaceId: WS, type: "conversation.coded", data, dedupeKey: "x" });
    const row = (db as any)._stores.integrationDelivery[0];
    row.attempts = MAX_ATTEMPTS - 1;
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await deliverDueIntegrations(db, { fetchImpl: down });
    expect(r.failed).toBe(1);
    expect(row.status).toBe("FAILED");
    await retryDelivery(db, ctx, row.id);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
  });

  it("نظام انوقف بعد الكتابة = الصف يُلغى بدل الإرسال", async () => {
    const db = fake();
    await setupClipper(db);
    const data = { code: "K7Q2", channel: "whatsapp", conversation_ref: conversationRef("c1") };
    await emitIntegrationEvent(db, { workspaceId: WS, type: "conversation.coded", data, dedupeKey: "y" });
    await saveIntegrationConnection(db, ctx, "clipper", { enabled: false });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const r = await deliverDueIntegrations(db, { fetchImpl });
    expect(called).toBe(false);
    expect(r.cancelled).toBe(1);
  });

  it("النداء يحمل توكن الاتصال وIdempotency-Key وقت الإرسال فقط (لا يُخزّن التوكن بالصف)", async () => {
    const db = fake();
    await saveIntegrationConnection(db, ctx, "finance", { baseUrl: "https://finance.zakai.io", token: "fin-token-abcdef" });
    const ok = await enqueueSystemCall(db, {
      workspaceId: WS,
      system: "finance",
      type: "usage-costs",
      path: "/api/v1/usage-costs",
      body: { system: "replies", date: "2026-10-10", items: [{ kind: "model_api", provider: "openrouter", amount: "1.84", currency: "USD" }] },
      idempotencyKey: "replies-usage-2026-10-10",
      dedupeKey: "2026-10-10",
    });
    expect(ok).toBe(true);
    const row = (db as any)._stores.integrationDelivery[0];
    expect(row.body).not.toContain("fin-token");
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    await deliverDueIntegrations(db, { fetchImpl });
    expect(headers.authorization).toBe("Bearer fin-token-abcdef");
    expect(headers["idempotency-key"]).toBe("replies-usage-2026-10-10");
  });
});

describe("P12 tokens — أقل صلاحية · تجزئة فقط · إيقاف فوري", () => {
  it("توكن الميديا باير لا يقدر يطلب صلاحية حملات", async () => {
    const db = fake();
    await expect(createIntegrationToken(db, ctx, { system: "mediabuyer", scopes: ["retarget.create"] })).rejects.toMatchObject({
      code: "SCOPE_NOT_ALLOWED",
    });
  });

  it("النص يُعرض مرة ويُحفظ كتجزئة، والإيقاف يقتله فورًا", async () => {
    const db = fake();
    const { token, view } = await createIntegrationToken(db, ctx, { system: "clipper" });
    expect(token).toMatch(/^zr_clp_/);
    expect(view.scopes).toEqual(["retarget.create", "retarget.read"]);
    const row = (db as any)._stores.integrationToken[0];
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect((await verifyIntegrationToken(db, token))?.id).toBe(row.id);
    expect(await verifyIntegrationToken(db, token + "x")).toBeNull();
    await revokeIntegrationToken(db, ctx, view.id);
    expect(await verifyIntegrationToken(db, token)).toBeNull();
  });

  it("المنتهي مرفوض (90 يوم افتراضيًا)", async () => {
    const db = fake();
    const { token } = await createIntegrationToken(db, ctx, { system: "mediabuyer" });
    const row = (db as any)._stores.integrationToken[0];
    const days = (new Date(row.expiresAt).getTime() - Date.now()) / 86400000;
    expect(Math.round(days)).toBe(90);
    expect(await verifyIntegrationToken(db, token, new Date(Date.now() + 91 * 86400000))).toBeNull();
  });
});

describe("P12 settings — قيم آمنة دائمًا", () => {
  it("القيمة التالفة تسقط وحدها", () => {
    const s = resolveIntegrationSettings({ capacityUnansweredWarn: -5, attributionWindowDays: 3, junk: 1 });
    expect(s.capacityUnansweredWarn).toBe(DEFAULT_INTEGRATION_SETTINGS.capacityUnansweredWarn);
    expect(s.attributionWindowDays).toBe(3);
    expect((s as any).junk).toBeUndefined();
  });
  it("encryptSecret round-trip (حماية التبعية)", () => {
    expect(decryptSecret(encryptSecret("x"))).toBe("x");
  });
});
