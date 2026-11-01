/**
 * P13 — استخراج بيانات العميل ومزامنتها مع ملف العميل.
 *
 * يثبت على مسار الكود الفعلي:
 *  - ثلاث رسائل متفرقة (اسم · رقم · مدينة) تُحدّث ملف العميل نفسه (بلا تكرار عميل).
 *  - الحقول الفارغة تُملأ، والقيمة الموجودة لا تُمحى بقيمة مستخرجة عادية.
 *  - التعارض يُسجَّل (CONFLICT) ولا يُحسم آليًا على ملف العميل.
 *  - تأكيد الموظف له سلطة: يتقدّم على المستخرج ويُحدّث الملف.
 *  - idempotent: إعادة التحليل لا تغيّر شيئًا.
 *  - عزل المساحات: لا بيانات بين مساحتين.
 *  - وضع التجميع يجمع البيانات دون أي إرسال.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/inmemory-db";
import { processIncomingMessage } from "@/modules/conversations/service";
import { confirmIntelField, runCustomerIntelExtraction } from "@/modules/intelligence/service";
import { planCustomerSync } from "@/modules/intelligence/customer-sync";

type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;

const originalFetch = global.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;

function completion(fields: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(fields) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function seedPage(db: FakeDb, opts: { workspaceId?: string; channelId?: string; sendMode?: string } = {}) {
  db._stores.channel.push({
    id: opts.channelId ?? "ch1",
    workspaceId: opts.workspaceId ?? "ws1",
    type: "FACEBOOK",
    status: "CONNECTED",
    displayName: "صفحة الاختبار",
    sendMode: opts.sendMode ?? "AUTO_REPLY",
  });
}

function inbound(db: FakeDb, over: Record<string, unknown> = {}) {
  return processIncomingMessage(db as never, {
    workspaceId: "ws1",
    channelType: "FACEBOOK",
    channelId: "ch1",
    externalUserId: "psid-A",
    externalConversationId: "psid-A",
    externalMessageId: "mid-1",
    externalEventId: "evt-1",
    provider: "facebook",
    type: "TEXT",
    text: "مرحبا",
    ...over,
  });
}

/** يُنفّذ استخراجًا بإجابة مزيّفة (grounded على نص الرسالة). */
async function extractWith(db: FakeDb, messageId: string, fields: Record<string, unknown>) {
  global.fetch = vi.fn(async () => completion({ ...fields, confidence: fields.confidence ?? 0.9, sourceMessageIds: [messageId] })) as never;
  return runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId });
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe("planCustomerSync — دالة نقية", () => {
  const row = (data: Record<string, unknown>, status: Record<string, string>, at: string) => ({
    data,
    meta: Object.fromEntries(Object.keys(data).map((k) => [k, { status: status[k] ?? "EXTRACTED", sources: ["m1"] }])) as any,
    updatedAt: at,
  });

  it("يملأ الحقول الفارغة فقط ولا يمحو قيمة موجودة", () => {
    const plan = planCustomerSync(
      [row({ customerName: "أحمد", phone: "0612345678" }, {}, "2026-01-01")],
      { name: "سامر", phone: null }
    );
    expect(plan.set.name).toBeUndefined(); // موجود في الملف → محفوظ
    expect(plan.skipped.name).toBe("EXISTING_KEPT");
    expect(plan.set.phone).toBe("0612345678"); // فارغ → يُملأ
  });

  it("القيمة المؤكدة من موظف تتقدّم حتى على قيمة موجودة", () => {
    const plan = planCustomerSync(
      [row({ city: "إربد" }, { city: "CONFIRMED" }, "2026-01-01")],
      { city: "عمان" }
    );
    expect(plan.set.city).toBe("إربد");
  });

  it("التعارض لا يُحسم على ملف العميل", () => {
    const plan = planCustomerSync(
      [{ data: { address: "حي السلام" }, meta: { address: { status: "CONFLICT", sources: [], conflicts: ["حي النصر"] } } as any, updatedAt: "2026-01-01" }],
      { address: null }
    );
    expect(plan.set.address).toBeUndefined();
  });

  it("رقم هاتف غير صالح لا يُحفظ", () => {
    const plan = planCustomerSync(
      [row({ phone: "12" }, {}, "2026-01-01")],
      { phone: null }
    );
    expect(plan.set.phone).toBeUndefined();
  });
});

describe("مزامنة ثلاث رسائل متفرقة → ملف عميل واحد", () => {
  it("الاسم ثم الرقم ثم المدينة تُحدّث العميل نفسه بلا تكرار", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);

    const m1 = await inbound(db, { text: "اسمي أحمد", externalMessageId: "mid-1", externalEventId: "evt-1" });
    await extractWith(db, m1.messageId, { customerName: "أحمد" });

    const m2 = await inbound(db, { text: "رقمي 0612345678", externalMessageId: "mid-2", externalEventId: "evt-2" });
    await extractWith(db, m2.messageId, { phone: "0612345678" });

    const m3 = await inbound(db, { text: "أنا من أكادير", externalMessageId: "mid-3", externalEventId: "evt-3" });
    await extractWith(db, m3.messageId, { city: "أكادير" });

    // عميل واحد فقط رغم ثلاث رسائل.
    const customers = db._stores.customer as Array<Record<string, any>>;
    expect(customers).toHaveLength(1);
    expect(customers[0].name).toBe("أحمد");
    expect(customers[0].phone).toBe("0612345678");
    expect(customers[0].city).toBe("أكادير");
  });

  it("إعادة التحليل (idempotent) لا تغيّر ملف العميل", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const m1 = await inbound(db, { text: "اسمي أحمد" });
    await extractWith(db, m1.messageId, { customerName: "أحمد" });

    const before = JSON.stringify((db._stores.customer as any[])[0]);
    // تحليل مباشر ثانٍ لنفس الرسالة → DUPLICATE ولا كتابة إضافية.
    const dup = await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId: m1.messageId });
    expect(dup.status).toBe("DUPLICATE");
    expect(JSON.stringify((db._stores.customer as any[])[0])).toBe(before);
  });

  it("تعارض المدينة يُسجَّل ولا يمحو القيمة الأولى على الملف", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const m1 = await inbound(db, { text: "أنا ساكن بعمان", externalMessageId: "mid-1", externalEventId: "evt-1" });
    await extractWith(db, m1.messageId, { city: "عمان" });
    const m2 = await inbound(db, { text: "لا، أنا من إربد", externalMessageId: "mid-2", externalEventId: "evt-2" });
    await extractWith(db, m2.messageId, { city: "إربد" });

    const intel = (db._stores.customerIntel as Array<Record<string, any>>)[0];
    expect(intel.fieldMeta.city.status).toBe("CONFLICT");
    const customer = (db._stores.customer as Array<Record<string, any>>)[0];
    expect(customer.city).toBe("عمان");
  });
});

describe("تأكيد الموظف والعزل ووضع التجميع", () => {
  it("تأكيد الموظف يتقدّم على قيمة موجودة على العميل", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    db._stores.customer.push({ id: "cu-1", workspaceId: "ws1", name: "الاسم القديم", phone: null });
    db._stores.conversation.push({ id: "cv-1", workspaceId: "ws1", customerId: "cu-1", channelId: "ch1", channelConversationId: "c1", aiState: "AI_ACTIVE", aiEnabled: true });
    db._stores.customerIntel.push({
      id: "ci-1", workspaceId: "ws1", conversationId: "cv-1", channelId: "ch1", status: "READY",
      data: { customerName: "الاسم القديم" }, fieldMeta: { customerName: { status: "EXTRACTED", sources: ["m1"] } },
      confidence: 0.5, attempts: 1,
    });

    const res = await confirmIntelField(db as never, { workspaceId: "ws1", conversationId: "cv-1", key: "customerName", value: "الاسم الصحيح", userId: "agent-1" });
    expect(res.ok).toBe(true);
    const customer = (db._stores.customer as Array<Record<string, any>>)[0];
    expect(customer.name).toBe("الاسم الصحيح");
  });

  it("عزل المساحات: استخراج مساحة أخرى لا يلمس عميل هذه المساحة", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    // عميل مساحة أخرى
    db._stores.customer.push({ id: "cu-b", workspaceId: "ws-B", name: null, phone: null });
    db._stores.conversation.push({ id: "cv-b", workspaceId: "ws-B", customerId: "cu-b", channelId: "chB", channelConversationId: "cb", aiState: "AI_ACTIVE", aiEnabled: true });
    db._stores.customerIntel.push({
      id: "ci-b", workspaceId: "ws-B", conversationId: "cv-b", channelId: "chB", status: "READY",
      data: { customerName: "مش-لنا" }, fieldMeta: { customerName: { status: "EXTRACTED", sources: ["m"] } },
      confidence: 0.9, attempts: 1,
    });
    const m1 = await inbound(db, { text: "اسمي أحمد" });
    await extractWith(db, m1.messageId, { customerName: "أحمد" });
    const other = (db._stores.customer as Array<Record<string, any>>).find((c) => c.id === "cu-b");
    expect(other?.name).toBeNull();
  });

  it("وضع التجميع: يجمع البيانات ولا يرسل أي رسالة", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db, { sendMode: "COLLECTION_ONLY" });
    const m1 = await inbound(db, { text: "اسمي أحمد" });
    await extractWith(db, m1.messageId, { customerName: "أحمد" });

    const customer = (db._stores.customer as Array<Record<string, any>>)[0];
    expect(customer.name).toBe("أحمد");
    expect((db._stores.message as Array<Record<string, any>>).filter((m) => m.direction === "OUTBOUND")).toHaveLength(0);
  });
});
