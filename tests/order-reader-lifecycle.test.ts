/**
 * الحزمة 1.4 — دورة الطلب من القراءة (02-ORDER-FLOW §7.6 · §8.3 · §16: 3 · 9 · 10 · 11 · 20).
 * قراءة COMPLETE ← طلب بيستنى ← بيتحدّث ← بيتثبّت بعد المهلة. بهالحزمة التثبيت ما بيبعت شي لبرّا.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import type { AIProvider, StructuredRequest } from "@/modules/ai/provider";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { handleReadConversationJob } from "@/modules/orders/reader/service";
import { orderReadingSchema } from "@/modules/orders/reader/schema";
import { sealDueOrders } from "@/modules/orders/settle";
import { cancelOrderByStaff, editOrderFields, holdOrder, releaseOrder, sealOrder, rereadConversation } from "@/modules/orders/reader/actions";
import { computeReviewReasons } from "@/modules/orders/reader/lifecycle";

type Db = Prisma.TransactionClient;
const WS = "ws-life";
const AGENT = { userId: "agent-1", workspaceId: WS };
const ACTOR = { userId: "staff-1", workspaceId: WS };

let db: ReturnType<typeof createFakeDb>;
let conversationId: string;
let tick = 0;
const T0 = new Date("2026-11-16T22:00:00Z");

type Over = { address?: string; agreement?: "EXPLICIT" | "NONE" | "DECLINED"; cancel?: boolean; phone?: string; evidence?: string[] };

function provider(over: () => Over = () => ({})) {
  const calls: string[] = [];
  const p: AIProvider & { calls: string[] } = {
    name: "fake",
    delivery: "local",
    calls,
    async generateText() {
      throw new Error("no");
    },
    async generateStructured<T>(req: StructuredRequest<T>) {
      calls.push(req.user);
      const o = over();
      const out = orderReadingSchema.parse({
        intent: o.cancel ? "CANCELLED" : "ORDERING",
        relation: "NEW",
        items: [{ productRef: "ماء الكمأ", quantity: 2, evidence: ["m2"] }],
        customer: { name: null, phone: o.phone ?? "0964123348", altPhone: null, city: "درعا", address: o.address ?? "شارع (أ)", evidence: { phone: ["m2"], address: o.evidence ?? ["m2"] } },
        agreement: { state: o.agreement ?? "EXPLICIT", evidence: ["m2"] },
        cancelRequested: o.cancel === true,
        notes: null,
        openQuestions: [],
        aiClaimedConfirmed: false,
        needsHuman: { value: false, reason: null },
        memories: [],
        confidence: 0.9,
      });
      const v = req.validate(out);
      if (!v.ok) throw new Error(`invalid: ${v.error}`);
      return { value: v.value, text: "{}", promptTokens: 1, completionTokens: 1, latencyMs: 1 };
    },
  };
  return p;
}

async function say(senderType: "CUSTOMER" | "AI" | "HUMAN", text: string) {
  tick += 1;
  const m = await db.message.create({
    data: { conversationId, workspaceId: WS, senderType, direction: senderType === "CUSTOMER" ? "INBOUND" : "OUTBOUND", type: "TEXT", text, createdAt: new Date(T0.getTime() + tick * 1000) },
  } as never);
  return m.id as string;
}

async function mode(m: "LEGACY_DRAFT" | "READER_SHADOW" | "READER", extra: Record<string, unknown> = {}) {
  await db.workspace.update({ where: { id: WS }, data: { integrationSettings: { orderMode: m, ...extra } } } as never);
}

const read = (id: string, p: AIProvider, now = new Date(T0.getTime() + 60_000)) =>
  handleReadConversationJob(db as Db, { conversationId, throughMessageId: id }, WS, { provider: p, now: () => now });

const orders = () => db._stores.order.filter((o) => o.conversationId === conversationId) as Array<Record<string, any>>;
const revisions = (orderId: string) => db._stores.orderRevision.filter((r) => r.orderId === orderId).sort((a, b) => (a.version as number) - (b.version as number)) as Array<Record<string, any>>;

/** محادثة كاملة بطلب جاهز. */
async function completeConversation() {
  await say("CUSTOMER", "بدي ماء الكمأ");
  return say("CUSTOMER", "2 حبة 0964123348 درعا شارع (أ) أكيد ثبّتوا");
}

beforeEach(async () => {
  db = createFakeDb();
  tick = 0;
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
  await createProduct(db as Db, AGENT, { name: "ماء الكمأ", sku: "TW-500", price: 15, currency: "USD" });
  await db.channel.create({ data: { id: "ch-1", workspaceId: WS, type: "FACEBOOK", name: "كهربا", market: "SY" } } as never);
  const customer = await db.customer.create({ data: { workspaceId: WS, name: "أحمد", phone: null, status: "INTERESTED" } } as never);
  const conv = await db.conversation.create({ data: { workspaceId: WS, customerId: customer.id, channelId: "ch-1", channelConversationId: "fb-1" } } as never);
  conversationId = conv.id;
  await mode("READER");
});

describe("سيناريو 3 — الإنشاء من قراءة COMPLETE", () => {
  it("طلب NEW بالبنود والأسعار من القاعدة، مهلة التثبيت من آخر رسالة عميل، وOrderRevision v1", async () => {
    const last = await completeConversation();
    const r = await read(last, provider());
    expect(r.outcome).toBe("READ");
    expect(r.applied).toMatchObject({ action: "CREATED", status: "NEW" });
    const [o] = orders();
    expect(o).toMatchObject({ status: "NEW", confirmationStatus: "PENDING", readVersion: 1, province: "درعا", recipientPhone: "0964123348" });
    expect(Number(o.total)).toBe(30);
    expect(o.idempotencyKey).toBe(`reader:${WS}:${conversationId}:1`);
    expect(o.reviewReasons).toEqual([]);
    expect(new Date(o.settleAt).getTime()).toBe(T0.getTime() + 2000 + 10 * 60_000);
    const items = db._stores.orderItem.filter((i) => i.orderId === o.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ quantity: 2 });
    expect(Number(items[0].unitPrice)).toBe(15);
    const revs = revisions(o.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ version: 1, kind: "READ", actor: "reader" });
  });

  it("قراءة ثانية بلا تغيير ← ولا طلب ثاني (القراءة متغطّية)", async () => {
    const last = await completeConversation();
    const p = provider();
    await read(last, p);
    const again = await read(last, p);
    expect(again.outcome).toBe("ALREADY_READ");
    expect(orders()).toHaveLength(1);
  });

  it("الظل ما بيعمل طلب (الحزمة 1.3 ما انكسرت)", async () => {
    await mode("READER_SHADOW");
    const last = await completeConversation();
    const r = await read(last, provider());
    expect(r.outcome).toBe("READ");
    expect(r.applied).toBeNull();
    expect(orders()).toHaveLength(0);
  });
});

describe("سيناريو 9 (بلا الإرسال) — التثبيت بعد المهلة", () => {
  it("قبل المهلة ما بيتثبّت، وبعدها CONFIRMED + SEAL + بلا أي إرسال لبرّا", async () => {
    const last = await completeConversation();
    await read(last, provider());
    const [o] = orders();
    const early = await sealDueOrders(db as Db, new Date(T0.getTime() + 5 * 60_000));
    expect(early.sealed).toBe(0);
    expect(orders()[0].status).toBe("NEW");

    const jobsBefore = db._stores.backgroundJob.length;
    const messagesBefore = db._stores.message.length;
    const late = await sealDueOrders(db as Db, new Date(T0.getTime() + 30 * 60_000));
    expect(late.sealed).toBe(1);
    const sealed = orders()[0];
    expect(sealed).toMatchObject({ status: "CONFIRMED", confirmationStatus: "CONFIRMED_BY_CUSTOMER", settleAt: null });
    expect(sealed.sealedAt).toBeTruthy();
    expect(revisions(o.id).map((r) => r.kind)).toEqual(["READ", "SEAL"]);
    // بلا ربط OMS ولا تيليجرام: ولا مهمة ترحيل. رسالة التثبيت مهمة مستقلة (ما بتنبعت من التثبيت نفسه).
    const added = db._stores.backgroundJob.slice(jobsBefore).map((j) => j.type);
    expect(added).toEqual(["send_order_confirmation"]);
    expect(db._stores.message.length).toBe(messagesBefore);
  });

  it("مساحة بوضع الظل أو بلا orderAutoSeal ← الكنس بيتخطّى", async () => {
    const last = await completeConversation();
    await read(last, provider());
    await mode("READER", { orderAutoSeal: false });
    const r = await sealDueOrders(db as Db, new Date(T0.getTime() + 30 * 60_000));
    expect(r.sealed).toBe(0);
    expect(r.skipped.MODE_OR_AUTOSEAL_OFF).toBe(1);
    expect(orders()[0].status).toBe("NEW");
  });

  it("سباق: كنسين بنفس اللحظة ← تثبيت واحد", async () => {
    const last = await completeConversation();
    await read(last, provider());
    const now = new Date(T0.getTime() + 30 * 60_000);
    const [a, b] = await Promise.all([sealDueOrders(db as Db, now), sealDueOrders(db as Db, now)]);
    expect(a.sealed + b.sealed).toBe(1);
    expect(revisions(orders()[0].id).filter((r) => r.kind === "SEAL")).toHaveLength(1);
  });

  it("قراءة قديمة (رسالة عميل جديدة بعدها) ← ما بيثبّت وبيصفّف قراءة فورية", async () => {
    const last = await completeConversation();
    await read(last, provider());
    await say("CUSTOMER", "استنوا بدي أغيّر شي");
    const r = await sealDueOrders(db as Db, new Date(T0.getTime() + 30 * 60_000));
    expect(r.sealed).toBe(0);
    expect(r.skipped.STALE_READING).toBe(1);
    expect(orders()[0].status).toBe("NEW");
    expect(db._stores.backgroundJob.some((j) => j.type === "read_conversation" && String(j.idempotencyKey).endsWith(":seal"))).toBe(true);
  });
});

describe("سيناريو 10 — أسباب المراجعة", () => {
  it("بلا موافقة (NO_AGREEMENT) ← CONFIRMATION_PENDING وما بيتثبّت لحاله أبدًا", async () => {
    const last = await completeConversation();
    await read(last, provider(() => ({ agreement: "NONE" })));
    const [o] = orders();
    expect(o.status).toBe("CONFIRMATION_PENDING");
    expect(o.reviewReasons).toContain("NO_AGREEMENT");
    expect(o.settleAt).toBeNull();
    const r = await sealDueOrders(db as Db, new Date(T0.getTime() + 600 * 60_000));
    expect(r.sealed).toBe(0);
  });

  it("تثبيت يدوي من موظف على CONFIRMATION_PENDING = CONFIRMED_BY_AGENT مع agreement STAFF", async () => {
    const last = await completeConversation();
    await read(last, provider(() => ({ agreement: "NONE" })));
    const [o] = orders();
    const r = await sealOrder(db as Db, { workspaceId: WS, orderId: o.id, actor: ACTOR });
    expect(r).toEqual({ sealed: true, orderId: o.id });
    expect(orders()[0]).toMatchObject({ status: "CONFIRMED", confirmationStatus: "CONFIRMED_BY_AGENT", agreement: "STAFF" });
  });

  it("computeReviewReasons: flags + الناقص + المنتج غير المحسوم", () => {
    const base = { flags: ["PHONE_AMBIGUOUS"], missing: ["address"], unresolved: [{ ref: "x" }] } as never;
    expect(computeReviewReasons(base).sort()).toEqual(["MISSING_FIELDS", "PHONE_AMBIGUOUS", "PRODUCT_UNRESOLVED"]);
  });

  it("«أوقف» ← CONFIRMATION_PENDING بمنع التثبيت، «أطلق» ← NEW بمهلة جديدة", async () => {
    const last = await completeConversation();
    await read(last, provider());
    const [o] = orders();
    await holdOrder(db as Db, { workspaceId: WS, orderId: o.id, actor: ACTOR });
    expect(orders()[0]).toMatchObject({ status: "CONFIRMATION_PENDING", heldBy: "staff-1", settleAt: null });
    expect(orders()[0].reviewReasons).toContain("STAFF_HOLD");
    const none = await sealDueOrders(db as Db, new Date(T0.getTime() + 600 * 60_000));
    expect(none.sealed).toBe(0);
    const now = new Date(T0.getTime() + 100 * 60_000);
    await releaseOrder(db as Db, { workspaceId: WS, orderId: o.id, actor: ACTOR, now });
    expect(orders()[0]).toMatchObject({ status: "NEW", heldBy: null });
    expect(new Date(orders()[0].settleAt).getTime()).toBe(now.getTime() + 10 * 60_000);
  });
});

describe("سيناريو 11 — تعديل العميل ثم تعديل الموظف", () => {
  it("العميل بيغيّر العنوان ← نفس الطلب بيتحدّث (مش طلب ثاني) مع الفرق والمهلة من أول", async () => {
    const last = await completeConversation();
    await read(last, provider());
    const firstSettle = new Date(orders()[0].settleAt).getTime();
    const m3 = await say("CUSTOMER", "لا غيّر العنوان لحي النصر شارع (ب)");
    const r = await read(m3, provider(() => ({ address: "حي النصر شارع (ب)", evidence: ["m3"] })), new Date(T0.getTime() + 120_000));
    expect(r.applied).toMatchObject({ action: "UPDATED", changed: ["deliveryAddress"] });
    expect(orders()).toHaveLength(1);
    const o = orders()[0];
    expect(o.deliveryAddress).toBe("حي النصر شارع (ب)");
    expect(o.readVersion).toBe(2);
    expect(new Date(o.settleAt).getTime()).toBeGreaterThan(firstSettle);
    const revs = revisions(o.id);
    expect(revs.map((x) => x.version)).toEqual([1, 2]);
    expect(revs[1].diff).toEqual([{ field: "deliveryAddress", from: "شارع (أ)", to: "حي النصر شارع (ب)" }]);
  });

  it("حقل عدّله موظف ما بتستبدله قراءة لاحقة، والطلب بيروح لمراجعة", async () => {
    const last = await completeConversation();
    await read(last, provider());
    const [o] = orders();
    await editOrderFields(db as Db, { workspaceId: WS, orderId: o.id, actor: ACTOR, fields: { deliveryAddress: "عنوان الموظف" } });
    const m3 = await say("CUSTOMER", "لا غيّر العنوان لحي النصر شارع (ب)");
    await read(m3, provider(() => ({ address: "حي النصر شارع (ب)", evidence: ["m3"] })), new Date(T0.getTime() + 120_000));
    const after = orders()[0];
    expect(after.deliveryAddress).toBe("عنوان الموظف");
    expect(after.status).toBe("CONFIRMATION_PENDING");
    expect(after.reviewReasons).toContain("CHANGED_AFTER_STAFF_EDIT");
    expect(revisions(o.id).some((r) => r.kind === "STAFF_EDIT")).toBe(true);
  });

  it("تعديل/إلغاء موظف على طلب مثبّت = مسار طلب التعديل (محلي إذا ما انبعت)", async () => {
    const last = await completeConversation();
    await read(last, provider());
    const [o] = orders();
    await sealOrder(db as Db, { workspaceId: WS, orderId: o.id, actor: ACTOR });
    const edit = await editOrderFields(db as Db, { workspaceId: WS, orderId: o.id, actor: ACTOR, fields: { notes: "اتصلوا قبل الوصول" } });
    expect(edit.amend).toMatchObject({ action: "AMEND_APPLIED", orderId: o.id });
    expect(orders()[0].notes).toBe("اتصلوا قبل الوصول");
    const cancel = await cancelOrderByStaff(db as Db, { workspaceId: WS, orderId: o.id, actor: ACTOR });
    expect(cancel.cancel).toMatchObject({ action: "CANCEL_APPLIED" });
    expect(orders()[0].status).toBe("CANCELLED");
    expect(revisions(o.id).map((r) => r.kind)).toEqual(["READ", "SEAL", "AMEND_APPLIED", "CANCEL_APPLIED"]);
  });
});

describe("سيناريو 20 — إلغاء", () => {
  it("العميل بيلغي قبل التثبيت ← الطلب CANCELLED + CANCEL_APPLIED", async () => {
    const last = await completeConversation();
    await read(last, provider());
    const m3 = await say("CUSTOMER", "بدي ألغي الطلب");
    const r = await read(m3, provider(() => ({ cancel: true })), new Date(T0.getTime() + 120_000));
    expect(r.applied).toMatchObject({ action: "CANCELLED" });
    const o = orders()[0];
    expect(o.status).toBe("CANCELLED");
    expect(o.settleAt).toBeNull();
    expect(revisions(o.id).map((x) => x.kind)).toEqual(["READ", "CANCEL_APPLIED"]);
  });

  it("إلغاء يدوي من موظف", async () => {
    const last = await completeConversation();
    await read(last, provider());
    const [o] = orders();
    await cancelOrderByStaff(db as Db, { workspaceId: WS, orderId: o.id, actor: ACTOR, reason: "العميل اتصل" });
    expect(orders()[0].status).toBe("CANCELLED");
  });
});

describe("إعادة القراءة والمسارات", () => {
  it("rereadConversation بيمسح التغطية وبيصفّف مهمة جديدة", async () => {
    const last = await completeConversation();
    await read(last, provider());
    const q = await rereadConversation(db as Db, { workspaceId: WS, conversationId });
    expect(q.queued).toBe(true);
    const again = await read(last, provider());
    expect(again.outcome).toBe("READ");
  });

  it("المسارات الست موجودة وبصلاحياتها", () => {
    const route = (p: string) => readFileSync(`src/app/api/${p}/route.ts`, "utf8");
    expect(route("orders/[id]/seal")).toContain('permission: "orders.seal"');
    expect(route("orders/[id]/hold")).toContain('permission: "orders.seal"');
    expect(route("orders/[id]/release")).toContain('permission: "orders.seal"');
    expect(route("orders/[id]/cancel")).toContain('permission: "orders.cancel"');
    expect(route("orders/[id]/fields")).toContain('permission: "orders.write"');
    expect(route("conversations/[id]/reread")).toContain('permission: "conversations.reply"');
  });

  it("الجدولة بتستدعي كنس التثبيت كل دورة", () => {
    expect(readFileSync("src/modules/integrations/scheduler.ts", "utf8")).toContain("sealDueOrders");
  });
});
