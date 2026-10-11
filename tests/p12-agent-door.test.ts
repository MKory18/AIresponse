import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Db } from "@/modules/customers/service";
import { TOOLS, TOOL_BY_NAME, toolsForScopes, hermesExternalRef, type ToolDef } from "@/modules/agent-door/tools";
import { buildToolDirectory, callAgentTool, DoorError, sanitizeAgentRef } from "@/modules/agent-door/door";
import { decideAgentDraft } from "@/modules/agent-door/drafts";
import { parseAgentDate, resolvePeriod } from "@/modules/agent-door/period";
import { createIntegrationToken, verifyIntegrationToken, type TokenRow } from "@/modules/integrations/tokens";
import { findPii } from "@/modules/integrations/pii-guard";
import { setIntegrationDnsLookup } from "@/modules/integrations/connections";
import { ZAKI_SYSTEMS } from "@/modules/integrations/systems";
import { CHANNEL_KEYS } from "@/modules/integrations/format";

/**
 * P12 — باب الوكلاء (agent-door/v1) لنظام الردود — عقد Hermes حرفيًا:
 * الدليل حسب التوكن · مخططات حرفية (additionalProperties:false بكل كائن ·
 * بلا format · nullable بـ anyOf) · المخرجات مطابقة لمخططها المنشور ·
 * ولا بيانات شخصية · المسودة مسودة (Idempotency-Key · سقف يومي · تجربة) ·
 * الأخطاء بالرموز والـ HTTP من العقد · كل نداء بالسجل.
 */

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb } = await import("./helpers/inmemory-db");
  const db = createFakeDb();
  (globalThis as Record<string, unknown>).__doorDb = db;
  return { prisma: db };
});

type FakeDb = ReturnType<typeof import("./helpers/inmemory-db").createFakeDb>;
type Row = Record<string, any>;
const fdb = () => (globalThis as Record<string, unknown>).__doorDb as FakeDb;
const asDb = (d: FakeDb) => d as unknown as Db;

const WS = "ws-door-0001";
const OWNER = "user-owner-1";
const AGENT = "user-agent-1";
// الآن: 12:00 بتوقيت عمّان (09:00Z) — «مبارح» = 2026-10-10 بعمّان.
const NOW = new Date("2026-10-11T09:00:00.000Z");
const T = (iso: string) => new Date(iso);

beforeAll(() => setIntegrationDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]));
afterAll(() => setIntegrationDnsLookup(null));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const d = fdb();
  for (const k of Object.keys(d._stores)) (d._stores as Record<string, unknown[]>)[k].length = 0;
  d._stores.workspace.push({ id: WS, name: "Zaki", slug: "zaki", timezone: "Asia/Amman", slaFirstResponseMinutes: 15, integrationSettings: {} });
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.APP_URL;
});

// ─────────────────────────────── مساعدات ───────────────────────────────

/** مدقق JSON Schema مصغّر (النوع · الخصائص · المطلوب · الحرفية · المصفوفات · النمط · الحدود · anyOf). */
function validate(schema: Row, value: unknown, path = "$"): string[] {
  if (schema.anyOf) {
    return (schema.anyOf as Row[]).some((s) => validate(s, value, path).length === 0) ? [] : [`${path}: anyOf`];
  }
  const errs: string[] = [];
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}: not object`];
      const obj = value as Row;
      for (const k of (schema.required as string[]) ?? []) if (!(k in obj)) errs.push(`${path}.${k}: required`);
      for (const [k, v] of Object.entries(obj)) {
        const prop = (schema.properties as Row | undefined)?.[k];
        if (prop) errs.push(...validate(prop, v, `${path}.${k}`));
        else if (schema.additionalProperties === false) errs.push(`${path}.${k}: additional property`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errs.push(...validate(schema.additionalProperties, v, `${path}.${k}`));
      }
      return errs;
    }
    case "array": {
      if (!Array.isArray(value)) return [`${path}: not array`];
      if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: minItems`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: maxItems`);
      // items مصفوفة = tuple (draft-07): كل خانة بمخططها، والزيادة ممنوعة مع additionalItems:false.
      value.forEach((v, i) => {
        if (Array.isArray(schema.items)) {
          const item = (schema.items as Row[])[i];
          if (item) errs.push(...validate(item, v, `${path}[${i}]`));
          else if (schema.additionalItems === false) errs.push(`${path}[${i}]: additional item`);
        } else errs.push(...validate(schema.items, v, `${path}[${i}]`));
      });
      return errs;
    }
    case "string":
      if (typeof value !== "string") return [`${path}: not string`];
      if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: minLength`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}: maxLength`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern`);
      if (schema.enum && !(schema.enum as unknown[]).includes(value)) errs.push(`${path}: enum`);
      return errs;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return [`${path}: not number`];
      if (schema.type === "integer" && !Number.isInteger(value)) errs.push(`${path}: not integer`);
      if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: minimum`);
      if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: maximum`);
      return errs;
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path}: not boolean`];
    case "null":
      return value === null ? [] : [`${path}: not null`];
    default:
      return [`${path}: unknown schema type ${String(schema.type)}`];
  }
}

/** «حرفي» حسب قواعد سجل الجسر: كل كائن additionalProperties:false · بلا format · بلا نوع مركّب. */
function literalProblems(schema: Row, path = "$"): string[] {
  const out: string[] = [];
  if ("format" in schema) out.push(`${path}: format`);
  if (Array.isArray(schema.type)) out.push(`${path}: union type`);
  if (schema.anyOf) (schema.anyOf as Row[]).forEach((s, i) => out.push(...literalProblems(s, `${path}|${i}`)));
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) out.push(`${path}: additionalProperties not false`);
    const props = (schema.properties ?? {}) as Row;
    for (const r of (schema.required as string[]) ?? []) if (!(r in props)) out.push(`${path}: required ${r} not in properties`);
    for (const [k, v] of Object.entries(props)) out.push(...literalProblems(v as Row, `${path}.${k}`));
  }
  if (schema.type === "array") {
    if (Array.isArray(schema.items)) {
      // tuple: ajv الصارم بيطلب minItems = الطول و(maxItems = الطول أو additionalItems:false).
      const n = (schema.items as Row[]).length;
      if (schema.minItems !== n || (schema.maxItems !== n && schema.additionalItems !== false)) out.push(`${path}: loose tuple`);
      (schema.items as Row[]).forEach((it, i) => out.push(...literalProblems(it, `${path}[${i}]`)));
    } else out.push(...literalProblems(schema.items as Row, `${path}[]`));
  }
  return out;
}

async function token(system: "hermes-bridge" | "mediabuyer" | "clipper" = "hermes-bridge", scopes?: string[]): Promise<TokenRow> {
  const { token: raw } = await createIntegrationToken(asDb(fdb()), { userId: OWNER, workspaceId: WS }, { system, ...(scopes ? { scopes: scopes as never } : {}) });
  return (await verifyIntegrationToken(asDb(fdb()), raw))!;
}

let keyN = 0;
const idem = () => `hermes-zaki-${(++keyN).toString(16).padStart(16, "0")}-20261011`;

function call(tok: TokenRow, tool: string, input: unknown = {}, opts: { dry_run?: boolean; key?: string | null; agentRef?: string | null } = {}) {
  return callAgentTool(asDb(fdb()), {
    token: tok,
    body: { tool, input, ...(opts.dry_run !== undefined ? { dry_run: opts.dry_run } : {}) },
    requestId: "brg_test_1",
    agentRef: opts.agentRef ?? "hermes:zaki",
    idempotencyKey: opts.key ?? null,
    now: NOW,
  });
}

async function expectDoorError(p: Promise<unknown>, httpStatus: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(DoorError);
  expect(err).toMatchObject({ httpStatus, code });
  return err as DoorError;
}

/** عالم صغير بأرقام محسوبة يدويًا (التعليقات بتوقيت UTC). */
async function seedWorld() {
  const d = fdb();
  const wa = (await d.channel.create({ data: { workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "واتساب سوريا", externalId: "pn-1", market: "SY" } } as never)) as Row;
  const fb = (await d.channel.create({ data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة الأردن", externalId: "page-1", market: "JO" } } as never)) as Row;
  const cust = async (n: number) =>
    (await d.customer.create({ data: { workspaceId: WS, name: `زبون ${n}`, phone: `09366549${90 + n}`, marketingConsent: "UNKNOWN" } } as never)) as Row;
  const [c1, c2, c3, c4] = [await cust(1), await cust(2), await cust(3), await cust(4)];
  const conv = async (o: Row) =>
    (await d.conversation.create({ data: { workspaceId: WS, status: "OPEN", deletedAt: null, lastAgentMessageAt: null, ...o } } as never)) as Row;
  const msg = (o: Row) => d.message.create({ data: { workspaceId: WS, isNote: false, deletedAt: null, type: "TEXT", ...o } } as never);

  // conv1 (واتساب) مبارح 11:00 عمّان: زبون ← رد ذكاء بعد 5 دقايق.
  const conv1 = await conv({ channelId: wa.id, customerId: c1.id, channelConversationId: "cc1", createdAt: T("2026-10-10T08:00:00Z"), lastCustomerMessageAt: T("2026-10-10T08:00:00Z"), lastAgentMessageAt: T("2026-10-10T08:05:00Z"), assignedAgentId: AGENT });
  await msg({ conversationId: conv1.id, direction: "INBOUND", senderType: "CUSTOMER", text: "بدي اطلب، رقمي 0936654991", createdAt: T("2026-10-10T08:00:00Z") });
  await msg({ conversationId: conv1.id, direction: "OUTBOUND", senderType: "AI", text: "أهلين", createdAt: T("2026-10-10T08:05:00Z") });
  // conv2 (ماسنجر) مبارح 22:30 عمّان (بعد الدوام): رد موظف بعد 30 دقيقة (فوق المهلة).
  const conv2 = await conv({ channelId: fb.id, customerId: c2.id, channelConversationId: "cc2", createdAt: T("2026-10-10T19:30:00Z"), lastCustomerMessageAt: T("2026-10-10T19:30:00Z"), lastAgentMessageAt: T("2026-10-10T20:00:00Z") });
  await msg({ conversationId: conv2.id, direction: "INBOUND", senderType: "CUSTOMER", text: "كم السعر؟", createdAt: T("2026-10-10T19:30:00Z") });
  await msg({ conversationId: conv2.id, direction: "OUTBOUND", senderType: "HUMAN", senderId: AGENT, text: "15 دولار", createdAt: T("2026-10-10T20:00:00Z") });
  // conv3 (واتساب) اليوم: زبون بلا رد.
  const conv3 = await conv({ channelId: wa.id, customerId: c3.id, channelConversationId: "cc3", createdAt: T("2026-10-11T08:30:00Z"), lastCustomerMessageAt: T("2026-10-11T08:30:00Z") });
  await msg({ conversationId: conv3.id, direction: "INBOUND", senderType: "CUSTOMER", text: "مرحبا", createdAt: T("2026-10-11T08:30:00Z") });
  // conv4 (واتساب) اليوم: زبون ← رسالة حملة (مش رد) — بيضل منتظر.
  const conv4 = await conv({ channelId: wa.id, customerId: c4.id, channelConversationId: "cc4", createdAt: T("2026-10-11T08:40:00Z"), lastCustomerMessageAt: T("2026-10-11T08:40:00Z"), lastAgentMessageAt: T("2026-10-11T08:45:00Z") });
  await msg({ conversationId: conv4.id, direction: "INBOUND", senderType: "CUSTOMER", text: "عندكم توصيل؟", createdAt: T("2026-10-11T08:40:00Z") });
  await msg({ conversationId: conv4.id, direction: "OUTBOUND", senderType: "HUMAN", senderId: "campaign-system", text: "عرض", createdAt: T("2026-10-11T08:45:00Z") });

  const product = (await d.product.create({ data: { workspaceId: WS, name: "منتج الطنين", sku: "TIN01", isActive: true } } as never)) as Row;
  await d.orderDraft.create({ data: { workspaceId: WS, conversationId: conv1.id, customerId: c1.id, productId: product.id, state: "READY", createdAt: T("2026-10-10T08:10:00Z") } } as never);
  const order = (await d.order.create({
    data: { workspaceId: WS, orderNumber: "ORD-MG8K2J-X7Q", customerId: c1.id, conversationId: conv1.id, status: "CONFIRMED", confirmationStatus: "CONFIRMED_BY_CUSTOMER", omsOrderId: null, omsOrderNumber: null, createdAt: T("2026-10-10T08:20:00Z") },
  } as never)) as Row;
  await d.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 1 } } as never);
  for (const [intent, messageId, at] of [
    ["PRICE_QUESTION", "m-1", "2026-10-10T08:00:00Z"],
    ["PRICE_QUESTION", "m-1", "2026-10-10T08:00:01Z"], // نفس الرسالة (مرحلتين) = مرة وحدة
    ["PRICE_QUESTION", "m-2", "2026-10-10T19:30:00Z"],
    ["DELIVERY_QUESTION", "m-3", "2026-10-10T10:00:00Z"],
    ["DELIVERY_QUESTION", "m-4", "2026-10-11T08:40:00Z"], // اليوم — خارج «مبارح»
  ]) {
    await d.aIUsageLog.create({ data: { workspaceId: WS, intent, messageId, createdAt: T(at) } } as never);
  }
  await d.faq.create({ data: { workspaceId: WS, productId: product.id, question: "كيف بطلب؟", answer: "اتصل على 0936654998 أو راسلنا", category: "طلب", isActive: true, updatedAt: NOW } } as never);
  await d.faq.create({ data: { workspaceId: WS, productId: product.id, question: "قديم", answer: "قديم", isActive: false, updatedAt: NOW } } as never);
  await d.campaignContentVersion.create({ data: { workspaceId: WS, campaignId: "camp-old", version: 1, status: "APPROVED", templateName: "wa_tpl_offer_ar", templateLanguage: "ar" } } as never);
  return { wa, fb, c1, c2, c3, c4, conv1, conv2, conv3, conv4, product, order };
}

// ─────────────────────────────── العقد ───────────────────────────────

describe("P12 agent-door — الدليل والمخططات حرفيًا", () => {
  it("الأدوات = كتالوج الردود الثمانية + الثلاث القياسية بأسماء صالحة للجسر", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "draft_reply_template",
        "draft_retarget_campaign",
        "get_capacity_status",
        "get_draft_status",
        "get_inbox_summary",
        "get_sales_funnel",
        "get_status_summary",
        "get_team_performance",
        "get_top_questions",
        "list_owner_queue",
        "list_templates",
      ].sort()
    );
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z0-9_]{1,48}$/);
      expect(["read", "draft"]).toContain(t.risk);
      if (t.risk === "draft") expect(t.name.startsWith("draft_")).toBe(true);
      else expect(/^(get|list)_/.test(t.name)).toBe(true);
      expect(t.dry_run).toBe(t.risk === "draft");
      expect(t.title_ar.length).toBeGreaterThan(2);
      expect(t.description_ar.length).toBeGreaterThan(10);
      expect(t.rate_limit_per_min).toBeGreaterThan(0);
    }
  });

  it("كل مخطط مدخل ومخرج حرفي (additionalProperties:false بكل كائن · بلا format · بلا نوع مركّب)", () => {
    for (const t of TOOLS) {
      expect(literalProblems(t.input_schema), `${t.name} input`).toEqual([]);
      expect(literalProblems(t.output_schema), `${t.name} output`).toEqual([]);
    }
  });

  it("الدليل لتوكن hermes-bridge: العقد · النظام · النسخة · وقت بمنطقة · 11 أداة", async () => {
    const tok = await token();
    const dir = await buildToolDirectory(asDb(fdb()), tok, NOW);
    expect(dir).toMatchObject({ contract: "agent-door/v1", system: "replies", generated_at: "2026-10-11T12:00:00+03:00" });
    expect(dir.system_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dir.tools).toHaveLength(11);
    expect(Object.keys(dir.tools[0]).sort()).toEqual(
      ["description_ar", "dry_run", "input_schema", "name", "output_schema", "rate_limit_per_min", "risk", "title_ar", "untrusted_fields"].sort()
    );
    expect(dir.tools.find((t) => t.name === "list_templates")!.untrusted_fields).toEqual(["templates[].question", "templates[].answer"]);
  });

  it("توكن قراءة بس ما بيشوف أدوات المسودة أصلًا · توكن نظام تاني ما إله باب", async () => {
    const readOnly = await token("hermes-bridge", ["agent.read"]);
    const dir = await buildToolDirectory(asDb(fdb()), readOnly, NOW);
    expect(dir.tools).toHaveLength(9);
    expect(dir.tools.some((t) => t.risk === "draft")).toBe(false);
    expect(toolsForScopes(["agent.draft"]).every((t) => t.risk === "draft")).toBe(true);
    const mb = await token("mediabuyer");
    await expectDoorError(buildToolDirectory(asDb(fdb()), mb, NOW), 403, "RISK_NOT_ALLOWED");
  });

  it("زر الإيقاف بالإعدادات: الدليل والنداء بيرجعوا 401 بلا ما ينحذف التوكن", async () => {
    const tok = await token();
    fdb()._stores.workspace[0].integrationSettings = { agentDoorPaused: true };
    await expectDoorError(buildToolDirectory(asDb(fdb()), tok, NOW), 401, "UNAUTHORIZED");
    await expectDoorError(call(tok, "get_capacity_status"), 401, "UNAUTHORIZED");
    expect(fdb()._stores.integrationToken[0].revokedAt ?? null).toBeNull();
  });
});

// ─────────────────────────────── القراءة ───────────────────────────────

describe("P12 agent-door — أدوات القراءة بأرقام محسوبة ومخرجات مطابقة للمخطط", () => {
  it("كل أداة قراءة: الرد مطابق لمخططها المنشور حرفيًا · meta من العقد · بلا بيانات شخصية · بالسجل", async () => {
    await seedWorld();
    const tok = await token();
    for (const t of TOOLS.filter((x) => x.risk === "read")) {
      const res = await call(tok, t.name, {});
      expect(res.status, t.name).toBe("ok");
      expect(validate(t.output_schema, res.data), t.name).toEqual([]);
      expect(findPii(res.data), t.name).toEqual([]);
      expect(Object.keys(res.meta).sort()).toEqual(["as_of", "links", "period", "sample", "source", "stale", "system"]);
      expect(res.meta).toMatchObject({ system: "replies", source: "computed", as_of: "2026-10-11T12:00:00+03:00", stale: false });
      expect(res.request_id).toBe("brg_test_1");
      // ولا رقم هاتف ولا اسم زبون بأي مكان بالرد (حتى meta).
      const text = JSON.stringify(res);
      expect(text).not.toMatch(/09366549\d\d|زبون \d/);
    }
    const logs = fdb()._stores.agentCallLog;
    expect(logs).toHaveLength(9);
    expect(logs.every((l) => l.status === "ok" && l.agentRef === "hermes:zaki" && l.requestId === "brg_test_1")).toBe(true);
    expect(JSON.stringify(logs)).not.toMatch(/input|0936/); // السجل بلا مدخلات
  });

  it("get_inbox_summary مبارح: المحادثات · وسيط أول رد · فوق المهلة · بعد الدوام · المنتظر الآن (رسالة الحملة مش رد)", async () => {
    await seedWorld();
    const res = await call(await token(), "get_inbox_summary", { period: "yesterday" });
    expect(res.data).toEqual({
      period: { from: "2026-10-10T00:00:00+03:00", to: "2026-10-11T00:00:00+03:00", label: "yesterday" },
      conversations: 2,
      inbound_messages: 2,
      first_response_p50_min: 17.5,
      responses_measured: 2,
      over_sla: 1,
      sla_minutes: 15,
      unanswered_now: 2,
      after_hours_share: 0.5,
      by_channel: { whatsapp: 2, messenger: 0, instagram: 0, telegram: 0, tiktok: 0, web: 0 },
    });
    expect(res.meta.period).toEqual({ from: "2026-10-10T00:00:00+03:00", to: "2026-10-11T00:00:00+03:00", label: "yesterday" });
    expect(res.meta.sample).toBe(2);
  });

  it("get_inbox_summary بسوق: قنوات السوق بس · سوق بلا قنوات = خطأ واضح مش أصفار", async () => {
    await seedWorld();
    const tok = await token();
    const sy = await call(tok, "get_inbox_summary", { period: "yesterday", market: "SY" });
    expect(sy.data).toMatchObject({ conversations: 1, first_response_p50_min: 5, over_sla: 0, after_hours_share: 0, unanswered_now: 2 });
    const jo = await call(tok, "get_inbox_summary", { period: "yesterday", market: "JO" });
    expect(jo.data).toMatchObject({ conversations: 1, first_response_p50_min: 30, over_sla: 1, after_hours_share: 1, unanswered_now: 0 });
    for (const ch of fdb()._stores.channel) ch.market = null;
    const err = await expectDoorError(call(tok, "get_inbox_summary", { market: "SY" }), 422, "VALIDATION_FAILED");
    expect(err.details[0].path).toBe("market");
    await expectDoorError(call(tok, "get_inbox_summary", { market: "EG" }), 422, "VALIDATION_FAILED");
  });

  it("get_sales_funnel: الكل ولمنتج — ومنتج مش موجود = خطأ مش أصفار", async () => {
    await seedWorld();
    const tok = await token();
    const all = await call(tok, "get_sales_funnel", { period: "yesterday" });
    expect(all.data).toMatchObject({
      product_code: null,
      conversations: 2,
      drafts_started: 1,
      drafts_ready: 1,
      orders_confirmed: 1,
      orders_delivered: 0,
      rates: { draft_start: 0.5, ready: 1, confirm: 1, delivery: 0 },
    });
    const one = await call(tok, "get_sales_funnel", { period: "yesterday", product_code: "TIN01" });
    expect(one.data).toMatchObject({ product_code: "TIN01", conversations: 1, orders_confirmed: 1, rates: { draft_start: 1 } });
    await expectDoorError(call(tok, "get_sales_funnel", { product_code: "NOPE" }), 422, "VALIDATION_FAILED");
  });

  it("get_capacity_status: بكل القنوات بمفاتيح ثابتة · المستوى حسب الإعدادات", async () => {
    await seedWorld();
    fdb()._stores.workspace[0].integrationSettings = { capacityUnansweredWarn: 2, capacityP50WarnMin: 60 };
    const res = await call(await token(), "get_capacity_status");
    expect(res.data).toMatchObject({ unanswered: 2, level: "warning", threshold_unanswered: 2, threshold_p50_min: 60, at: "2026-10-11T12:00:00+03:00" });
    expect(Object.keys((res.data as Row).by_channel)).toEqual([...CHANNEL_KEYS]);
  });

  it("get_top_questions: من تصنيف المحرك · الرسالة الوحدة تنعد مرة · بلا نص زبون", async () => {
    await seedWorld();
    const res = await call(await token(), "get_top_questions", { period: "yesterday" });
    expect(res.data).toMatchObject({
      total: 3,
      topics: [
        { intent: "PRICE_QUESTION", label_ar: "السعر", count: 2, share: 0.667 },
        { intent: "DELIVERY_QUESTION", label_ar: "التوصيل", count: 1, share: 0.333 },
      ],
    });
  });

  it("get_team_performance: مرجع حروف بلا اسم · رسائل الحملة مش موظف", async () => {
    await seedWorld();
    const res = await call(await token(), "get_team_performance", { period: "yesterday" });
    const agents = (res.data as Row).agents as Row[];
    expect(agents).toHaveLength(1);
    expect(agents[0].agent_ref).toMatch(/^agt_[a-p]{10}$/);
    expect(agents[0]).toMatchObject({ conversations_assigned: 1, replies_sent: 1 });
    expect(Object.keys(agents[0])).not.toContain("name");
  });

  it("list_templates: المعتمد بس · أرقام الهواتف داخل النص بتنستبدل […] · قوالب واتساب", async () => {
    await seedWorld();
    const res = await call(await token(), "list_templates", { product_code: "TIN01" });
    const data = res.data as Row;
    expect(data.templates).toHaveLength(1);
    expect(data.templates[0]).toMatchObject({ product_code: "TIN01", topic: "طلب", question: "كيف بطلب؟", answer: "اتصل على […] أو راسلنا" });
    expect(data.whatsapp_templates).toEqual([{ template_name: "wa_tpl_offer_ar", language: "ar" }]);
  });

  it("مدخلات الفترة: يوم صافٍ = منتصف ليل عمّان و«to» شامل · بلا منطقة = وقت جداري بعمّان", () => {
    expect(parseAgentDate("2026-10-01", "Asia/Amman").toISOString()).toBe("2026-09-30T21:00:00.000Z");
    expect(parseAgentDate("2026-10-01", "Asia/Amman", true).toISOString()).toBe("2026-10-01T21:00:00.000Z");
    expect(parseAgentDate("2026-10-01T10:00", "Asia/Amman").toISOString()).toBe("2026-10-01T07:00:00.000Z");
    expect(parseAgentDate("2026-10-01T10:00:00Z", "Asia/Amman").toISOString()).toBe("2026-10-01T10:00:00.000Z");
    const p = resolvePeriod({ from: "2026-10-01", to: "2026-10-07" }, "Asia/Amman", NOW);
    expect([p.start.toISOString(), p.end.toISOString(), p.label]).toEqual(["2026-09-30T21:00:00.000Z", "2026-10-07T21:00:00.000Z", "custom"]);
    const lw = resolvePeriod({ period: "last_week" }, "Asia/Amman", NOW);
    expect(lw.end.getTime() - lw.start.getTime()).toBe(7 * 24 * 3600_000);
  });

  it("from بلا to · فترة معكوسة · أطول من 92 يوم · حقل زيادة = VALIDATION_FAILED بتفاصيل", async () => {
    const tok = await token();
    await expectDoorError(call(tok, "get_inbox_summary", { from: "2026-10-01" }), 422, "VALIDATION_FAILED");
    await expectDoorError(call(tok, "get_inbox_summary", { from: "2026-10-05", to: "2026-10-01" }), 422, "VALIDATION_FAILED");
    await expectDoorError(call(tok, "get_inbox_summary", { from: "2026-01-01", to: "2026-10-01" }), 422, "VALIDATION_FAILED");
    const extra = await expectDoorError(call(tok, "get_capacity_status", { market: "SY" }), 422, "VALIDATION_FAILED");
    expect(extra.details.length).toBeGreaterThan(0);
    await expectDoorError(call(tok, "get_inbox_summary", { from: "yesterday", to: "today" }), 422, "VALIDATION_FAILED");
  });
});

// ─────────────────────────────── المسودات ───────────────────────────────

describe("P12 agent-door — المسودة مسودة", () => {
  const template = { topic: "التوصيل", question: "قديش بياخد التوصيل؟", answer: "التوصيل من يوم لتلات أيام حسب المحافظة.", product_code: "TIN01", dialect: "syrian" };

  it("dry_run: نتيجة الفحوص بلا أي إنشاء ولا مفتاح", async () => {
    await seedWorld();
    const tok = await token();
    const res = await call(tok, "draft_reply_template", template, { dry_run: true });
    expect(res.status).toBe("dry_run");
    expect(res.data).toMatchObject({ draft_id: null, review_url: null, expires_at: null, kind: "reply_template" });
    expect((res.data as Row).checks.find((c: Row) => c.code === "SAFE_TEXT")).toMatchObject({ ok: true });
    expect(res.meta.source).toBe("model");
    expect(fdb()._stores.agentDraft).toHaveLength(0);
    const bad = await call(tok, "draft_reply_template", { ...template, answer: "اتصل على 0936654998" }, { dry_run: true });
    expect((bad.data as Row).checks.find((c: Row) => c.code === "PII_BLOCKED")).toMatchObject({ ok: false });
    expect(fdb()._stores.agentDraft).toHaveLength(0);
  });

  it("الإنشاء بدون Idempotency-Key مرفوض · بالمفتاح مسودة PENDING مصدرها Hermes · إعادة النداء = نفس المسودة", async () => {
    await seedWorld();
    process.env.APP_URL = "https://replies.zakai.io";
    const tok = await token();
    const noKey = await expectDoorError(call(tok, "draft_reply_template", template), 422, "VALIDATION_FAILED");
    expect(noKey.details[0].path).toBe("Idempotency-Key");
    await expectDoorError(call(tok, "draft_reply_template", template, { key: "short" }), 422, "VALIDATION_FAILED");

    const key = idem();
    const res = await call(tok, "draft_reply_template", template, { key });
    expect(res.status).toBe("draft_created");
    const data = res.data as Row;
    expect(data.draft_id).toBeTruthy();
    expect(data.review_url).toBe(`https://replies.zakai.io/settings/agents?draft=${data.draft_id}`);
    expect(data.expires_at).toBe("2026-10-18T12:00:00+03:00");
    const row = fdb()._stores.agentDraft[0];
    expect(row).toMatchObject({ source: "hermes", kind: "reply_template", status: "PENDING", tokenId: tok.id, idempotencyKey: key });

    const again = await call(tok, "draft_reply_template", template, { key });
    expect(again.status).toBe("draft_created");
    expect((again.data as Row).draft_id).toBe(data.draft_id);
    expect(fdb()._stores.agentDraft).toHaveLength(1);
    expect(fdb()._stores.agentCallLog.map((l) => l.status)).toContain("draft_replayed");
    // نفس المفتاح لأداة مسودة تانية = رفض (مش خلط مسودات).
    await expectDoorError(
      call(tok, "draft_retarget_campaign", { segment: { kind: "messaged_no_order" }, template_ref: "wa_tpl_offer_ar" }, { key }),
      422,
      "VALIDATION_FAILED"
    );
  });

  it("نص فيه رقم هاتف أو ادعاء ممنوع من سيستم 1 = VALIDATION_FAILED (بلا مسودة)", async () => {
    const w = await seedWorld();
    const tok = await token();
    await expectDoorError(call(tok, "draft_reply_template", { ...template, answer: "كلمنا ع ٠٩٣٦٦٥٤٩٩٨" }, { key: idem() }), 422, "VALIDATION_FAILED");
    await fdb().productCompliance.create({
      data: { workspaceId: WS, productId: w.product.id, s1ProductRef: "pf_1", allowedClaims: [], bannedClaims: ["يشفي نهائيا"], verdict: "pass", fetchedAt: NOW },
    } as never);
    const err = await expectDoorError(call(tok, "draft_reply_template", { ...template, answer: "هالمنتج بيشفي نهائياً من الطنين" }, { key: idem() }), 422, "VALIDATION_FAILED");
    expect(err.message).toContain("ادعاء ممنوع");
    expect(fdb()._stores.agentDraft).toHaveLength(0);
  });

  it("سقف المسودات اليومي (بيوم عمّان) = 429 DRAFT_CAP_REACHED · إعادة نداء مسودة قائمة ما بتنعد", async () => {
    await seedWorld();
    const tok = await token();
    fdb()._stores.integrationToken[0].dailyDraftCap = 2;
    tok.dailyDraftCap = 2;
    const k1 = idem();
    await call(tok, "draft_reply_template", { ...template, topic: "أ" + "ب" }, { key: k1 });
    await call(tok, "draft_reply_template", { ...template, topic: "جد" }, { key: idem() });
    await expectDoorError(call(tok, "draft_reply_template", { ...template, topic: "هو" }, { key: idem() }), 429, "DRAFT_CAP_REACHED");
    expect((await call(tok, "draft_reply_template", { ...template, topic: "أب" }, { key: k1 })).status).toBe("draft_created");
    // مسودة من مبارح (قبل منتصف ليل عمّان) ما بتنعد على اليوم.
    fdb()._stores.agentDraft[0].createdAt = T("2026-10-10T20:00:00Z");
    expect((await call(tok, "draft_reply_template", { ...template, topic: "وز" }, { key: idem() })).status).toBe("draft_created");
  });

  it("draft_retarget_campaign: الموافقين بس · تجربة بعدد المؤهلين · بلا مؤهلين ما في مسودة · الاعتماد بيعمل حملة جاهزة بلا إرسال", async () => {
    const w = await seedWorld();
    const tok = await token();
    const input = { segment: { kind: "cancelled_before_shipping", days: [1, 7] }, template_ref: "wa_tpl_offer_ar", frequency_cap_days: 7, offer: "خصم 10% لأول 50" };
    const none = await call(tok, "draft_retarget_campaign", input, { dry_run: true });
    expect(none.data).toMatchObject({ eligible_count: 0, draft_id: null });
    expect((none.data as Row).checks.find((c: Row) => c.code === "AUDIENCE")).toMatchObject({ ok: false });
    await expectDoorError(call(tok, "draft_retarget_campaign", input, { key: idem() }), 422, "VALIDATION_FAILED");

    // زبون موافق بطلب ملغى من 3 أيام وهوية واتساب، وزبون مش موافق بنفس الحالة.
    const d = fdb();
    for (const [cust, consent] of [
      [w.c1, "OPTED_IN"],
      [w.c2, "UNKNOWN"],
    ] as Array<[Row, string]>) {
      const row = d._stores.customer.find((c) => c.id === cust.id)!;
      row.marketingConsent = consent;
      await d.order.create({ data: { workspaceId: WS, orderNumber: `ORD-C-${cust.id.slice(-4)}`, customerId: cust.id, status: "CANCELLED", updatedAt: T("2026-10-08T09:00:00Z"), createdAt: T("2026-10-07T09:00:00Z") } } as never);
      await d.channelIdentity.create({ data: { workspaceId: WS, customerId: cust.id, channelType: "WHATSAPP", channelExternalId: `wa-${cust.id}` } } as never);
    }
    const dry = await call(tok, "draft_retarget_campaign", input, { dry_run: true });
    expect((dry.data as Row).eligible_count).toBe(1);
    expect((dry.data as Row).checks.map((c: Row) => c.code)).toEqual(["CHANNEL_CONNECTED", "OPT_IN_ONLY", "FREQUENCY_CAP", "AUDIENCE", "TEMPLATE_KNOWN"]);
    expect(d._stores.campaign).toHaveLength(0);

    const key = idem();
    const res = await call(tok, "draft_retarget_campaign", input, { key });
    expect(res.status).toBe("draft_created");
    expect((res.data as Row).eligible_count).toBe(1);
    expect(d._stores.campaign).toHaveLength(0); // المسودة ما بتعمل حملة
    const draft = d._stores.agentDraft[0];
    expect(draft.payload.spec).toMatchObject({ externalRef: hermesExternalRef(key), channel: "whatsapp", templateRef: "wa_tpl_offer_ar", frequencyCapDays: 7, approvedBy: "hermes" });

    const can = (p: string) => p === "campaigns.write";
    const view = await decideAgentDraft(asDb(d), { userId: OWNER, workspaceId: WS, can: can as never }, draft.id, { decision: "approve" });
    expect(view.status).toBe("APPROVED");
    const campaign = d._stores.campaign[0];
    expect(campaign).toMatchObject({ status: "READY", externalSystem: "hermes", externalRef: hermesExternalRef(key) });
    expect(campaign.approvedAt ?? null).toBeNull(); // اعتماد المسودة ≠ اعتماد الإرسال
    expect(d._stores.message.filter((m) => m.senderId === "campaign-system" && m.createdAt > NOW)).toHaveLength(0);
    await expect(decideAgentDraft(asDb(d), { userId: OWNER, workspaceId: WS, can: can as never }, draft.id, { decision: "reject" })).rejects.toMatchObject({ code: "DRAFT_ALREADY_DECIDED" });
  });

  it("اعتماد قالب الرد (مع تعديل) = سؤال شائع فعّال موسوم hermes · الرفض بلا أثر · الصلاحية حسب النوع", async () => {
    await seedWorld();
    const tok = await token();
    await call(tok, "draft_reply_template", template, { key: idem() });
    const d = fdb();
    const draft = d._stores.agentDraft[0];
    const noPerm = () => false;
    await expect(decideAgentDraft(asDb(d), { userId: OWNER, workspaceId: WS, can: noPerm as never }, draft.id, { decision: "approve" })).rejects.toThrow();
    const faqsBefore = d._stores.faq.length;
    const view = await decideAgentDraft(asDb(d), { userId: OWNER, workspaceId: WS, can: ((p: string) => p === "knowledge.write") as never }, draft.id, {
      decision: "approve",
      edits: { answer: "التوصيل من يوم ليومين." },
    });
    expect(view.status).toBe("EDITED");
    const faq = d._stores.faq[faqsBefore];
    expect(faq).toMatchObject({ answer: "التوصيل من يوم ليومين.", isActive: true, category: "التوصيل" });
    expect(faq.tags).toContain("hermes");

    const status = await call(tok, "get_draft_status", { draft_id: draft.id });
    expect((status.data as Row).drafts[0]).toMatchObject({ draft_id: draft.id, status: "edited" });
    expect((status.data as Row).drafts[0].decided_at).toMatch(/\+03:00$/);
  });

  it("المسودة بتنتهي بعد 7 أيام بلا قرار (expired) · get_draft_status بيرجّع مسودات هالتوكن بس", async () => {
    await seedWorld();
    const tok = await token();
    const other = await token();
    await call(tok, "draft_reply_template", template, { key: idem() });
    await call(other, "draft_reply_template", { ...template, topic: "تاني" }, { key: idem() });
    vi.setSystemTime(new Date(NOW.getTime() + 8 * 24 * 3600_000));
    const later = (input: Row) =>
      callAgentTool(asDb(fdb()), { token: tok, body: { tool: "get_draft_status", input }, requestId: "r", agentRef: null, idempotencyKey: null, now: new Date() });
    // الافتراضي آخر 7 أيام (مثل hub_draft_status) — المسودة عمرها 8.
    expect(((await later({})).data as Row).drafts).toHaveLength(0);
    const drafts = ((await later({ days: 30 })).data as Row).drafts as Row[];
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("expired");
    expect(fdb()._stores.agentDraft.filter((d) => d.status === "EXPIRED")).toHaveLength(2);
  });
});

// ─────────────────────────────── الطوابير والحالة ───────────────────────────────

describe("P12 agent-door — الحالة وطابور المالك", () => {
  it("get_status_summary: عدّادات بمصدرها · last_sync بكل الأنظمة · تحذير الوضع اليدوي وقناة بخطأ", async () => {
    const w = await seedWorld();
    const d = fdb();
    d._stores.omsConnection.push({ id: "oc1", workspaceId: WS, baseUrl: "https://oms.zakai.io", mode: "manual", isActive: true, lastWebhookAt: T("2026-10-11T08:00:00Z") });
    d._stores.channel.find((c) => c.id === w.fb.id)!.status = "ERROR";
    const res = await call(await token(), "get_status_summary");
    const data = res.data as Row;
    expect(Object.keys(data.last_sync).sort()).toEqual([...ZAKI_SYSTEMS].sort());
    expect(data.last_sync.oms).toBe("2026-10-11T11:00:00+03:00");
    expect(data.counters.map((c: Row) => c.key)).toEqual([
      "conversations_yesterday",
      "first_response_p50_24h",
      "unanswered_now",
      "over_sla_yesterday",
      "conversion_yesterday",
      "capacity_level",
    ]);
    expect(data.counters.every((c: Row) => c.source === "computed" && c.as_of === "2026-10-11T12:00:00+03:00")).toBe(true);
    expect(data.counters.find((c: Row) => c.key === "conversion_yesterday").value).toBe("50.0");
    expect(data.warnings_ar.some((w2: string) => w2.includes("وضع يدوي") && w2.includes("1 طلب"))).toBe(true);
    expect(data.warnings_ar.some((w2: string) => w2.includes("messenger"))).toBe(true);
    expect(data.healthy).toBe(false);
  });

  it("list_owner_queue: مسودات بروابطها · طلبات للنسخ للـ OMS · الأقدم أول · limit", async () => {
    await seedWorld();
    const d = fdb();
    d._stores.omsConnection.push({ id: "oc1", workspaceId: WS, baseUrl: "https://oms.zakai.io", mode: "manual", isActive: true });
    const tok = await token();
    const created = await call(tok, "draft_reply_template", { topic: "الدفع", question: "بتقبلوا دفع عند الاستلام؟", answer: "أكيد، الدفع عند الاستلام." }, { key: idem() });
    const res = await call(tok, "list_owner_queue", {});
    const items = (res.data as Row).items as Row[];
    expect(items.map((i) => i.type).sort()).toEqual(["draft.reply_template", "oms.manual_handoff"]);
    expect(items[0].type).toBe("oms.manual_handoff"); // أقدم (الطلب من مبارح)
    expect(items.find((i) => i.type === "draft.reply_template")!.url).toContain(`?draft=${(created.data as Row).draft_id}`);
    expect(((await call(tok, "list_owner_queue", { limit: 1 })).data as Row).items).toHaveLength(1);
    expect(((await call(tok, "list_owner_queue", { limit: 1 })).data as Row).total).toBe(2);
  });
});

// ─────────────────────────────── الأخطاء والحماية ───────────────────────────────

describe("P12 agent-door — الأخطاء بالعقد والأسوار", () => {
  it("أداة مش موجودة 404 · درجة مش مسموحة 403 · شكل نداء غلط 422 — وكلها بالسجل برمزها", async () => {
    const readOnly = await token("hermes-bridge", ["agent.read"]);
    await expectDoorError(call(readOnly, "finance_draft_entry"), 404, "TOOL_NOT_FOUND");
    await expectDoorError(call(readOnly, "draft_reply_template", {}, { key: idem() }), 403, "RISK_NOT_ALLOWED");
    await expectDoorError(
      callAgentTool(asDb(fdb()), { token: readOnly, body: { input: {} }, requestId: "r", agentRef: null, idempotencyKey: null, now: NOW }),
      422,
      "VALIDATION_FAILED"
    );
    const codes = fdb()._stores.agentCallLog.map((l) => l.errorCode);
    expect(codes).toEqual(["TOOL_NOT_FOUND", "RISK_NOT_ALLOWED", "VALIDATION_FAILED"]);
    expect(fdb()._stores.agentCallLog.every((l) => l.status === "error")).toBe(true);
  });

  it("رد أداة طلع عن مخططه أو فيه رقم هاتف = 500 بلا بيانات (ولا شي بيطلع)", async () => {
    const tok = await token();
    const tool = TOOL_BY_NAME.get("get_capacity_status") as ToolDef;
    const original = tool.run;
    try {
      tool.run = async () => ({ status: "ok", data: { unanswered: 1, extra: "x" } });
      await expectDoorError(call(tok, "get_capacity_status"), 500, "INTERNAL");
      tool.run = async () => ({
        status: "ok",
        data: { unanswered: 1, first_response_p50_min: null, by_channel: { whatsapp: 1, messenger: 0, instagram: 0, telegram: 0, tiktok: 0, web: 0 }, level: "ok", threshold_unanswered: 30, threshold_p50_min: 15, at: "اتصل 0936654998" },
      });
      const err = await expectDoorError(call(tok, "get_capacity_status"), 500, "INTERNAL");
      expect(JSON.stringify(err)).not.toContain("0936654998");
    } finally {
      tool.run = original;
    }
  });

  it("X-Agent-Ref مضبوط بس · مرجع حملة Hermes ثابت من المفتاح", () => {
    expect(sanitizeAgentRef("hermes:zaki")).toBe("hermes:zaki");
    expect(sanitizeAgentRef("Hermes:Zaki")).toBe("hermes:zaki");
    expect(sanitizeAgentRef("x y")).toBeNull();
    expect(sanitizeAgentRef("a:b:c")).toBeNull();
    expect(hermesExternalRef("k1")).toBe(hermesExternalRef("k1"));
    expect(hermesExternalRef("k1")).toMatch(/^hrm_[a-f0-9]{20}$/);
    expect(hermesExternalRef("k1")).not.toBe(hermesExternalRef("k2"));
  });
});

// ─────────────────────────────── المسارات ───────────────────────────────

describe("P12 agent-door — المسارات /api/agent/tools و /api/agent/call", () => {
  async function routes() {
    const tools = await import("@/app/api/agent/tools/route");
    const callRoute = await import("@/app/api/agent/call/route");
    return { GET: tools.GET, POST: callRoute.POST };
  }
  const req = (path: string, method: string, headers: Record<string, string>, body?: string) =>
    new NextRequest(`http://localhost${path}`, { method, headers: { "content-type": "application/json", ...headers }, body });

  it("بلا توكن أو بتوكن غلط = 401 بشكل خطأ العقد و X-Request-Id راجع", async () => {
    const { GET, POST } = await routes();
    const r1 = await GET(req("/api/agent/tools", "GET", { "x-request-id": "brg_01JA7Q3M8T" }));
    expect(r1.status).toBe(401);
    expect(r1.headers.get("x-request-id")).toBe("brg_01JA7Q3M8T");
    expect(await r1.json()).toEqual({ status: "error", error: { code: "UNAUTHORIZED", message: expect.any(String), details: [] }, request_id: "brg_01JA7Q3M8T" });
    const r2 = await POST(req("/api/agent/call", "POST", { authorization: "Bearer zr_hrm_notarealtokenatall_000000" }, JSON.stringify({ tool: "get_capacity_status", input: {} })));
    expect(r2.status).toBe(401);
    expect(r2.headers.get("x-request-id")).toMatch(/^rep_[a-f0-9]{16}$/);
  });

  it("الدليل والنداء بالتوكن: الرد حرفي بالعقد · Idempotency-Key من الرأس · JSON غلط أو جسم كبير = 422", async () => {
    await seedWorld();
    const { token: raw } = await createIntegrationToken(asDb(fdb()), { userId: OWNER, workspaceId: WS }, { system: "hermes-bridge" });
    const auth = { authorization: `Bearer ${raw}`, "x-agent-ref": "hermes:zaki", "x-request-id": "brg_1" };
    const { GET, POST } = await routes();
    const dir = await GET(req("/api/agent/tools", "GET", auth));
    expect(dir.status).toBe(200);
    expect((await dir.json()).tools).toHaveLength(11);

    const ok = await POST(req("/api/agent/call", "POST", auth, JSON.stringify({ tool: "get_capacity_status", input: {}, dry_run: false })));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(Object.keys(body).sort()).toEqual(["data", "meta", "request_id", "status"]);
    expect(body).toMatchObject({ status: "ok", request_id: "brg_1", meta: { system: "replies" } });

    const draft = await POST(
      req("/api/agent/call", "POST", { ...auth, "idempotency-key": "hermes-zaki-3f9a1c2e7b5d4a60-20261011" }, JSON.stringify({ tool: "draft_reply_template", input: { topic: "الدفع", question: "بتقبلوا كاش؟", answer: "أكيد عند الاستلام." } }))
    );
    expect(draft.status).toBe(200);
    expect((await draft.json()).status).toBe("draft_created");
    expect(fdb()._stores.agentDraft[0].idempotencyKey).toBe("hermes-zaki-3f9a1c2e7b5d4a60-20261011");

    const badJson = await POST(req("/api/agent/call", "POST", auth, "{not json"));
    expect(badJson.status).toBe(422);
    expect((await badJson.json()).error.code).toBe("VALIDATION_FAILED");
    const big = await POST(req("/api/agent/call", "POST", auth, JSON.stringify({ tool: "get_capacity_status", input: { x: "a".repeat(40_000) } })));
    expect(big.status).toBe(422);
    const missing = await POST(req("/api/agent/call", "POST", auth, JSON.stringify({ tool: "nope_tool", input: {} })));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("TOOL_NOT_FOUND");
  });

  it("توكن موقوف = 401 فورًا (زر الإيقاف)", async () => {
    const { token: raw, view } = await createIntegrationToken(asDb(fdb()), { userId: OWNER, workspaceId: WS }, { system: "hermes-bridge" });
    fdb()._stores.integrationToken.find((t) => t.id === view.id)!.revokedAt = NOW;
    const { POST } = await routes();
    const res = await POST(req("/api/agent/call", "POST", { authorization: `Bearer ${raw}` }, JSON.stringify({ tool: "get_capacity_status", input: {} })));
    expect(res.status).toBe(401);
  });
});
