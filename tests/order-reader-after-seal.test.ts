/**
 * الحزمة 1.6 — بعد التثبيت (02-ORDER-FLOW §10 · §16: 9 (كامل) · 12 · 13 · 14).
 *
 * التثبيت هو لحظة الخروج الوحيدة: الـ OMS وتيليجرام ورسالة التثبيت بيصيروا عند `seal` بس —
 * طلب مثبّت بيوصل الـ OMS مرة وحدة بالضبط، وطلب مش مثبّت ما بيوصل أبدًا. التعديل/الإلغاء بعد التثبيت
 * بمسار §10.3 (محلي إذا ما انبعت · ملاحظة للـ OMS + بند «يحتاجك» إذا انبعت).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { AIProvider, StructuredRequest } from "@/modules/ai/provider";
import { createFakeDb } from "./helpers/inmemory-db";
import { processIncomingMessage } from "@/modules/conversations/service";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";
import { createProduct } from "@/modules/products/service";
import { handleReadConversationJob } from "@/modules/orders/reader/service";
import { orderReadingSchema } from "@/modules/orders/reader/schema";
import { sealDueOrders } from "@/modules/orders/settle";
import { sealOrder } from "@/modules/orders/reader/actions";
import { handleSendOrderConfirmation, buildConfirmationText } from "@/modules/orders/reader/confirm";
import { resolveChangeRequest, describeDiff, isChatEditable, OMS_AUTO_AMEND } from "@/modules/orders/reader/amend";
import { OmsClient, setOmsClientFactory } from "@/modules/oms/client";
import { saveOmsConnection } from "@/modules/oms/connection";
import { handleAutoHandoffJob } from "@/modules/oms/auto-handoff";
import { sweepOrdersMissingOms } from "@/modules/orders/delivery-sweep";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;
const WS = "ws1";
const ACTOR = { userId: "staff-1", workspaceId: WS };
const OMS_URL = "https://oms.example.com";

let db: FakeDb;
let conversationId: string;
let customerId: string;
let omsCalls: Array<{ method: string; path: string; body: any }>;
let lookupAnswer: () => Response;
let noteAnswer: () => Response;

type Over = { phone?: string; relation?: "NEW" | "AMEND_LAST"; cancel?: boolean; needsHuman?: boolean; evidence?: string[]; agreement?: "EXPLICIT" | "NONE" };
function provider(over: () => Over = () => ({})): AIProvider {
  return {
    name: "fake",
    delivery: "local",
    async generateText() {
      throw new Error("no");
    },
    async generateStructured<T>(req: StructuredRequest<T>) {
      const o = over();
      const out = orderReadingSchema.parse({
        intent: o.cancel ? "CANCELLED" : "ORDERING",
        relation: o.relation ?? "NEW",
        items: [{ productRef: "ماء الكمأ", quantity: 2, evidence: ["m2"] }],
        customer: { name: null, phone: o.phone ?? "0964123348", altPhone: null, city: "درعا", address: "شارع (أ)", evidence: { phone: o.evidence ?? ["m2"], address: ["m2"] } },
        agreement: { state: o.agreement ?? "EXPLICIT", evidence: ["m2"] },
        cancelRequested: o.cancel === true,
        notes: null,
        openQuestions: [],
        aiClaimedConfirmed: false,
        needsHuman: { value: o.needsHuman === true, reason: o.needsHuman ? "COMPLAINT" : null },
        memories: [],
        confidence: 0.9,
      });
      const v = req.validate(out);
      if (!v.ok) throw new Error(`invalid: ${v.error}`);
      return { value: v.value, text: "{}", promptTokens: 1, completionTokens: 1, latencyMs: 1 };
    },
  };
}

let n = 0;
async function say(text: string) {
  n += 1;
  return processIncomingMessage(db as never, {
    workspaceId: WS,
    channelType: "FACEBOOK",
    channelId: "ch1",
    externalUserId: "psid-A",
    externalUserName: "أحمد",
    externalConversationId: "psid-A",
    externalMessageId: `mid-${n}`,
    externalEventId: `evt-${n}`,
    provider: "facebook",
    type: "TEXT",
    text,
  });
}

const setSettings = (extra: Record<string, unknown> = {}) =>
  db.workspace.update({ where: { id: WS }, data: { integrationSettings: { orderMode: "READER", ...extra } } } as never);
const read = (messageId: string, p: AIProvider, now = new Date(Date.now() + 120_000)) =>
  handleReadConversationJob(db as Db, { conversationId, throughMessageId: messageId }, WS, { provider: p, now: () => now });
const orders = () => (db._stores.order as any[]).filter((o) => o.conversationId === conversationId);
const revs = (orderId: string) => (db._stores.orderRevision as any[]).filter((r) => r.orderId === orderId).sort((a, b) => a.version - b.version);
const jobs = (type: string) => (db._stores.backgroundJob as any[]).filter((j) => j.type === type);
const outbound = () => (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND" && !m.isNote);
const notes = () => (db._stores.message as any[]).filter((m) => m.isNote);
const FUTURE = () => new Date(Date.now() + 3 * 3600_000);

function fakeOms() {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    omsCalls.push({ method: init?.method ?? "GET", path: u.pathname + u.search, body });
    if (u.pathname === "/api/v1/customers/lookup") return lookupAnswer();
    if (u.pathname === "/api/v1/orders" && init?.method === "POST")
      return Response.json({ order_id: "oms-ord-1", order_number: "SY-2026-0148", status: "NEW", totals: { total: 30, currency: "USD" } });
    if (/^\/api\/v1\/orders\/[^/]+\/notes$/.test(u.pathname)) return noteAnswer();
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  }) as typeof fetch;
  setOmsClientFactory((deps) => new OmsClient({ ...deps, fetchImpl, maxGetAttempts: 1, timeoutMs: 2000 }));
}
async function connectOms() {
  await saveOmsConnection(db as unknown as Db, ACTOR, { baseUrl: OMS_URL, token: "zk1_test_token_value", autoHandoff: true });
}

/** محادثة كاملة ← قراءة ← طلب NEW. */
async function readyOrder(over?: () => Over) {
  const m1 = await say("بدي ماء الكمأ");
  await say("2 حبة 0964123348 درعا شارع (أ) أكيد ثبّتوا");
  conversationId = m1.conversationId;
  customerId = m1.customerId;
  const last = (db._stores.message as any[]).filter((m) => m.conversationId === conversationId && m.senderType === "CUSTOMER").sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
  await read(last.id, provider(over));
  return orders()[0];
}

beforeEach(async () => {
  db = createFakeDb() as FakeDb;
  omsCalls = [];
  lookupAnswer = () => Response.json({ found: false, blacklisted: false });
  noteAnswer = () => Response.json({ ok: true });
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string) => {
          if (new URL(url).pathname.includes("/messages")) return Response.json({ recipient_id: "psid", message_id: `mid-out-${Math.random()}` });
          return Response.json({ id: "p", name: "p" });
        }) as typeof fetch,
      })
  );
  db._stores.channel.push({ id: "ch1", workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", sendMode: "AUTO_REPLY", externalId: "page-1", market: "SY", name: "كهربا" });
  db._stores.channelAccount.push({ id: "cacc-1", channelId: "ch1", provider: "FACEBOOK", externalAccountId: "page-1", pageName: "صفحة", encryptedCredentials: encryptSecret("tok") });
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
  await createProduct(db as never, { userId: "u1", workspaceId: WS }, { name: "ماء الكمأ", sku: "TW-500", price: 15, currency: "USD" });
  await setSettings();
  fakeOms();
});

afterEach(() => {
  setOmsClientFactory(null);
  setFacebookClientFactory(undefined as never);
  vi.restoreAllMocks();
});

describe("سيناريو 9 (كامل) — الإرسال لحظة التثبيت بس", () => {
  it("طلب مثبّت بيوصل الـ OMS مرة وحدة بالضبط؛ وغير المثبّت ما بيوصل أبدًا (حتى بالكنس الساعي)", async () => {
    await connectOms();
    const o = await readyOrder();
    // غير مثبّت: ولا مهمة ترحيل، والكنس الساعي ما بيلمسه
    expect(jobs("handoff_order_to_oms")).toHaveLength(0);
    expect(await sweepOrdersMissingOms(db as Db, new Date())).toBe(0);
    expect(omsCalls.filter((c) => c.method === "POST")).toHaveLength(0);

    const r = await sealDueOrders(db as Db, FUTURE());
    expect(r.sealed).toBe(1);
    const handoffJobs = jobs("handoff_order_to_oms");
    expect(handoffJobs).toHaveLength(1);
    expect(handoffJobs[0].idempotencyKey).toBe(`oms-handoff:${WS}:${o.id}`);

    // تشغيل مرتين (إعادة) = طلب واحد عند الـ OMS
    expect(await handleAutoHandoffJob(db as Db, { orderId: o.id }, WS)).toEqual({ success: true });
    await handleAutoHandoffJob(db as Db, { orderId: o.id }, WS);
    expect(omsCalls.filter((c) => c.method === "POST" && c.path === "/api/v1/orders")).toHaveLength(1);
    expect(orders()[0].omsOrderId).toBe("oms-ord-1");
    // والكنس الساعي بعد الإرسال ما بيعمل شي
    expect(await sweepOrdersMissingOms(db as Db, new Date())).toBe(0);
  });

  it("بلا ربط OMS: التثبيت ما بيعمل مهمة ترحيل، وتيليجرام بيفشل بهدوء (مهمة إعادة محاولة وبس)", async () => {
    await readyOrder();
    await sealDueOrders(db as Db, FUTURE());
    expect(jobs("handoff_order_to_oms")).toHaveLength(0);
    expect(orders()[0].status).toBe("CONFIRMED");
  });
});

describe("رسالة التثبيت للعميل (§10.2)", () => {
  it("نص حتمي برقم الطلب والبنود والإجمالي، بآخر 3 خانات من الرقم، ومرة وحدة حتى مع إعادة المهمة", async () => {
    const o = await readyOrder();
    await sealDueOrders(db as Db, FUTURE());
    expect(jobs("send_order_confirmation")).toHaveLength(1);
    const res = await handleSendOrderConfirmation(db as Db, { orderId: o.id }, WS);
    expect(res.outcome).toBe("SENT");
    await handleSendOrderConfirmation(db as Db, { orderId: o.id }, WS);
    expect(outbound()).toHaveLength(1);
    const text = String(outbound()[0].text);
    expect(text).toContain("تم تثبيت طلبك ✅");
    expect(text).toContain(`رقم الطلب: ${o.orderNumber}`);
    expect(text).toContain("ماء الكمأ × 2");
    expect(text).toContain("الإجمالي: 30 USD");
    expect(text).toContain("درعا — شارع (أ)");
    expect(text).toContain("المنتهي بـ 348");
    expect(text).not.toContain("0964123348");
  });

  it("buildConfirmationText: بلا رقم صالح ما بيطلع آخر خانات", () => {
    const t = buildConfirmationText({ orderNumber: "ORD-1", items: [{ name: "س", quantity: 1 }], total: 5, currency: "USD", province: null, address: null, phone: null });
    expect(t).toContain("رح يتواصل معك فريقنا لتأكيد التوصيل");
    expect(t).not.toContain("المنتهي");
  });

  it("الموظف ماسك المحادثة ← ما بتنبعت وبتطلع ملاحظة «رد مقترح» مرة وحدة", async () => {
    const o = await readyOrder();
    await db.conversation.update({ where: { id: conversationId }, data: { aiState: "HUMAN_ACTIVE" } } as never);
    await sealDueOrders(db as Db, FUTURE());
    const res = await handleSendOrderConfirmation(db as Db, { orderId: o.id }, WS);
    expect(res.outcome).toBe("SUGGESTED_TO_STAFF");
    await handleSendOrderConfirmation(db as Db, { orderId: o.id }, WS);
    expect(outbound()).toHaveLength(0);
    expect(notes().filter((m) => String(m.text).includes("رد مقترح"))).toHaveLength(1);
  });

  it("صفحة تجميع فقط ← ما بتنبعت + ملاحظة داخلية، وما بتعيد المهمة", async () => {
    const o = await readyOrder();
    await sealOrder(db as Db, { workspaceId: WS, orderId: o.id, actor: ACTOR });
    (db._stores.channel as any[])[0].sendMode = "COLLECTION_ONLY";
    const res = await handleSendOrderConfirmation(db as Db, { orderId: o.id }, WS);
    expect(res).toMatchObject({ success: true, outcome: "BLOCKED_BY_POLICY" });
    expect(outbound()).toHaveLength(0);
    expect(notes().some((m) => String(m.text).includes("ما انبعتت رسالة تثبيت الطلب"))).toBe(true);
  });

  it("orderConfirmMessage=false ← ولا مهمة ولا رسالة", async () => {
    await setSettings({ orderConfirmMessage: false });
    const o = await readyOrder();
    await sealDueOrders(db as Db, FUTURE());
    expect(jobs("send_order_confirmation")).toHaveLength(0);
    expect((await handleSendOrderConfirmation(db as Db, { orderId: o.id }, WS)).outcome).toBe("DISABLED");
    expect(outbound()).toHaveLength(0);
  });

  it("طلب مش مثبّت أو ملغى ← ولا رسالة", async () => {
    const o = await readyOrder();
    expect((await handleSendOrderConfirmation(db as Db, { orderId: o.id }, WS)).outcome).toBe("NOT_SEALED");
    expect(outbound()).toHaveLength(0);
  });
});

describe("سيناريو 12 — عميل محظور بالـ OMS", () => {
  it("lookup محظور ← ما بيتثبّت ولا بينبعت، والطلب بيروح للمراجعة بسبب CUSTOMER_BLACKLISTED", async () => {
    await connectOms();
    lookupAnswer = () => Response.json({ found: true, blacklisted: true });
    const o = await readyOrder();
    const r = await sealDueOrders(db as Db, FUTURE());
    expect(r.sealed).toBe(0);
    expect(r.skipped.BLACKLISTED).toBe(1);
    expect(orders()[0]).toMatchObject({ status: "CONFIRMATION_PENDING", sealedAt: null });
    expect(orders()[0].reviewReasons).toContain("CUSTOMER_BLACKLISTED");
    expect(jobs("handoff_order_to_oms")).toHaveLength(0);
    expect(jobs("send_order_confirmation")).toHaveLength(0);
    expect(omsCalls.some((c) => c.method === "POST" && c.path === "/api/v1/orders")).toBe(false);
    expect(revs(o.id).some((x) => x.kind === "STAFF_EDIT")).toBe(true);
  });

  it("فشل الفحص (الباب ما بيدعمه/واقع) ما بيوقف التثبيت", async () => {
    await connectOms();
    lookupAnswer = () => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    await readyOrder();
    const r = await sealDueOrders(db as Db, FUTURE());
    expect(r.sealed).toBe(1);
    expect(jobs("handoff_order_to_oms")).toHaveLength(1);
  });
});

describe("سيناريو 13 — تعديل بعد التثبيت (§10.3)", () => {
  async function sealedAndSent() {
    await connectOms();
    const o = await readyOrder();
    await sealDueOrders(db as Db, FUTURE());
    await handleAutoHandoffJob(db as Db, { orderId: o.id }, WS);
    expect(orders()[0].omsOrderId).toBe("oms-ord-1");
    return o;
  }
  const amend = async () => {
    const m = await say("غيّر رقمي لـ 0954321098");
    const last = (db._stores.message as any[]).find((x) => x.id === m.messageId);
    return read(last.id, provider(() => ({ relation: "AMEND_LAST", phone: "0954321098", evidence: ["m3"] })), new Date(Date.now() + 240_000));
  };

  it("انبعت: ملاحظة حتمية للـ OMS + AMEND_REQUEST(NOTE_SENT) + بند «يحتاجك» ORDER_CHANGE_REQUEST، وما في تكرار", async () => {
    const o = await sealedAndSent();
    const r = await amend();
    expect(r.applied).toMatchObject({ action: "CHANGE", detail: { action: "AMEND_REQUESTED", omsState: "NOTE_SENT" } });
    const note = omsCalls.find((c) => c.path === `/api/v1/orders/oms-ord-1/notes`);
    expect(note?.body.note).toContain("طلب تعديل من المحادثة: الهاتف من 0964123348 إلى 0954321098");
    const req = revs(o.id).find((x) => x.kind === "AMEND_REQUEST")!;
    expect(req.omsState).toBe("NOTE_SENT");
    const handoffs = (db._stores.humanHandoff as any[]).filter((h) => h.reason === "ORDER_CHANGE_REQUEST");
    expect(handoffs).toHaveLength(1);
    // الطلب المحلي ما تغيّر لسا
    expect(orders()[0].recipientPhone).toBe("0964123348");
    // قراءة تانية بنفس الفرق ما بتكرّر الطلب
    const m = await say("تمام");
    const last = (db._stores.message as any[]).find((x) => x.id === m.messageId);
    await read(last.id, provider(() => ({ relation: "AMEND_LAST", phone: "0954321098", evidence: ["m3"] })), new Date(Date.now() + 360_000));
    expect(revs(o.id).filter((x) => x.kind === "AMEND_REQUEST")).toHaveLength(1);
    // الموظف: «تم التعديل بالـ OMS» ← بيتطبّق محليًا
    const done = await resolveChangeRequest(db as Db, { workspaceId: WS, orderId: o.id, version: req.version, decision: "APPLIED", actor: { userId: "staff-1" } });
    expect(done.decision).toBe("APPLIED");
    expect(orders()[0].recipientPhone).toBe("0954321098");
    expect(revs(o.id).map((x) => x.kind)).toContain("AMEND_APPLIED");
    await expect(resolveChangeRequest(db as Db, { workspaceId: WS, orderId: o.id, version: req.version, decision: "REJECTED", actor: { userId: "staff-1" } })).rejects.toMatchObject({ code: "CHANGE_REQUEST_RESOLVED" });
  });

  it("الملاحظة فشلت ← NEEDS_STAFF والبند بيضل", async () => {
    const o = await sealedAndSent();
    noteAnswer = () => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    const r = await amend();
    expect(r.applied).toMatchObject({ action: "CHANGE", detail: { action: "AMEND_REQUESTED", omsState: "NEEDS_STAFF" } });
    expect(revs(o.id).find((x) => x.kind === "AMEND_REQUEST")!.omsState).toBe("NEEDS_STAFF");
    expect((db._stores.humanHandoff as any[]).filter((h) => h.reason === "ORDER_CHANGE_REQUEST")).toHaveLength(1);
  });

  it("لسا ما انبعت (ولا ربط): بيتطبّق محليًا AMEND_APPLIED بلا بند ولا ملاحظة", async () => {
    const o = await readyOrder();
    await sealDueOrders(db as Db, FUTURE());
    expect(orders()[0].omsOrderId == null).toBe(true);
    const r = await amend();
    expect(r.applied).toMatchObject({ action: "CHANGE", detail: { action: "AMEND_APPLIED" } });
    expect(orders()[0].recipientPhone).toBe("0954321098");
    expect((db._stores.humanHandoff as any[]).filter((h) => h.reason === "ORDER_CHANGE_REQUEST")).toHaveLength(0);
    expect(revs(o.id).map((x) => x.kind)).toContain("AMEND_APPLIED");
  });

  it("describeDiff · isChatEditable · المسار الآلي (ب) مطفي", () => {
    expect(describeDiff([{ field: "recipientPhone", from: "1", to: "2" }])).toBe("الهاتف من 1 إلى 2");
    expect(isChatEditable({ omsStatus: "NEW", omsShippingStatus: "NOT_READY" })).toBe(true);
    expect(isChatEditable({ omsStatus: "CONFIRMED", omsShippingStatus: "NOT_READY" })).toBe(false);
    expect(isChatEditable({ omsStatus: "NEW", omsShippingStatus: "SHIPPED" })).toBe(false);
    expect(OMS_AUTO_AMEND).toBe(false);
  });
});

describe("سيناريو 14 — إلغاء بعد التثبيت", () => {
  it("انبعت: CANCEL_REQUEST + بند، و«مرفوض» بيخلّي الطلب زي ما هو", async () => {
    await connectOms();
    const o = await readyOrder();
    await sealDueOrders(db as Db, FUTURE());
    await handleAutoHandoffJob(db as Db, { orderId: o.id }, WS);
    const m = await say("خلص بدي ألغي الطلب");
    const last = (db._stores.message as any[]).find((x) => x.id === m.messageId);
    const r = await read(last.id, provider(() => ({ cancel: true, evidence: ["m3"] })), new Date(Date.now() + 240_000));
    expect(r.applied).toMatchObject({ action: "CHANGE", detail: { action: "CANCEL_REQUESTED", omsState: "NOTE_SENT" } });
    expect(orders()[0].status).toBe("CONFIRMED");
    const req = revs(o.id).find((x) => x.kind === "CANCEL_REQUEST")!;
    await resolveChangeRequest(db as Db, { workspaceId: WS, orderId: o.id, version: req.version, decision: "REJECTED", actor: { userId: "staff-1" } });
    expect(orders()[0].status).toBe("CONFIRMED");
    expect(revs(o.id).map((x) => x.kind)).toContain("AMEND_REJECTED");
  });

  it("«تم بالـ OMS» على طلب إلغاء ← CANCELLED محليًا", async () => {
    await connectOms();
    const o = await readyOrder();
    await sealDueOrders(db as Db, FUTURE());
    await handleAutoHandoffJob(db as Db, { orderId: o.id }, WS);
    const m = await say("خلص بدي ألغي الطلب");
    const last = (db._stores.message as any[]).find((x) => x.id === m.messageId);
    await read(last.id, provider(() => ({ cancel: true, evidence: ["m3"] })), new Date(Date.now() + 240_000));
    const req = revs(o.id).find((x) => x.kind === "CANCEL_REQUEST")!;
    await resolveChangeRequest(db as Db, { workspaceId: WS, orderId: o.id, version: req.version, decision: "APPLIED", actor: { userId: "staff-1" } });
    expect(orders()[0].status).toBe("CANCELLED");
  });
});

describe("القارئ ← بند «يحتاجك» وملف العميل", () => {
  it("needsHuman ← handoff بلا تغيير aiState (الوكيل بيكمّل يرد)", async () => {
    const m1 = await say("بدي ماء الكمأ");
    conversationId = m1.conversationId;
    const m2 = await say("2 حبة 0964123348 درعا شارع (أ) أكيد ثبّتوا");
    await read(m2.messageId, provider(() => ({ needsHuman: true })));
    expect((db._stores.humanHandoff as any[]).filter((h) => h.reason === "COMPLAINT")).toHaveLength(1);
    const conv = (db._stores.conversation as any[]).find((c) => c.id === conversationId);
    expect(conv.aiState).toBe("AI_ACTIVE");
  });

  it("ملف العميل: آخر قيمة متحقق منها بتغلب مع سطر تدقيق", async () => {
    await readyOrder();
    const cust = (db._stores.customer as any[])[0];
    expect(cust.phone).toBe("0964123348");
    expect(cust.province).toBe("درعا");
    expect((db._stores.auditLog as any[]).some((a) => a.action === "customer.updated_from_reading")).toBe(true);
  });
});
