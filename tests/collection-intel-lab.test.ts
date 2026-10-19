/**
 * مختبر التجميع — حارس «لا رد آلي إطلاقًا» + صحة الاستخراج + عزل المساحات.
 *
 * الاختبارات تثبت مسار الإرسال الفعلي (dispatchOutbound) وليس اختفاء زر:
 * Facebook Send API لا يُستدعى، ولا يُنشأ outbound، ولا يخرج شيء عند التكرار.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/inmemory-db";
import { processIncomingMessage } from "@/modules/conversations/service";
import { runJobs } from "@/modules/jobs/handlers";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { assertAutomatedSendAllowed } from "@/modules/channels/send-policy";
import { confirmIntelField, reanalyzeConversation, runCustomerIntelExtraction } from "@/modules/intelligence/service";
import { getExtractionProvider, openRouterChatUrl } from "@/modules/intelligence/provider";
import { AIProviderError } from "@/modules/ai/provider";

type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;

const originalFetch = global.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;
const originalBase = process.env.OPENROUTER_BASE_URL;

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
    sendMode: opts.sendMode ?? "COLLECTION_ONLY",
  });
}

function inbound(db: FakeDb, over: Record<string, unknown> = {}) {
  return processIncomingMessage(db as never, {
    workspaceId: "ws1",
    channelType: "FACEBOOK",
    channelId: "ch1",
    externalUserId: "psid-1",
    externalConversationId: "psid-1",
    externalMessageId: "mid-1",
    externalEventId: "evt-1",
    provider: "facebook",
    type: "TEXT",
    text: "مرحبا، اسمي أحمد، بدي ٢ عطر، تلفوني 0791234567",
    ...over,
  });
}

function fieldsFor(messageId: string, over: Record<string, unknown> = {}) {
  return {
    customerName: "أحمد",
    phone: "0791234567",
    city: null,
    address: null,
    products: ["عطر"],
    quantity: 2,
    budget: null,
    purchaseIntent: "high",
    needs: [],
    notes: [],
    confidence: 0.82,
    sourceMessageIds: [messageId],
    ...over,
  };
}

function graphCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("graph.facebook.com"));
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  delete process.env.OPENROUTER_BASE_URL;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  if (originalBase === undefined) delete process.env.OPENROUTER_BASE_URL;
  else process.env.OPENROUTER_BASE_URL = originalBase;
});

describe("COLLECTION_ONLY — لا رد آلي إطلاقًا", () => {
  it("يحفظ الرسالة ويصفّ تحليلًا داخليًا فقط (لا process_ai_message)", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db, { sendMode: "COLLECTION_ONLY" });

    const res = await inbound(db);
    expect(res.duplicate).toBe(false);

    const jobs = db._stores.backgroundJob as Array<Record<string, any>>;
    expect(jobs.map((j) => j.type)).toContain("extract_customer_intel");
    expect(jobs.map((j) => j.type)).not.toContain("process_ai_message");

    const messages = db._stores.message as Array<Record<string, any>>;
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe("INBOUND");
  });

  it("يستخرج المعلومات ثم يرفض الإرسال في نقطة الإرسال النهائية (بلا Send API)", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const { messageId, conversationId } = await inbound(db);

    const fetchMock = vi.fn(async () => completion(fieldsFor(messageId)));
    global.fetch = fetchMock as never;

    await runJobs(db as never, { limit: 10 });

    const runs = db._stores.customerIntelRun as Array<Record<string, any>>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("DONE");

    const intel = db._stores.customerIntel as Array<Record<string, any>>;
    expect(intel).toHaveLength(1);
    expect(intel[0].workspaceId).toBe("ws1");
    expect(intel[0].data.customerName).toBe("أحمد");
    expect(intel[0].data.phone).toBe("0791234567");
    expect(intel[0].data.quantity).toBe(2);
    expect(intel[0].fieldMeta.phone.sources).toContain(messageId);

    // الاستدعاء الوحيد كان لـ OpenRouter — ولا شيء لفيسبوك.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("openrouter.ai");
    expect(graphCalls(fetchMock)).toHaveLength(0);

    const before = (db._stores.message as Array<Record<string, any>>).length;
    const out = await dispatchOutbound(db as never, {
      workspaceId: "ws1",
      conversationId,
      sourceMessageId: messageId,
      text: "رد آلي يجب ألا يخرج",
    });
    expect(out.deliveryStatus).toBe("FAILED");
    expect(out.error).toContain("COLLECTION_ONLY");
    expect((db._stores.message as Array<Record<string, any>>).length).toBe(before);
    expect(graphCalls(fetchMock)).toHaveLength(0);
  });

  it("retry/تكرار الويب هوك لا ينتج ردًا ولا تحليلًا مكررًا", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const first = await inbound(db);
    const fetchMock = vi.fn(async () => completion(fieldsFor(first.messageId)));
    global.fetch = fetchMock as never;
    await runJobs(db as never, { limit: 10 });

    // نفس الحدث مرة ثانية → duplicate ولا job جديد.
    const again = await inbound(db);
    expect(again.duplicate).toBe(true);
    const jobs = (db._stores.backgroundJob as Array<Record<string, any>>).filter((j) => j.type === "extract_customer_intel");
    expect(jobs).toHaveLength(1);

    // تحليل مباشر ثانٍ لنفس الرسالة → DUPLICATE (مفتاح messageId).
    const dup = await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId: first.messageId });
    expect(dup.status).toBe("DUPLICATE");
    expect(db._stores.customerIntelRun).toHaveLength(1);

    // لا رسالة صادرة مهما تكرر.
    expect((db._stores.message as Array<Record<string, any>>).filter((m) => m.direction === "OUTBOUND")).toHaveLength(0);
  });

  it("الرد اليدوي البشري يبقى مسموحًا (السياسة تمنع الآلي فقط)", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const { conversationId } = await inbound(db);

    const human = await assertAutomatedSendAllowed(db as never, { workspaceId: "ws1", conversationId, senderType: "HUMAN" });
    expect(human.allowed).toBe(true);

    const auto = await assertAutomatedSendAllowed(db as never, { workspaceId: "ws1", conversationId, senderType: "AI" });
    expect(auto.allowed).toBe(false);
  });

  it("تعذّر التحقق من وضع الصفحة = رفض آمن", async () => {
    const db = createFakeDb() as FakeDb;
    // محادثة تشير لقناة غير موجودة (بيانات ناقصة).
    db._stores.conversation.push({ id: "cv-ghost", workspaceId: "ws1", customerId: "cu-x", channelId: "ghost", channelConversationId: "g1" });
    const out = await dispatchOutbound(db as never, {
      workspaceId: "ws1",
      conversationId: "cv-ghost",
      sourceMessageId: "m-x",
      text: "نص",
    });
    expect(out.deliveryStatus).toBe("FAILED");
    expect(out.error).toContain("SEND_MODE_UNKNOWN");
    expect((db._stores.message as Array<Record<string, any>>)).toHaveLength(0);
  });

  it("AUTO_REPLY لا يتغيّر سلوكه: process_ai_message يُصفّ والإرسال غير محجوب", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db, { sendMode: "AUTO_REPLY" });
    const { conversationId } = await inbound(db);

    const jobs = (db._stores.backgroundJob as Array<Record<string, any>>).map((j) => j.type);
    expect(jobs).toContain("process_ai_message");
    expect(jobs).not.toContain("extract_customer_intel");

    const policy = await assertAutomatedSendAllowed(db as never, { workspaceId: "ws1", conversationId, senderType: "AI" });
    expect(policy.allowed).toBe(true);
  });
});

describe("استخراج المعلومات — لا اختراع ولا تعارض صامت", () => {
  it("يُسقط أي قيمة غير موجودة حرفيًا في نص العميل", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const { messageId } = await inbound(db);

    global.fetch = vi.fn(async () =>
      completion(fieldsFor(messageId, { customerName: "سامر", phone: "0788888888", city: "دبي", budget: "50 دينار" }))
    ) as never;

    const out = await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId });
    expect(out.status).toBe("DONE");

    const intel = (db._stores.customerIntel as Array<Record<string, any>>)[0];
    expect(intel.data.customerName).toBeNull();
    expect(intel.data.phone).toBeNull();
    expect(intel.data.city).toBeNull();
    expect(intel.data.budget).toBeNull();
    expect(intel.data.products).toEqual(["عطر"]);
  });

  it("يسجّل التعارض بين رسالتين بدل اختيار قيمة عشوائية", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const first = await inbound(db, { text: "أنا ساكن بعمان وبدي عطر" });
    const second = await inbound(db, {
      text: "لا، أنا من إربد",
      externalMessageId: "mid-2",
      externalEventId: "evt-2",
    });

    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      const id = call === 1 ? first.messageId : second.messageId;
      return completion(
        fieldsFor(id, { city: call === 1 ? "عمان" : "إربد", customerName: null, phone: null, products: ["عطر"], quantity: null })
      );
    }) as never;

    await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId: first.messageId });
    await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId: second.messageId });

    const intel = (db._stores.customerIntel as Array<Record<string, any>>)[0];
    expect(intel.data.city).toBe("عمان"); // القيمة الأولى محفوظة
    expect(intel.fieldMeta.city.status).toBe("CONFLICT");
    expect(intel.fieldMeta.city.conflicts).toContain("إربد");
  });

  it("فشل المزوّد لا يفقد الرسالة، ويظهر، ويقبل إعادة التحليل", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const { messageId } = await inbound(db);

    global.fetch = vi.fn(async () => new Response("nope", { status: 401 })) as never;
    const failed = await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId });
    expect(failed.status).toBe("FAILED");
    if (failed.status === "FAILED") expect(failed.errorCode).toBe("AUTH_401");

    expect((db._stores.message as Array<Record<string, any>>).some((m) => m.id === messageId)).toBe(true);
    const intel = (db._stores.customerIntel as Array<Record<string, any>>)[0];
    expect(intel.status).toBe("FAILED");
    expect(intel.lastError).toBe("AUTH_401");
    expect((db._stores.message as Array<Record<string, any>>).filter((m) => m.direction === "OUTBOUND")).toHaveLength(0);

    // إعادة تحليل تنجح لاحقًا → الحالة READY ورسالة العميل كما هي.
    global.fetch = vi.fn(async () => completion(fieldsFor(messageId))) as never;
    const retry = await reanalyzeConversation(db as never, { workspaceId: "ws1", conversationId: intel.conversationId });
    expect(retry.status).toBe("DONE");
    const after = (db._stores.customerIntel as Array<Record<string, any>>)[0];
    expect(after.status).toBe("READY");
    expect(after.lastError).toBeNull();
    expect((db._stores.customerIntelRun as Array<Record<string, any>>)[0].status).toBe("DONE");
  });

  it("تأكيد الموظف يصير CONFIRMED ولا يُستبدل بتحليل لاحق", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const { messageId, conversationId } = await inbound(db);
    global.fetch = vi.fn(async () => completion(fieldsFor(messageId, { customerName: null }))) as never;
    await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId });

    const confirmed = await confirmIntelField(db as never, {
      workspaceId: "ws1",
      conversationId,
      key: "customerName",
      value: "أحمد علي",
      userId: "u1",
    });
    expect(confirmed.ok).toBe(true);

    await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId });
    const intel = (db._stores.customerIntel as Array<Record<string, any>>)[0];
    expect(intel.data.customerName).toBe("أحمد علي");
    expect(intel.fieldMeta.customerName.status).toBe("CONFIRMED");
  });
});

describe("العزل بين المساحات والصلاحيات", () => {
  it("مساحة أخرى لا تقرأ ولا تحلّل ولا تؤكد", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const { messageId, conversationId } = await inbound(db);
    global.fetch = vi.fn(async () => completion(fieldsFor(messageId))) as never;
    await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId });

    const other = await runCustomerIntelExtraction(db as never, { workspaceId: "ws-other", messageId });
    expect(other.status).toBe("SKIPPED");

    const confirm = await confirmIntelField(db as never, {
      workspaceId: "ws-other",
      conversationId,
      key: "phone",
      value: "0790000000",
      userId: "attacker",
    });
    expect(confirm.ok).toBe(false);
  });

  it("لا تحليل لصفحة في وضع AUTO_REPLY", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db, { sendMode: "AUTO_REPLY" });
    const { messageId } = await inbound(db);
    const res = await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId });
    expect(res.status).toBe("SKIPPED");
  });
});

describe("OpenRouter — الإعداد والأخطاء", () => {
  it("يطبّع العنوان إلى /chat/completions الرسمي", () => {
    expect(openRouterChatUrl(undefined)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(openRouterChatUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(openRouterChatUrl("https://openrouter.ai/api/v1/chat/completions")).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(openRouterChatUrl("https://my-gateway.local/v1")).toBe("https://my-gateway.local/v1/chat/completions");
  });

  it("غياب المفتاح = خطأ دائم واضح (ولا يُطبع أي مفتاح)", () => {
    delete process.env.OPENROUTER_API_KEY;
    try {
      getExtractionProvider();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AIProviderError);
      expect((err as AIProviderError).retryable).toBe(false);
      expect((err as Error).message).not.toContain("test-key");
    }
  });

  it("المزوّد يستخدم المتغيّر البيئي والنموذج القابل للضبط", () => {
    process.env.OPENROUTER_BASE_URL = "https://gateway.example/v1";
    process.env.INTEL_MODEL = "google/gemini-2.5-flash";
    const handle = getExtractionProvider();
    expect(handle.model).toBe("google/gemini-2.5-flash");
    expect((handle.provider as unknown as { endpointUrl: string }).endpointUrl).toBe("https://gateway.example/v1/chat/completions");
    delete process.env.INTEL_MODEL;
  });

  it("استجابة غير متوافقة تُرفض ولا تُحفظ كبيانات", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    const { messageId } = await inbound(db);
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "{\"unknownField\":true}" } }] }), { status: 200 })
    ) as never;

    const out = await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId });
    expect(out.status).toBe("FAILED");
    const intel = (db._stores.customerIntel as Array<Record<string, any>>)[0];
    expect(intel.status).toBe("FAILED");
    expect(intel.data.customerName ?? null).toBeNull();
  });
});

describe("Performance (mock — بلا شبكة)", () => {
  it("يقيس زمن الحفظ والتحليل ويحسب P50/P95", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    global.fetch = vi.fn(async () => completion(fieldsFor("x"))) as never;

    const save: number[] = [];
    const extract: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      const res = await inbound(db, {
        externalUserId: `psid-${i}`,
        externalConversationId: `psid-${i}`,
        externalMessageId: `mid-${i}`,
        externalEventId: `evt-${i}`,
        text: `رسالة ${i} بدي عطر`,
      });
      save.push(Date.now() - t0);
      const t1 = Date.now();
      const out = await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId: res.messageId });
      expect(out.status).toBe("DONE");
      extract.push(Date.now() - t1);
    }

    const p = (arr: number[], q: number) => {
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.ceil((q / 100) * s.length) - 1)];
    };
    const report = {
      saveP50: p(save, 50), saveP95: p(save, 95),
      extractP50: p(extract, 50), extractP95: p(extract, 95),
    };
    console.info("[intel-perf:mock]", JSON.stringify(report));
    expect(report.saveP95).toBeLessThan(2000);
    expect(report.extractP95).toBeLessThan(5000);
    expect(db._stores.customerIntelRun).toHaveLength(20);
    expect((db._stores.message as Array<Record<string, any>>).filter((m) => m.direction === "OUTBOUND")).toHaveLength(0);
  });
});
