/**
 * الحزمة 2.3 — «يحتاجك» (05-DASHBOARDS §3): كل نوع بند من بياناته · الفلترة حسب الصلاحية ·
 * الحالة المركّبة · كاش 15 ثانية · البحث الشامل.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createFakeDb } from "./helpers/inmemory-db";
import { attentionFor, clearAttentionCache, computeAttention, getAttention, OMS_STUCK_AFTER_MS, UNANSWERED_AFTER_MS } from "@/modules/attention/service";
import { MIN_QUERY, normalizeSearchQuery, searchAll } from "@/modules/search/service";
import { effectivePermissions, type Permission } from "@/modules/rbac/permissions";

const WS = "ws-att";
const NOW = new Date("2026-11-17T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
let db: ReturnType<typeof createFakeDb>;
const canFor = (role: string, extras: string[] = []) => {
  const set = effectivePermissions(role, extras);
  return (p: Permission) => set.has(p);
};
const types = async (role = "OWNER") => attentionFor(await computeAttention(db, WS, NOW), canFor(role)).items.map((i) => i.type);

beforeEach(async () => {
  clearAttentionCache();
  db = createFakeDb();
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
  // مساحة «مكتملة الإعداد» علشان ما يطلع بند SETUP_GAP بكل اختبار.
  await db.product.create({ data: { workspaceId: WS, name: "منتج", isActive: true } } as never);
  await db.faq.create({ data: { workspaceId: WS, question: "س", answer: "ج", isActive: true } } as never);
});

describe("أنواع البنود من بياناتها", () => {
  it("مساحة سليمة = قائمة فاضية وبلا شريط", async () => {
    const r = attentionFor(await computeAttention(db, WS, NOW), canFor("OWNER"));
    expect(r).toEqual({ items: [], counts: { total: 0, critical: 0 }, banner: null });
  });

  it("ORDER_REVIEW: طلب CONFIRMATION_PENDING ← درج الطلب", async () => {
    await db.order.create({ data: { id: "o1", workspaceId: WS, orderNumber: "SY-1", status: "CONFIRMATION_PENDING", customerId: "c" } } as never);
    await db.order.create({ data: { id: "o2", workspaceId: WS, orderNumber: "SY-2", status: "NEW", customerId: "c" } } as never);
    const items = attentionFor(await computeAttention(db, WS, NOW), canFor("OWNER")).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "ORDER_REVIEW", severity: "high", href: "/orders?order=o1", subtitle: "SY-1" });
  });

  it("ORDER_CHANGE: تعديل بعد التثبيت (ملاحظة انبعتت أو بدّه موظف)، مرة وحدة لكل طلب", async () => {
    await db.orderRevision.create({ data: { workspaceId: WS, orderId: "o1", version: 2, kind: "AMEND", snapshot: {}, actor: "x", omsState: "NOTE_SENT" } } as never);
    await db.orderRevision.create({ data: { workspaceId: WS, orderId: "o1", version: 3, kind: "AMEND", snapshot: {}, actor: "x", omsState: "NEEDS_STAFF" } } as never);
    await db.orderRevision.create({ data: { workspaceId: WS, orderId: "o2", version: 2, kind: "AMEND", snapshot: {}, actor: "x", omsState: "APPLIED" } } as never);
    expect((await types()).filter((t) => t === "ORDER_CHANGE")).toHaveLength(1);
  });

  it("تحويلات مفتوحة: وعد بلا طلب · شكوى · طلب موظف — والمحلولة لا", async () => {
    await db.humanHandoff.create({ data: { workspaceId: WS, conversationId: "c1", customerId: "x", reason: "MANUAL", status: "OPEN", metadata: { aiClaimedNoOrder: true } } } as never);
    await db.humanHandoff.create({ data: { workspaceId: WS, conversationId: "c2", customerId: "x", reason: "COMPLAINT", status: "OPEN" } } as never);
    await db.humanHandoff.create({ data: { workspaceId: WS, conversationId: "c3", customerId: "x", reason: "CUSTOMER_REQUEST", status: "OPEN" } } as never);
    await db.humanHandoff.create({ data: { workspaceId: WS, conversationId: "c4", customerId: "x", reason: "COMPLAINT", status: "RESOLVED" } } as never);
    expect((await types()).sort()).toEqual(["AI_PROMISE", "ASKED_HUMAN", "COMPLAINT"]);
  });

  it("UNANSWERED: رسالة عميل قبل > 10 دقايق بلا رد — ومن عندها رد أو أحدث من 10 دقايق لا", async () => {
    const mk = (id: string, at: Date) => db.conversation.create({ data: { id, workspaceId: WS, customerId: "x", channelId: "ch", channelConversationId: id, status: "OPEN", lastCustomerMessageAt: at } } as never);
    await mk("late", ago(UNANSWERED_AFTER_MS + 5 * MIN));
    await mk("fresh", ago(2 * MIN));
    await mk("replied", ago(UNANSWERED_AFTER_MS + 8 * MIN));
    await db.message.create({ data: { workspaceId: WS, conversationId: "replied", senderType: "AI", direction: "OUTBOUND", createdAt: ago(UNANSWERED_AFTER_MS + 6 * MIN) } } as never);
    const items = attentionFor(await computeAttention(db, WS, NOW), canFor("OWNER")).items.filter((i) => i.type === "UNANSWERED");
    expect(items.map((i) => i.href)).toEqual(["/conversations?id=late"]);
  });

  it("SEND_FAILED: فشل إرسال آخر 24 ساعة، مرة لكل محادثة، والملاحظات الداخلية لا", async () => {
    const m = (conv: string, extra: object = {}) => db.message.create({ data: { workspaceId: WS, conversationId: conv, senderType: "AGENT", direction: "OUTBOUND", deliveryStatus: "FAILED", createdAt: ago(30 * MIN), ...extra } } as never);
    await m("a");
    await m("a");
    await m("b", { isNote: true });
    await m("c", { createdAt: ago(48 * 60 * MIN) });
    expect((await types()).filter((t) => t === "SEND_FAILED")).toHaveLength(1);
  });

  it("READ_FAILED: قراءة فاشلة ← المحادثة", async () => {
    await db.conversationReading.create({ data: { workspaceId: WS, conversationId: "c9", status: "FAILED" } } as never);
    await db.conversationReading.create({ data: { workspaceId: WS, conversationId: "c8", status: "DONE" } } as never);
    const i = attentionFor(await computeAttention(db, WS, NOW), canFor("OWNER")).items.find((x) => x.type === "READ_FAILED");
    expect(i?.href).toBe("/conversations?id=c9");
  });

  it("OMS_DOWN (حرج) وOMS_STUCK: الربط واقع + طلب مثبّت أقدم من 15 دقيقة بلا رقم OMS", async () => {
    await db.omsConnection.create({ data: { workspaceId: WS, baseUrl: "https://x", tokenEncrypted: "t", isActive: true, lastOkAt: ago(60 * MIN), lastErrorAt: ago(5 * MIN) } } as never);
    await db.order.create({ data: { id: "s1", workspaceId: WS, orderNumber: "SY-9", status: "CONFIRMED", customerId: "c", sealedAt: ago(OMS_STUCK_AFTER_MS + MIN), omsOrderId: null } } as never);
    await db.order.create({ data: { id: "s2", workspaceId: WS, orderNumber: "SY-10", status: "CONFIRMED", customerId: "c", sealedAt: ago(5 * MIN), omsOrderId: null } } as never);
    await db.order.create({ data: { id: "s3", workspaceId: WS, orderNumber: "SY-11", status: "CONFIRMED", customerId: "c", sealedAt: ago(40 * MIN), omsOrderId: "oms-1" } } as never);
    await db.order.create({ data: { id: "s4", workspaceId: WS, orderNumber: "SY-12", status: "NEW", customerId: "c", sealedAt: null, omsOrderId: null } } as never);
    const r = attentionFor(await computeAttention(db, WS, NOW), canFor("OWNER"));
    expect(r.items.filter((i) => i.type === "OMS_STUCK").map((i) => i.id)).toEqual(["OMS_STUCK:s1"]);
    expect(r.items[0]).toMatchObject({ type: "OMS_DOWN", severity: "critical", href: "/settings/integrations" });
    expect(r.banner).toEqual({ type: "OMS_DOWN", title: "ربط الـOMS متوقف", href: "/settings/integrations" });
  });

  it("الربط اللي رجع يشتغل بعد الخطأ = ما في OMS_DOWN", async () => {
    await db.omsConnection.create({ data: { workspaceId: WS, baseUrl: "https://x", tokenEncrypted: "t", isActive: true, lastErrorAt: ago(20 * MIN), lastOkAt: ago(2 * MIN) } } as never);
    expect(await types()).not.toContain("OMS_DOWN");
  });

  it("PAGE_DOWN: ERROR أو انقطعت بعد ما كانت شغّالة؛ قناة ما انربطت أصلًا لا", async () => {
    await db.channel.create({ data: { id: "p1", workspaceId: WS, type: "FACEBOOK", status: "ERROR", displayName: "صفحة 1", externalId: "1" } } as never);
    await db.channel.create({ data: { id: "p2", workspaceId: WS, type: "FACEBOOK", status: "DISCONNECTED", displayName: "صفحة 2", externalId: "2" } } as never);
    await db.channel.create({ data: { id: "p3", workspaceId: WS, type: "WHATSAPP", status: "DISCONNECTED", displayName: "جديدة", externalId: null } } as never);
    await db.channel.create({ data: { id: "p4", workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "تمام", externalId: "4" } } as never);
    expect((await types()).filter((t) => t === "PAGE_DOWN")).toHaveLength(2);
  });

  it("AI_FAILING: ≥ 5 فشل من آخر 10 محاولات رد", async () => {
    const log = (i: number, success: boolean) => db.aIUsageLog.create({ data: { workspaceId: WS, purpose: "RESPONSE", provider: "p", model: "m", success, createdAt: ago(i * MIN) } } as never);
    for (let i = 1; i <= 4; i++) await log(i, false);
    for (let i = 5; i <= 10; i++) await log(i, true);
    expect(await types()).not.toContain("AI_FAILING");
    await log(0, false); // آخر 10 = 5 فشل
    expect(await types()).toContain("AI_FAILING");
  });

  it("WORKER_DOWN: نبضة أقدم من دقيقتين؛ بلا نبضات (تطوير) لا بند", async () => {
    expect(await types()).not.toContain("WORKER_DOWN");
    await db.workerHeartbeat.create({ data: { workerId: "w1", lastCycleAt: ago(5 * MIN) } } as never);
    expect(await types()).toContain("WORKER_DOWN");
  });

  it("SETUP_GAP: بلا منتجات أو أسئلة شائعة (أهدأ بند)", async () => {
    const empty = createFakeDb();
    await empty.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
    const r = attentionFor(await computeAttention(empty, WS, NOW), canFor("OWNER"));
    expect(r.items.map((i) => i.id).sort()).toEqual(["SETUP_GAP:faq", "SETUP_GAP:products"]);
    expect(r.items.every((i) => i.severity === "low")).toBe(true);
  });

  it("SETUP_GAP: صفحة مربوطة بلا مجموعة منتجات = بند لحاله، والصفحة اللي إلها مجموعة لا", async () => {
    await db.channel.create({ data: { id: "chA", workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "أ", externalId: "1" } } as never);
    await db.channel.create({ data: { id: "chB", workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "ب", externalId: "2" } } as never);
    await db.catalogPageAssignment.create({ data: { workspaceId: WS, channelId: "chB", catalogId: "cat" } } as never);
    const r = attentionFor(await computeAttention(db, WS, NOW), canFor("OWNER"));
    expect(r.items.map((i) => i.id)).toEqual(["SETUP_GAP:catalog:chA"]);
    expect(r.items[0]!.href).toBe("/channels");
    // موظف بلا صلاحية الإسناد ما بيشوفه
    expect(attentionFor(await computeAttention(db, WS, NOW), canFor("VIEWER")).items).toEqual([]);
  });

  it("عزل المساحات: بنود مساحة تانية ما بتظهر", async () => {
    await db.order.create({ data: { id: "x", workspaceId: "other", orderNumber: "Z", status: "CONFIRMATION_PENDING", customerId: "c" } } as never);
    expect(await types()).toEqual([]);
  });
});

describe("الصلاحيات والترتيب", () => {
  it("كل بند بيوصل لمن بيقدر يعالجه بس", async () => {
    await db.order.create({ data: { id: "o1", workspaceId: WS, orderNumber: "SY-1", status: "CONFIRMATION_PENDING", customerId: "c" } } as never);
    await db.omsConnection.create({ data: { workspaceId: WS, baseUrl: "https://x", tokenEncrypted: "t", isActive: true, lastErrorAt: ago(MIN) } } as never);
    await db.humanHandoff.create({ data: { workspaceId: WS, conversationId: "c1", customerId: "x", reason: "COMPLAINT", status: "OPEN" } } as never);
    const raw = await computeAttention(db, WS, NOW);
    const owner = attentionFor(raw, canFor("OWNER")).items.map((i) => i.type);
    expect(owner).toEqual(expect.arrayContaining(["OMS_DOWN", "ORDER_REVIEW", "COMPLAINT"]));
    // موظف مبيعات: ما بيشوف عطل الربط (integrations.manage) ولا مراجعة الطلب إلا إذا عنده orders.seal.
    const sales = attentionFor(raw, canFor("SALES_AGENT")).items.map((i) => i.type);
    expect(sales).not.toContain("OMS_DOWN");
    // الصلاحية الإضافية بتفتحه.
    const withExtra = attentionFor(raw, canFor("SALES_AGENT", ["integrations.manage"])).items.map((i) => i.type);
    expect(withExtra).toContain("OMS_DOWN");
    // بلا أي صلاحية: ولا بند.
    expect(attentionFor(raw, () => false).items).toEqual([]);
  });

  it("الترتيب: حرج ثم عالي ثم متوسط ثم منخفض، وبكل شدة الأحدث أول", async () => {
    await db.omsConnection.create({ data: { workspaceId: WS, baseUrl: "https://x", tokenEncrypted: "t", isActive: true, lastErrorAt: ago(MIN) } } as never);
    await db.order.create({ data: { id: "old", workspaceId: WS, orderNumber: "A", status: "CONFIRMATION_PENDING", customerId: "c", updatedAt: ago(30 * MIN) } } as never);
    await db.order.create({ data: { id: "new", workspaceId: WS, orderNumber: "B", status: "CONFIRMATION_PENDING", customerId: "c", updatedAt: ago(1 * MIN) } } as never);
    await db.conversationReading.create({ data: { workspaceId: WS, conversationId: "c9", status: "FAILED" } } as never);
    const r = attentionFor(await computeAttention(db, WS, NOW), canFor("OWNER"));
    expect(r.items.map((i) => i.id)).toEqual(["OMS_DOWN", "ORDER_REVIEW:new", "ORDER_REVIEW:old", "READ_FAILED:c9"]);
    expect(r.counts).toEqual({ total: 4, critical: 1 });
  });

  it("حالة مركّبة (05 §9): ثلاثة بنود + شريط العطل", async () => {
    await db.omsConnection.create({ data: { workspaceId: WS, baseUrl: "https://x", tokenEncrypted: "t", isActive: true, lastErrorAt: ago(MIN) } } as never);
    await db.order.create({ data: { id: "o1", workspaceId: WS, orderNumber: "SY-1", status: "CONFIRMATION_PENDING", customerId: "c" } } as never);
    await db.humanHandoff.create({ data: { workspaceId: WS, conversationId: "c1", customerId: "x", reason: "CUSTOMER_REQUEST", status: "OPEN" } } as never);
    const r = attentionFor(await computeAttention(db, WS, NOW), canFor("OWNER"));
    expect(r.counts).toEqual({ total: 3, critical: 1 });
    expect(r.banner?.type).toBe("OMS_DOWN");
  });
});

describe("الكاش (15 ثانية)", () => {
  it("بيرجّع نفس النتيجة داخل 15 ثانية وبيحسب من جديد بعدها", async () => {
    const at = (s: number) => new Date(NOW.getTime() + s * 1000);
    expect((await getAttention(db, WS, canFor("OWNER"), { now: at(0) })).counts.total).toBe(0);
    await db.order.create({ data: { id: "o1", workspaceId: WS, orderNumber: "SY-1", status: "CONFIRMATION_PENDING", customerId: "c" } } as never);
    expect((await getAttention(db, WS, canFor("OWNER"), { now: at(10) })).counts.total).toBe(0);
    expect((await getAttention(db, WS, canFor("OWNER"), { now: at(16) })).counts.total).toBe(1);
  });

  it("الكاش خام وبيتفلتر بصلاحيات كل طالب (ما بيتسرّب بند لمن ما بيحق له)", async () => {
    await db.omsConnection.create({ data: { workspaceId: WS, baseUrl: "https://x", tokenEncrypted: "t", isActive: true, lastErrorAt: ago(MIN) } } as never);
    expect((await getAttention(db, WS, canFor("OWNER"), { now: NOW })).counts.total).toBe(1);
    expect((await getAttention(db, WS, canFor("SALES_AGENT"), { now: NOW })).counts.total).toBe(0);
  });

  it("فحص واحد بيفشل ما بيوقّف الباقي", async () => {
    const broken = { ...db, order: { findMany: async () => { throw new Error("boom"); } } } as never;
    await db.humanHandoff.create({ data: { workspaceId: WS, conversationId: "c1", customerId: "x", reason: "COMPLAINT", status: "OPEN" } } as never);
    const items = attentionFor(await computeAttention(broken, WS, NOW), canFor("OWNER")).items;
    expect(items.map((i) => i.type)).toContain("COMPLAINT");
  });
});

describe("البحث الشامل", () => {
  beforeEach(async () => {
    await db.customer.create({ data: { id: "c1", workspaceId: WS, name: "أحمد خالد", phone: "0964123348" } } as never);
    await db.customer.create({ data: { id: "c2", workspaceId: "other", name: "أحمد غريب", phone: "0964000000" } } as never);
    await db.order.create({ data: { id: "o1", workspaceId: WS, orderNumber: "SY-2026-0148", recipientName: "سامي", recipientPhone: "0999111222", customerId: "c1", status: "NEW" } } as never);
  });

  it("عميل بالاسم أو الرقم، وطلب برقمه أو باسم/رقم المستلم — بمساحة الطالب بس", async () => {
    const all = canFor("OWNER");
    expect((await searchAll(db, WS, "أحمد", all)).customers.map((c) => c.id)).toEqual(["c1"]);
    expect((await searchAll(db, WS, "0964123", all)).customers.map((c) => c.id)).toEqual(["c1"]);
    expect((await searchAll(db, WS, "0148", all)).orders.map((o) => o.href)).toEqual(["/orders?order=o1"]);
    expect((await searchAll(db, WS, "سامي", all)).orders).toHaveLength(1);
    expect((await searchAll(db, WS, "0999111", all)).orders).toHaveLength(1);
  });

  it("بيرجّع بس اللي بيحق للطالب يشوفه", async () => {
    const noCustomers = (p: Permission) => p !== "customers.read" && canFor("OWNER")(p);
    const r = await searchAll(db, WS, "أحمد", noCustomers);
    expect(r.customers).toEqual([]);
    const none = await searchAll(db, WS, "0148", () => false);
    expect(none).toEqual({ customers: [], orders: [] });
  });

  it("حد أدنى حرفين، وأرقام هندية بتتحوّل للاتينية", async () => {
    expect(MIN_QUERY).toBe(2);
    expect(await searchAll(db, WS, "أ", canFor("OWNER"))).toEqual({ customers: [], orders: [] });
    expect(normalizeSearchQuery(" ٠٩٦٤ ١٢٣ ")).toBe("0964 123");
  });
});

describe("المسارات", () => {
  const src = (p: string) => readFileSync(p, "utf8");
  it("/api/attention و/api/search مفتوحين لكل عضو فعّال وبيمرّروا الصلاحيات للفلترة", () => {
    expect(src("src/app/api/attention/route.ts")).toContain("auth!.can");
    expect(src("src/app/api/search/route.ts")).toContain("auth!.can");
    expect(src("src/app/api/search/route.ts")).toContain("rateLimit");
  });
});
