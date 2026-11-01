/**
 * P14 — تدقيق التصحيح اليدوي وعرض بيانات العميل (قراءة فقط، بلا تغيير ميزات).
 *
 * يثبت على مسار الكود الفعلي:
 *  - تصحيح الموظف للمدينة يُحفظ في CustomerIntel.data.city **وفي صف العميل**
 *    (ليس تغيير واجهة فقط)، ويُعلَّم CONFIRMED.
 *  - مصدر التعديل محفوظ: `reviewedBy` (معرّف الموظف) + `reviewedAt`.
 *  - إعادة استخراج رسالة قديمة لا تستبدل القيمة المؤكدة يدويًا.
 *  - عرض ملف العميل يرجّع الأساسيات + المنتجات + الاحتياجات + مصادر كل معلومة.
 *  - العزل: مساحة أخرى لا تقرأ العميل.
 *
 * ملاحظة تدقيق: **القيمة السابقة لا تُحفظ** — `confirmField` يستبدل القيمة،
 * وسجل التدقيق (`customer.intel_synced`) يسجّل أسماء الحقول فقط بلا القيمة
 * القديمة/الجديدة. هذا مقيّد وموثّق في تقرير التدقيق (لا يُصلَح هنا).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/inmemory-db";
import { processIncomingMessage } from "@/modules/conversations/service";
import { confirmIntelField, runCustomerIntelExtraction } from "@/modules/intelligence/service";
import { getCustomerDetail } from "@/modules/customers/service";

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

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
});
afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe("التصحيح اليدوي للمدينة", () => {
  it("تصحيح أكادير→الرباط يُحفظ في صف العميل ويُعلَّم CONFIRMED مع مصدر التعديل", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const m1 = await inbound(db);
    await extractCity(db, m1.messageId, "أكادير");

    // قبل التصحيح: المدينة المستخرجة.
    let customer = (db._stores.customer as any[])[0];
    expect(customer.city).toBe("أكادير");

    const res = await confirmIntelField(db as never, {
      workspaceId: "ws1",
      conversationId: m1.conversationId,
      key: "city",
      value: "الرباط",
      userId: "agent-7",
    });
    expect(res.ok).toBe(true);

    // (أ) محفوظ في لقطة الاستخراج + CONFIRMED.
    const intel = (db._stores.customerIntel as any[])[0];
    expect(intel.data.city).toBe("الرباط");
    expect(intel.fieldMeta.city.status).toBe("CONFIRMED");
    // مصدر التعديل: من عدّل + متى (على الصف).
    expect(intel.reviewedBy).toBe("agent-7");
    expect(intel.reviewedAt).toBeTruthy();

    // (ب) محفوظ في صف العميل نفسه (ليس تغيير واجهة فقط) → يظهر عند إعادة التحميل.
    customer = (db._stores.customer as any[])[0];
    expect(customer.city).toBe("الرباط");
    const detail = await getCustomerDetail(db as never, { userId: "agent-7", workspaceId: "ws1" }, customer.id);
    expect(detail.city).toBe("الرباط");
    expect((detail.intel as any[])[0].fieldMeta.city.status).toBe("CONFIRMED");
  });

  it("إعادة استخراج رسالة قديمة لا تستبدل التصحيح اليدوي", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const m1 = await inbound(db);
    await extractCity(db, m1.messageId, "أكادير");
    await confirmIntelField(db as never, { workspaceId: "ws1", conversationId: m1.conversationId, key: "city", value: "الرباط", userId: "agent-7" });

    // إعادة معالجة نفس الرسالة بقيمة الاستخراج القديمة.
    await extractCity(db, m1.messageId, "أكادير");

    const intel = (db._stores.customerIntel as any[])[0];
    expect(intel.data.city).toBe("الرباط"); // التصحيح اليدوي محفوظ
    expect(intel.fieldMeta.city.status).toBe("CONFIRMED");
    expect((db._stores.customer as any[])[0].city).toBe("الرباط");
  });

  it("تدقيق: القيمة السابقة لا تُحفظ بعد التصحيح (مقيّد موثّق)", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const m1 = await inbound(db);
    await extractCity(db, m1.messageId, "أكادير");
    await confirmIntelField(db as never, { workspaceId: "ws1", conversationId: m1.conversationId, key: "city", value: "الرباط", userId: "agent-7" });

    const intel = (db._stores.customerIntel as any[])[0];
    // لا يوجد حقل للقيمة السابقة في meta.
    expect(intel.fieldMeta.city.previousValue).toBeUndefined();
    // وسجل التدقيق يسجّل أسماء الحقول فقط بلا القيمة القديمة/الجديدة.
    const audits = (db._stores.auditLog as any[]).filter((a) => a.action === "customer.intel_synced");
    const hasValues = audits.some((a) => JSON.stringify(a.metadata ?? {}).includes("أكادير") || JSON.stringify(a.metadata ?? {}).includes("الرباط"));
    expect(hasValues).toBe(false);
  });
});

describe("عرض بيانات العميل", () => {
  it("يرجّع الأساسيات + المنتجات/الاحتياجات + مصادر كل معلومة + المحادثات، ويعزل المساحة", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const m1 = await inbound(db, { text: "مرحبا اسمي أحمد من الرباط حي النخيل بدي عطر بكم؟ مستعجل تلفوني 0612345678" });

    global.fetch = vi.fn(async () =>
      completion({ customerName: "أحمد", phone: "0612345678", city: "الرباط", province: "الرباط-سلا", address: "حي النخيل", products: ["عطر"], needs: ["بكم؟"], notes: ["مستعجل"], confidence: 0.9, sourceMessageIds: [m1.messageId] })
    ) as never;
    await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId: m1.messageId });

    const customer = (db._stores.customer as any[])[0];
    const detail: any = await getCustomerDetail(db as never, { userId: "u1", workspaceId: "ws1" }, customer.id);

    // الأساسيات.
    expect(detail.name).toBe("أحمد");
    expect(detail.phone).toBe("0612345678");
    expect(detail.city).toBe("الرباط");
    // المنتجات/الاحتياجات/الملاحظات من لقطة الاستخراج.
    const snap = detail.intel[0];
    expect(snap.data.products).toEqual(["عطر"]);
    expect(snap.data.needs).toEqual(["بكم؟"]);
    expect(snap.data.notes).toEqual(["مستعجل"]);
    // مصدر كل معلومة (معرّف الرسالة).
    expect(snap.fieldMeta.phone.sources).toContain(m1.messageId);
    // المحادثات المرتبطة.
    expect(detail.conversations.length).toBeGreaterThan(0);

    // العزل: مساحة أخرى لا تقرأ.
    await expect(getCustomerDetail(db as never, { userId: "u2", workspaceId: "ws-other" }, customer.id)).rejects.toThrow();
  });
});
