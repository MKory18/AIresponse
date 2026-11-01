/**
 * P14 — استقلال مهمة الرد عن استخراج بيانات العميل + أمان الطلب/الموظف + ملف العميل.
 *
 * يثبت على مسار الكود الفعلي:
 *  - الرد يُرسل دون انتظار مهمة `extract_customer_intel` (والتي تبقى PENDING).
 *  - مزوّد الاستخراج لا يُنادى على مسار الرد إطلاقًا (استقلال كامل).
 *  - تأخير/فشل الاستخراج لا يؤخر ولا يمنع إرسال الرد، ولا يكرّر الإرسال.
 *  - استخراج بيانات العميل لا ينشئ طلبًا ولا مسودة ولا يغيّر سعرًا.
 *  - HUMAN_ACTIVE يمنع الرد الآلي (AI_DISABLED، بلا إرسال).
 *  - `getCustomerDetail` يقرأ المعلومات المحفوظة فعليًا (لا mock) ويعزل المساحة.
 *
 * ملاحظة معمارية: مرحلة `extraction` داخل خط أنابيب الرد = استخراج **نية/كيانات
 * الرسالة** لصياغة الرد. أما `extract_customer_intel` = استخراج **ملف العميل**
 * (اسم/رقم/مدينة…) كمهمة خلفية مستقلة. الاثنان مختلفان ولا يتسلسلان.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/inmemory-db";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { runJobs } from "@/modules/jobs/handlers";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";
import { getCustomerDetail } from "@/modules/customers/service";

type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;

const originalFetch = global.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;
const stubVector = { search: async () => [] } as never;

let db: FakeDb;

beforeEach(() => {
  db = createFakeDb() as FakeDb;
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  setMockAIProvider(undefined);
  setFacebookClientFactory(undefined as never);
  vi.restoreAllMocks();
});

function completion(fields: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(fields) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function fbSuccess() {
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string) => {
          const u = new URL(url);
          // يشمل /me/messages و /{pageId}/messages
          if (u.pathname.includes("/messages")) return Response.json({ recipient_id: "psid", message_id: `mid-${Date.now()}` });
          return Response.json({ id: "p", name: "p" });
        }) as typeof fetch,
      })
  );
}

function mockReply() {
  const mock = new MockAIProvider();
  mock.intentHandler = () => ({ intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER" });
  mock.responseHandler = () => "أهلاً فيك 🌹";
  setMockAIProvider(mock);
}

async function seedPage(workspaceId = "ws1", channelId = "ch1") {
  db._stores.channel.push({ id: channelId, workspaceId, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", sendMode: "AUTO_REPLY", externalId: "page-1" });
  db._stores.channelAccount.push({ id: "cacc-1", channelId, provider: "FACEBOOK", externalAccountId: "page-1", pageName: "صفحة", encryptedCredentials: encryptSecret("tok") });
}

function inbound(text: string, over: Record<string, unknown> = {}, workspaceId = "ws1", channelId = "ch1") {
  return processIncomingMessage(db as never, {
    workspaceId,
    channelType: "FACEBOOK",
    channelId,
    externalUserId: "psid-A",
    externalConversationId: "psid-A",
    externalMessageId: "mid-1",
    externalEventId: "evt-1",
    provider: "facebook",
    type: "TEXT",
    text,
    ...over,
  });
}

const intelJobs = (messageId: string) =>
  (db._stores.backgroundJob as any[]).filter((j) => j.type === "extract_customer_intel" && (j.payload as any)?.messageId === messageId);
const outboundRows = () => (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND");

describe("استقلال الرد عن استخراج بيانات العميل", () => {
  it("الرد يُرسل ومهمة الاستخراج مازالت PENDING (لا تسلسل)", async () => {
    await seedPage();
    fbSuccess();
    mockReply();
    const r = await inbound("شو مواصفات المنتج؟");
    expect(intelJobs(r.messageId)).toHaveLength(1);
    expect(intelJobs(r.messageId)[0].status).toBe("PENDING");

    const res = await processAIMessage(db as never, { workspaceId: "ws1", conversationId: r.conversationId, messageId: r.messageId }, { vectorStore: stubVector });
    expect(["RESPONDED", "CLARIFIED"]).toContain(res.status);
    expect(outboundRows()).toHaveLength(1); // الرد خرج
    expect(intelJobs(r.messageId)[0].status).toBe("PENDING"); // والاستخراج ما تشغّل لأجل الرد
  });

  it("مزوّد الاستخراج لا يُنادى على مسار الرد إطلاقًا", async () => {
    await seedPage();
    fbSuccess();
    mockReply();
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: any) => {
      calls.push(String(input));
      await new Promise((r) => setTimeout(r, 50));
      return completion({ customerName: "أحمد" });
    }) as never;

    const r = await inbound("شو مواصفات المنتج؟");
    await processAIMessage(db as never, { workspaceId: "ws1", conversationId: r.conversationId, messageId: r.messageId }, { vectorStore: stubVector });

    expect(outboundRows()).toHaveLength(1);
    expect(calls.some((u) => u.includes("openrouter.ai"))).toBe(false); // مسار الرد ما نادى مزوّد الاستخراج
  });

  it("runJobs يعالج الرد والاستخراج بنفس الدورة بلا إرسال مزدوج", async () => {
    await seedPage();
    fbSuccess();
    mockReply();
    global.fetch = vi.fn(async () => completion({ customerName: "أحمد", sourceMessageIds: [] })) as never;

    const r = await inbound("اسمي أحمد");
    const result = await runJobs(db as never);
    expect(result.processed).toBe(2);
    expect(outboundRows()).toHaveLength(1); // رد واحد فقط
    expect(intelJobs(r.messageId)[0].status).toBe("DONE");
  });

  it("فشل استخراج العميل لا يفقد الرد", async () => {
    await seedPage();
    fbSuccess();
    mockReply();
    global.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as never;

    const r = await inbound("اسمي أحمد");
    await runJobs(db as never);
    expect(outboundRows()).toHaveLength(1); // الرد وصل رغم فشل الاستخراج
    // مهمة الاستخراج فشلت (أعادها الطابور للمحاولة) — لكنها لم تُكمل ولم تؤثر على الرد.
    expect(intelJobs(r.messageId)[0].status).not.toBe("DONE");
  });

  it("تأخير متعمد للاستخراج: الرد يخرج قبل انتهائه ولا ينتظره", async () => {
    await seedPage();
    fbSuccess();
    mockReply();

    // مزوّد الاستخراج «بطيء» عن قصد (2 ثانية) — لو تسلسل الرد وراءه لبان في الزمن.
    // مزوّد الرد نفسه وهمي (MockAIProvider) فلا يلمس الشبكة.
    global.fetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return completion({ customerName: "أحمد", sourceMessageIds: [] });
    }) as never;

    const r = await inbound("شو مواصفات المنتج؟");
    const t0 = Date.now();
    const res = await processAIMessage(
      db as never,
      { workspaceId: "ws1", conversationId: r.conversationId, messageId: r.messageId },
      { vectorStore: stubVector }
    );
    const replyMs = Date.now() - t0;

    // الرد خرج فعلًا…
    expect(["RESPONDED", "CLARIFIED"]).toContain(res.status);
    expect(outboundRows()).toHaveLength(1);
    // …وفي زمن أقل بكثير من تأخير الاستخراج المتعمد (لا انتظار تسلسلي).
    expect(replyMs).toBeLessThan(1000);
    // ومهمة الاستخراج ما اتشغلت أساسًا خلال مسار الرد.
    expect(intelJobs(r.messageId)[0].status).toBe("PENDING");
  });

  it("الاستخراج البطيء لاحقًا لا ينتج إرسالًا مزدوجًا للرد", async () => {
    await seedPage();
    fbSuccess();
    mockReply();

    const r = await inbound("شو مواصفات المنتج؟");
    // الرد أولًا (وهمي، سريع).
    await processAIMessage(
      db as never,
      { workspaceId: "ws1", conversationId: r.conversationId, messageId: r.messageId },
      { vectorStore: stubVector }
    );
    expect(outboundRows()).toHaveLength(1);

    // ثم استخراج بطيء عبر الطابور — يجب ألا يضيف ردًا ثانيًا.
    global.fetch = vi.fn(async () => {
      await new Promise((res2) => setTimeout(res2, 800));
      return completion({ customerName: "أحمد", sourceMessageIds: [] });
    }) as never;
    await runJobs(db as never);

    expect(outboundRows()).toHaveLength(1); // لا إرسال مزدوج
    expect(intelJobs(r.messageId)[0].status).toBe("DONE");
  });
});

describe("أمان الطلب والسعر", () => {
  it("استخراج بيانات العميل لا ينشئ طلبًا ولا مسودة ولا يغيّر سعر المنتج", async () => {
    await seedPage();
    fbSuccess();
    mockReply();
    db._stores.product.push({ id: "pr-1", workspaceId: "ws1", name: "منتج", currentPrice: "100", currency: "SYP", stockStatus: "IN_STOCK" });

    const r = await inbound("بدي ٢ من منتج");
    global.fetch = vi.fn(async () => completion({ products: ["منتج"], quantity: 2, purchaseIntent: "high", sourceMessageIds: [r.messageId] })) as never;
    await runJobs(db as never);

    expect(db._stores.order).toHaveLength(0); // لا طلب مؤكد
    expect(db._stores.orderDraft).toHaveLength(0); // لا مسودة من مهمة الاستخراج
    expect((db._stores.product as any[])[0].currentPrice).toBe("100"); // السعر ما اتغيّر
    // والاستخراج نفسه نجح (بلا إنشاء طلب).
    expect(intelJobs(r.messageId)[0].status).toBe("DONE");
  });
});

describe("حماية الموظف", () => {
  it("HUMAN_ACTIVE يمنع الرد الآلي (AI_DISABLED، بلا إرسال)", async () => {
    await seedPage();
    fbSuccess();
    mockReply();
    const r = await inbound("مرحبا");
    await db.conversation.update({ where: { id: r.conversationId }, data: { aiState: "HUMAN_ACTIVE" } } as never);

    const res = await processAIMessage(db as never, { workspaceId: "ws1", conversationId: r.conversationId, messageId: r.messageId }, { vectorStore: stubVector });
    expect(res.status).toBe("AI_DISABLED");
    expect(outboundRows()).toHaveLength(0);
  });
});

describe("ملف العميل يقرأ البيانات المحفوظة فعليًا", () => {
  it("يرجّع الأساسيات + معلومات الاستخراج بمصدر كل معلومة، ويعزل المساحة", async () => {
    db._stores.customer.push({ id: "cu-1", workspaceId: "ws1", name: "أحمد", phone: "0612345678", city: "أكادير", province: "سوس", address: null, notes: null, status: "NEW_LEAD", tags: [], createdAt: new Date(), lastContactAt: new Date() });
    db._stores.conversation.push({ id: "cv-1", workspaceId: "ws1", customerId: "cu-1", channelId: "ch1", channelConversationId: "c1", status: "OPEN", aiState: "AI_ACTIVE", updatedAt: new Date() });
    db._stores.customerIntel.push({
      id: "ci-1", workspaceId: "ws1", conversationId: "cv-1", channelId: "ch1", status: "READY",
      data: { customerName: "أحمد", phone: "0612345678", products: ["ماء الكمأة"], quantity: 2, purchaseIntent: "high" },
      fieldMeta: {
        phone: { status: "CONFIRMED", sources: ["m-9"] },
        products: { status: "EXTRACTED", sources: ["m-3"] },
        quantity: { status: "EXTRACTED", sources: ["m-3"] },
      },
      confidence: 0.9, attempts: 1,
    });

    const detail = await getCustomerDetail(db as never, { userId: "u1", workspaceId: "ws1" }, "cu-1");
    expect(detail.name).toBe("أحمد");
    expect(detail.city).toBe("أكادير");
    expect(detail.intel).toHaveLength(1);
    const snap = (detail.intel as any[])[0];
    expect(snap.data.products).toEqual(["ماء الكمأة"]);
    expect(snap.fieldMeta.phone).toMatchObject({ status: "CONFIRMED", sources: ["m-9"] });

    // عزل المساحة: نفس المعرّف من مساحة أخرى = غير موجود.
    await expect(getCustomerDetail(db as never, { userId: "u2", workspaceId: "ws-other" }, "cu-1")).rejects.toThrow();
  });
});
