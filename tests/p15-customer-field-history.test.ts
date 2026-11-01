/**
 * P15 — سجل تاريخي لقيم بيانات العميل (قبل/بعد).
 *
 * يثبت على مسار الكود الفعلي:
 *  - تصحيح الموظف ينشئ سجلًا مستقلًا لكل تعديل (لا استبدال) بالحقول المطلوبة:
 *    fieldName · beforeValue · afterValue · customerId · workspaceId · actorId · وقت.
 *  - التعديل المتكرر = سجلان مستقلان بقيم قبل/بعد صحيحة.
 *  - لا سجل إذا لم تتغير القيمة.
 *  - إعادة استخراج قديمة لا تغيّر القيمة المؤكدة ولا تضيف سجلًا.
 *  - فشل تسجيل التدقيق يلغي تحديث العميل (المعاملة ترجع للخلف).
 *  - العزل بين المساحات: لا تصحيح ولا قراءة لسجلات مساحة أخرى.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/inmemory-db";
import { processIncomingMessage } from "@/modules/conversations/service";
import { confirmIntelField, runCustomerIntelExtraction } from "@/modules/intelligence/service";
import { getCustomerDetail, updateCustomer } from "@/modules/customers/service";
import { hasPermission } from "@/modules/rbac/permissions";

type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;

const originalFetch = global.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;

function completion(fields: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(fields) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function seedPage(db: FakeDb) {
  db._stores.channel.push({ id: "ch1", workspaceId: "ws1", type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", sendMode: "AUTO_REPLY" });
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
    text: "أنا من أكادير",
    ...over,
  });
}

async function extractCity(db: FakeDb, messageId: string, city: string) {
  global.fetch = vi.fn(async () => completion({ city, confidence: 0.9, sourceMessageIds: [messageId] })) as never;
  return runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId });
}

function fieldAudits(db: FakeDb) {
  return (db._stores.auditLog as any[]).filter((a) => a.action === "customer.field_changed");
}

/** يعطّل كتابة سجل تغيير الحقول فقط (يبقي بقية التدقيق شغّالًا). */
function breakFieldAudit(db: FakeDb) {
  const original = db.auditLog.create.bind(db.auditLog);
  db.auditLog.create = async (args: any) => {
    if (args?.data?.action === "customer.field_changed") throw new Error("audit store down");
    return original(args);
  };
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

describe("P15 — تصحيح الموظف (CustomerIntel)", () => {
  it("التعديل المتكرر ينشئ سجلين مستقلين بالقيم قبل/بعد الصحيحة", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const m1 = await inbound(db);
    await extractCity(db, m1.messageId, "أكادير");
    const customerId = (db._stores.customer as any[])[0].id;

    await confirmIntelField(db as never, { workspaceId: "ws1", conversationId: m1.conversationId, key: "city", value: "الرباط", userId: "agent-7" });
    await confirmIntelField(db as never, { workspaceId: "ws1", conversationId: m1.conversationId, key: "city", value: "طنجة", userId: "agent-7" });

    const audits = fieldAudits(db);
    expect(audits).toHaveLength(2);
    const first = audits.find((a) => a.metadata.afterValue === "الرباط");
    const second = audits.find((a) => a.metadata.afterValue === "طنجة");
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    // السجل الأول: أكادير ← الرباط.
    expect(first.metadata).toMatchObject({
      fieldName: "city",
      beforeValue: "أكادير",
      afterValue: "الرباط",
      customerId,
      scope: "intel",
    });
    expect(first.workspaceId).toBe("ws1");
    expect(first.userId).toBe("agent-7");
    expect(first.entityType).toBe("Customer");
    expect(first.entityId).toBe(customerId);
    expect(first.createdAt).toBeInstanceOf(Date);

    // السجل الثاني: الرباط ← طنجة (سجل جديد، لم يُستبدل الأول).
    expect(second.metadata).toMatchObject({
      fieldName: "city",
      beforeValue: "الرباط",
      afterValue: "طنجة",
      customerId,
    });
    expect(second.id).not.toBe(first.id);

    // القيمة النهائية على صف العميل.
    expect((db._stores.customer as any[])[0].city).toBe("طنجة");
  });

  it("لا ينشئ سجلًا إذا لم تتغير القيمة (تأكيد نفس القيمة)", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const m1 = await inbound(db);
    await extractCity(db, m1.messageId, "أكادير");

    // تأكيد نفس القيمة المستخرجة: الحالة تصير CONFIRMED لكن القيمة لم تتغير.
    await confirmIntelField(db as never, { workspaceId: "ws1", conversationId: m1.conversationId, key: "city", value: "أكادير", userId: "agent-7" });
    expect(fieldAudits(db)).toHaveLength(0);

    // تغيير فعلي = سجل واحد.
    await confirmIntelField(db as never, { workspaceId: "ws1", conversationId: m1.conversationId, key: "city", value: "الرباط", userId: "agent-7" });
    expect(fieldAudits(db)).toHaveLength(1);
  });

  it("إعادة استخراج قديمة لا تستبدل القيمة المؤكدة ولا تضيف سجلًا", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const m1 = await inbound(db);
    await extractCity(db, m1.messageId, "أكادير");
    await confirmIntelField(db as never, { workspaceId: "ws1", conversationId: m1.conversationId, key: "city", value: "الرباط", userId: "agent-7" });
    expect(fieldAudits(db)).toHaveLength(1);

    // نفس الرسالة القديمة تُعاد معالجتها بقيمة الاستخراج القديمة.
    await extractCity(db, m1.messageId, "أكادير");

    const intel = (db._stores.customerIntel as any[])[0];
    expect(intel.data.city).toBe("الرباط");
    expect(intel.fieldMeta.city.status).toBe("CONFIRMED");
    expect((db._stores.customer as any[])[0].city).toBe("الرباط");
    expect(fieldAudits(db)).toHaveLength(1);
  });

  it("فشل تسجيل التدقيق يلغي التصحيح وتحديث العميل (Transaction)", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const m1 = await inbound(db);
    await extractCity(db, m1.messageId, "أكادير");
    const before = { ...((db._stores.customer as any[])[0] as Record<string, unknown>) };

    breakFieldAudit(db);

    await expect(
      confirmIntelField(db as never, { workspaceId: "ws1", conversationId: m1.conversationId, key: "city", value: "الرباط", userId: "agent-7" })
    ).rejects.toThrow(/audit store down/i);

    // لا صف عميل محدّث، ولا لقطة استخراج محدّثة، ولا سجل.
    expect((db._stores.customer as any[])[0].city).toBe("أكادير");
    expect((db._stores.customer as any[])[0].updatedAt).toEqual(before.updatedAt);
    const intel = (db._stores.customerIntel as any[])[0];
    expect(intel.data.city).toBe("أكادير");
    expect(intel.fieldMeta.city.status).not.toBe("CONFIRMED");
    expect(fieldAudits(db)).toHaveLength(0);
  });

  it("العزل: مساحة أخرى لا تصحّح ولا تقرأ العميل", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const m1 = await inbound(db);
    await extractCity(db, m1.messageId, "أكادير");
    const customerId = (db._stores.customer as any[])[0].id;

    const denied = await confirmIntelField(db as never, {
      workspaceId: "ws-other",
      conversationId: m1.conversationId,
      key: "city",
      value: "الزرقاء",
      userId: "intruder",
    });
    expect(denied).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect((db._stores.customer as any[])[0].city).toBe("أكادير");
    expect(fieldAudits(db)).toHaveLength(0);

    await expect(
      getCustomerDetail(db as never, { userId: "intruder", workspaceId: "ws-other" }, customerId)
    ).rejects.toThrow();
  });

  it("محادثة بلا عميل مرتبط: السجل يُنسب للمحادثة لا لعميل وهمي", async () => {
    const db = createFakeDb() as FakeDb;
    db._stores.conversation.push({
      id: "conv-orphan",
      workspaceId: "ws1",
      channelId: "ch1",
      customerId: null,
      status: "OPEN",
      aiState: "ACTIVE",
    });
    db._stores.customerIntel.push({
      id: "intel-orphan",
      workspaceId: "ws1",
      conversationId: "conv-orphan",
      channelId: "ch1",
      status: "READY",
      data: { city: "أكادير" },
      fieldMeta: { city: { status: "EXTRACTED", sources: ["m1"] } },
      confidence: 0.9,
    });

    const res = await confirmIntelField(db as never, {
      workspaceId: "ws1",
      conversationId: "conv-orphan",
      key: "city",
      value: "الرباط",
      userId: "agent-7",
    });
    expect(res).toEqual({ ok: true });

    const audits = fieldAudits(db);
    expect(audits).toHaveLength(1);
    // لا عميل ⇒ لا نكتب سجلًا بنوع Customer بمعرّف محادثة (كان بيظهر بملف عميل غلط).
    expect(audits[0].entityType).toBe("Conversation");
    expect(audits[0].entityId).toBe("conv-orphan");
    expect(audits[0].metadata).toMatchObject({ fieldName: "city", beforeValue: "أكادير", afterValue: "الرباط" });
  });
});

describe("P15 — تعديل الأساسيات (Customer)", () => {
  function seedCustomer(db: FakeDb) {
    db._stores.customer.push({
      id: "cust-1",
      workspaceId: "ws1",
      name: "سامر",
      phone: null,
      city: "عمان",
      province: "عمان",
      address: null,
      notes: null,
      status: "NEW_LEAD",
      tags: [],
    });
  }

  it("يسجّل الحقول المتغيرة فقط بالترتيب قبل/بعد", async () => {
    const db = createFakeDb() as FakeDb;
    seedCustomer(db);

    await updateCustomer(db as never, { userId: "u1", workspaceId: "ws1" }, "cust-1", {
      name: "سامر الجديد",
      city: "عمان", // لم تتغير
    });

    const audits = fieldAudits(db);
    expect(audits).toHaveLength(1); // حقل واحد تغيّر فقط
    expect(audits[0].metadata).toMatchObject({
      fieldName: "name",
      beforeValue: "سامر",
      afterValue: "سامر الجديد",
      customerId: "cust-1",
      scope: "customer",
    });
    expect(audits[0].userId).toBe("u1");
    expect(audits[0].workspaceId).toBe("ws1");
    expect((db._stores.customer as any[])[0].name).toBe("سامر الجديد");
  });

  it("لا سجل إذا أُرسلت نفس القيم", async () => {
    const db = createFakeDb() as FakeDb;
    seedCustomer(db);

    await updateCustomer(db as never, { userId: "u1", workspaceId: "ws1" }, "cust-1", {
      name: "سامر",
      city: "عمان",
    });
    expect(fieldAudits(db)).toHaveLength(0);
  });

  it("فشل التدقيق يمنع تحديث Customer (rollback)", async () => {
    const db = createFakeDb() as FakeDb;
    seedCustomer(db);
    breakFieldAudit(db);

    await expect(
      updateCustomer(db as never, { userId: "u1", workspaceId: "ws1" }, "cust-1", { name: "اسم آخر" })
    ).rejects.toThrow(/audit store down/i);

    expect((db._stores.customer as any[])[0].name).toBe("سامر");
    expect(fieldAudits(db)).toHaveLength(0);
  });

  it("عرض السجل محصور بالمساحة + صلاحية القراءة", async () => {
    const db = createFakeDb() as FakeDb;
    seedCustomer(db);
    await updateCustomer(db as never, { userId: "u1", workspaceId: "ws1" }, "cust-1", { name: "سامر الجديد" });

    // سجل دخيل بنفس معرّف العميل لكن مساحة أخرى — لا يظهر.
    db._stores.auditLog.push({
      id: "audit-other",
      workspaceId: "ws2",
      userId: "u2",
      action: "customer.field_changed",
      entityType: "Customer",
      entityId: "cust-1",
      metadata: { fieldName: "name", beforeValue: "x", afterValue: "y" },
      createdAt: new Date(),
    });

    const detail: any = await getCustomerDetail(db as never, { userId: "u1", workspaceId: "ws1" }, "cust-1");
    expect(detail.fieldHistory).toHaveLength(1);
    expect(detail.fieldHistory[0].metadata).toMatchObject({ fieldName: "name", beforeValue: "سامر", afterValue: "سامر الجديد" });

    // الصلاحية: قراءة ملف العميل (ومنها السجل) لصاحب customers.read.
    expect(hasPermission("VIEWER", [], "customers.read")).toBe(true);
    expect(hasPermission("SALES_AGENT", [], "customers.read")).toBe(true);
    expect(hasPermission("MANAGER", [], "customers.read")).toBe(true);
  });
});
