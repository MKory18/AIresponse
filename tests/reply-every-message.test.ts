/**
 * كل رسالة زبون لازم يطلعلها رد — مسار كامل بالذاكرة:
 * ويب هوك ميتا (ingestMetaWebhook) ← مهام الخلفية بنفس طريقة scripts/worker.ts
 * (runJobs · sameCycle · كنس كل 10 دورات) ← خط الذكاء بمزوّد وهمي بيرجع JSON
 * واقعي ← إرسال لفيسبوك وهمي.
 *
 * الوقت: Date بس مزيّف (المؤقتات حقيقية) — كل دورة عامل = 500ms محاكاة،
 * فالتأجيل والتراجع (30s · 60s …) بيتحسبوا بلا انتظار حقيقي.
 *
 * ⚠️ قاعدة بالذاكرة ومزوّد/فيسبوك وهميين — سلوك، مش زمن إنتاج.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { ingestMetaWebhook } from "@/modules/channels/facebook/webhook";
import { runJobs } from "@/modules/jobs/handlers";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;

const WS = "ws-every-msg";
const PAGE = "page-every";
const PSID = "psid-every";
const AGENT = { userId: "agent-every", workspaceId: WS };
const PRODUCT = "كريم الكمأة";
const PRICE = 25000;

/** النص الحقيقي للزبون من داخل غلاف المحتوى غير الموثوق. */
function customerTextOf(user: string): string {
  const m = user.match(/\[UNTRUSTED_CUSTOMER_CONTENT\]([\s\S]*?)\[\/UNTRUSTED_CUSTOMER_CONTENT\]/);
  const inner = (m ? m[1] : user).trim();
  // آخر سطر = الرسالة الحالية (السجل قبلها).
  const lines = inner.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? inner;
}

/**
 * موديل واقعي: الاستخراج بيرجع JSON زي ما بيرجع موديل حقيقي (المنتج بس إذا
 * انذكر بالرسالة نفسها)، والرد بيذكر السعر الرسمي من البيانات الموثوقة —
 * أو من السجل إذا ما في منتج بالسياق (موديل حقيقي بيقرأ ردّه السابق).
 */
function realisticModel(opts: { productFromHistory?: boolean } = {}) {
  const mock = new MockAIProvider();
  mock.intentHandler = (user: string) => {
    const t = customerTextOf(user);
    const namesProduct = t.includes("كريم") || (opts.productFromHistory && user.includes(PRODUCT));
    const entities: Record<string, unknown> = {};
    if (namesProduct) entities.product = PRODUCT;
    const qty = t.match(/بدي\s*(\d+)/);
    if (qty) entities.quantity = Number(qty[1]);
    if (/اطلب|أطلب|بدي\s*\d/.test(t)) {
      return { intent: "ORDER_CREATE", confidence: 0.9, entities, missingFields: ["phone", "address"], memories: [], requestedAction: "CREATE_ORDER" };
    }
    if (/سعر|قديش|بكم/.test(t)) {
      return { intent: "PRICE_QUESTION", confidence: 0.9, entities, missingFields: [], memories: [], requestedAction: "ANSWER" };
    }
    return { intent: "PRODUCT_QUESTION", confidence: 0.85, entities, missingFields: [], memories: [], requestedAction: "ANSWER" };
  };
  mock.responseHandler = (user: string, system: string) => {
    const t = customerTextOf(user);
    const trusted = system.match(/السعر الرسمي: ([^\n]+)/);
    const priceText = trusted ? trusted[1].trim() : user.includes(String(PRICE)) ? `${PRICE} ل.س` : null;
    if (/سعر|قديش|بكم/.test(t) && priceText) return `سعر ${PRODUCT} ${priceText} 🌹`;
    if (/بدي\s*(\d+)/.test(t) && priceText) return `تمام، ${t.match(/بدي\s*(\d+)/)![1]} حبات، سعر الحبة ${priceText}. بعتلي رقمك وعنوانك 🌹`;
    if (/اطلب|أطلب/.test(t)) return priceText ? `أكيد! السعر ${priceText}. بعتلي اسمك ورقمك وعنوانك 🌹` : "أكيد! بعتلي اسمك ورقمك وعنوانك 🌹";
    if (t.includes("كريم")) return `${PRODUCT} مرطّب طبيعي، متوفر عنا 🌹`;
    return "أهلين فيك! كيف فيني ساعدك؟ 🌹";
  };
  setMockAIProvider(mock);
  return mock;
}

async function seed(db: FakeDb) {
  const product = (await createProduct(db as unknown as Db, AGENT, {
    name: PRODUCT,
    sku: "KM-1",
    price: PRICE,
    currency: "SYP",
  })) as { id: string };
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", externalId: PAGE, sendMode: "AUTO_REPLY" },
  } as never)) as { id: string };
  await db.channelAccount.create({
    data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: PAGE, pageName: "صفحة", encryptedCredentials: encryptSecret("tok-every") },
  } as never);
  const catalog = (await db.catalog.create({ data: { workspaceId: WS, name: "كتالوج", isActive: true } } as never)) as { id: string };
  await db.catalogPageAssignment.create({ data: { workspaceId: WS, catalogId: catalog.id, channelId: ch.id } } as never);
  await db.catalogProduct.create({ data: { catalogId: catalog.id, productId: product.id } } as never);
  await db.aISettings.create({
    data: { workspaceId: WS, provider: "mock", temperature: 0.4, maxTokens: 500, aiEnabled: true, autoRespond: true },
  } as never);
  return { product, ch };
}

/** فيسبوك وهمي: كل إرسال ناجح، ومنسجّل النص. */
function fakeFacebook(sent: string[]) {
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: RequestInit) => {
          const u = new URL(url);
          if (u.pathname.includes("/messages")) {
            const body = JSON.parse(String(init?.body ?? "{}"));
            sent.push(body?.message?.text ?? "[media]");
            return Response.json({ recipient_id: PSID, message_id: `out-${sent.length}` });
          }
          return Response.json({ id: PSID, name: "زبون" });
        }) as typeof fetch,
      })
  );
}

let midSeq = 0;
async function customerSays(db: FakeDb, text: string) {
  midSeq += 1;
  const res = await ingestMetaWebhook(db as unknown as Db, {
    object: "page",
    entry: [
      {
        id: PAGE,
        time: Date.now(),
        messaging: [
          { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: `m-${midSeq}`, text } },
        ],
      },
    ],
  });
  expect(res.status).toBe("OK");
  // الرسائل الحقيقية مش بنفس الميلي ثانية.
  vi.setSystemTime(Date.now() + 50);
}

let cycle = 0;
/** دورة عامل زي scripts/worker.ts بالضبط، وبعدها 500ms محاكاة. */
async function workerTick(db: FakeDb) {
  await runJobs(db as unknown as Db, { limit: 50, workerId: "w-test", sameCycle: true, maintenance: cycle % 10 === 0 });
  cycle += 1;
  vi.setSystemTime(Date.now() + 500);
}

function inboundRows(db: FakeDb) {
  return (db._stores.message as any[]).filter((m) => m.direction === "INBOUND");
}
function aiReplies(db: FakeDb) {
  return (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND" && m.senderType === "AI");
}
function responseLogs(db: FakeDb) {
  return (db._stores.aIUsageLog as any[]).filter((l) => l.purpose === "RESPONSE");
}

/** شغّل العامل لحد ما كل رسالة يطلعلها رد — أو تخلص المهلة المحاكاة. */
async function drainUntilAllAnswered(db: FakeDb, maxSimulatedMs = 20_000, done?: () => boolean) {
  const start = Date.now();
  while (Date.now() - start < maxSimulatedMs) {
    await workerTick(db);
    if (done ? done() : aiReplies(db).length >= inboundRows(db).length) break;
  }
  return Date.now() - start;
}

/** لكل رسالة زبون: انرد عليها؟ وإذا لا، شو آخر حالة/خطأ بسجل الاستخدام. */
function diagnose(db: FakeDb) {
  const replies = aiReplies(db);
  return inboundRows(db).map((m) => {
    const reply = replies.find((r) => String(r.outboundIdempotencyKey ?? "").endsWith(`:${m.id}`));
    const logs = responseLogs(db).filter((l) => l.messageId === m.id);
    const job = (db._stores.backgroundJob as any[]).find((j) => j.idempotencyKey === `ai:${m.id}`);
    return {
      text: m.text,
      replied: !!reply,
      reply: reply?.text ?? null,
      statuses: logs.map((l) => `${l.status}${l.error ? `:${l.error}` : ""}`),
      job: job ? `${job.status}#${job.attempts}${job.lastError ? `:${job.lastError}` : ""}` : "none",
    };
  });
}

let sent: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
  cycle = 0;
  sent = [];
  fakeFacebook(sent);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setMockAIProvider(undefined);
  setFacebookClientFactory(undefined as never);
});

describe("كل رسالة زبون بيطلعلها رد (مسار ويب هوك ← عامل ← ذكاء ← فيسبوك)", () => {
  it("(أ) تلات رسائل، كل وحدة بعد ما يوصل رد اللي قبلها", async () => {
    const db = createFakeDb() as FakeDb;
    realisticModel();
    await seed(db);
    for (const text of ["مرحبا", `شو هو ${PRODUCT}؟`, "متوفر عندكم؟"]) {
      await customerSays(db, text);
      await drainUntilAllAnswered(db);
    }
    expect(diagnose(db)).toEqual(diagnose(db).map((d) => ({ ...d, replied: true })));
    expect(aiReplies(db)).toHaveLength(3);
  });

  it("(ب) تلات رسائل ورا بعض قبل أي رد", async () => {
    const db = createFakeDb() as FakeDb;
    realisticModel();
    await seed(db);
    await customerSays(db, "مرحبا");
    await customerSays(db, `بدي اسأل عن ${PRODUCT}`);
    await customerSays(db, "متوفر؟");
    await drainUntilAllAnswered(db);
    expect(diagnose(db).filter((d) => !d.replied)).toEqual([]);
  });

  it("(ج) رسالة فيها سعر أو كمية: «قديش سعره» · «بدي 2»", async () => {
    const db = createFakeDb() as FakeDb;
    realisticModel();
    await seed(db);
    await customerSays(db, `مرحبا، عندكم ${PRODUCT}؟`);
    await drainUntilAllAnswered(db);
    await customerSays(db, "قديش سعره");
    await drainUntilAllAnswered(db);
    await customerSays(db, "بدي 2");
    await drainUntilAllAnswered(db);
    expect(diagnose(db).filter((d) => !d.replied)).toEqual([]);
  });

  it("(د) متابعة بعد رد ذكر السعر", async () => {
    const db = createFakeDb() as FakeDb;
    realisticModel();
    await seed(db);
    await customerSays(db, `قديش سعر ${PRODUCT}؟`);
    await drainUntilAllAnswered(db);
    expect(sent.join("\n")).toContain(String(PRICE));
    await customerSays(db, "طيب ومتوفر هلق؟");
    await drainUntilAllAnswered(db);
    await customerSays(db, "قديش سعره");
    await drainUntilAllAnswered(db);
    expect(diagnose(db).filter((d) => !d.replied)).toEqual([]);
  });

  it("(هـ) تحية ← سؤال عن المنتج ← «تمام بدي اطلب»", async () => {
    const db = createFakeDb() as FakeDb;
    realisticModel();
    await seed(db);
    await customerSays(db, "مرحبا");
    await drainUntilAllAnswered(db);
    await customerSays(db, `قديش سعر ${PRODUCT}؟`);
    await drainUntilAllAnswered(db);
    await customerSays(db, "تمام بدي اطلب");
    await drainUntilAllAnswered(db);
    expect(diagnose(db).filter((d) => !d.replied)).toEqual([]);
  });
});

describe("رد ما بينفع ينبعت لرسالة وحدة ما بيسكّت باقي المحادثة", () => {
  /** نفس الموديل، بس بيخترع سعر غلط لما الزبون يسأل عن «الجملة» — كل مرة. */
  function modelThatInventsWholesalePrice() {
    const mock = realisticModel();
    const base = mock.responseHandler!;
    mock.responseHandler = (user, system) =>
      customerTextOf(user).includes("الجملة") ? "سعر الجملة 99 ل.س بس 🌹" : base(user, system);
    return mock;
  }

  it("رفض الحارس بعد إعادة التوليد: الرسالة بتنسجّل AI_FAILED، والرسالة اللي بعدها بتنرد عليها فورًا", async () => {
    const db = createFakeDb() as FakeDb;
    modelThatInventsWholesalePrice();
    await seed(db);
    await customerSays(db, `عندكم ${PRODUCT}؟`);
    await drainUntilAllAnswered(db);
    await customerSays(db, "وسعر الجملة؟");
    await workerTick(db);
    await customerSays(db, "طيب متوفر؟");
    const waited = await drainUntilAllAnswered(db, 5_000, () => diagnose(db)[2]?.replied === true);

    const d = diagnose(db);
    // الرسالة اللي ما انكتبلها رد آمن: سبب واضح ومرئي، ومهمتها بتنعاد بالخلفية.
    expect(d[1].replied).toBe(false);
    expect(d[1].statuses.join(" ")).toContain("AI_FAILED:TRANSIENT: Guardrail violations persist after retry: PRICE_MISMATCH");
    expect(sent.join("\n")).not.toContain("99");
    // والرسالة الجاية ما بتستنى تراجع الرسالة الفاشلة (30s · 60s …).
    expect(d[2].replied).toBe(true);
    expect(waited).toBeLessThan(5_000);
  });

  it("إعادة التوليد بتصير على الموديل اللي ردّ فعلًا (الاحتياطي بعد عطل الأساسي)", async () => {
    const db = createFakeDb() as FakeDb;
    await seed(db);
    await db.aISettings.updateMany({
      where: { workspaceId: WS },
      data: { responseModel: "primary-model", fallbackModel: "backup-model" },
    } as never);
    const models: string[] = [];
    class PrimaryDownProvider extends MockAIProvider {
      override async generateText(req: Parameters<MockAIProvider["generateText"]>[0]) {
        models.push(req.model ?? "");
        if (req.model === "primary-model") {
          const { AIProviderError } = await import("@/modules/ai/provider");
          throw new AIProviderError("primary down", { retryable: true });
        }
        // أول رد فيه سعر مخترع، والتصحيح سليم.
        return { text: models.length <= 3 ? "سعره 99 ل.س" : `سعر ${PRODUCT} ${PRICE} ل.س 🌹`, promptTokens: 1, completionTokens: 1, latencyMs: 1 };
      }
    }
    const mock = new PrimaryDownProvider();
    mock.intentHandler = realisticModel().intentHandler;
    setMockAIProvider(mock);

    await customerSays(db, `قديش سعر ${PRODUCT}؟`);
    await drainUntilAllAnswered(db, 5_000);

    expect(models).toEqual(["primary-model", "primary-model", "backup-model", "backup-model"]);
    expect(diagnose(db)[0].replied).toBe(true);
    expect(sent.join("\n")).toContain(String(PRICE));
  });

  it("عطل بحث المستندات (الترميز) ما بيوقف الرد ولا بيرجّع المهمة 30 ثانية", async () => {
    // مساحة بمستندات: مخزن المتجهات مش فاضي، فالرد بيرمّز سؤال الزبون.
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z")); // ذاكرة المخزن (60s) ما بتنطبق
    const db = createFakeDb() as FakeDb;
    realisticModel();
    await seed(db);
    const { HashEmbeddingProvider } = await import("@/modules/knowledge/embeddings");
    const hash = new HashEmbeddingProvider();
    const doc = (await db.knowledgeDocument.create({
      data: { workspaceId: WS, title: "سياسة", content: "التوصيل خلال يومين", category: "POLICY", status: "READY" },
    } as never)) as { id: string };
    await db.knowledgeChunk.create({
      data: {
        documentId: doc.id,
        workspaceId: WS,
        content: "التوصيل خلال يومين",
        chunkIndex: 0,
        tokenCount: 4,
        metadata: {},
        embedding: JSON.stringify(await hash.embed("التوصيل خلال يومين")),
        isActive: true,
        embeddingProvider: hash.provider,
        embeddingModel: hash.model,
        embeddingDimensions: hash.dimensions,
      },
    } as never);
    const embed = vi.spyOn(HashEmbeddingProvider.prototype, "embed").mockRejectedValue(new Error("embedding timeout"));

    // أول رسالة بتحمّل المخزن (أو بتاخد نسخة قديمة وبتحدّثها بالخلفية).
    await customerSays(db, "مرحبا");
    await drainUntilAllAnswered(db, 5_000);
    await customerSays(db, `عندكم ${PRODUCT}؟`);
    await drainUntilAllAnswered(db, 5_000);

    expect(embed).toHaveBeenCalled();
    expect(diagnose(db).map((d) => d.replied)).toEqual([true, true]);
  });

  it("نداء الترميز الخارجي إله مهلة (ما بيعلّق الرد لحد مهلة المهمة 120s)", async () => {
    vi.useRealTimers();
    const { resetEnvCache } = await import("@/core/env");
    const { OpenAIEmbeddingProvider } = await import("@/modules/knowledge/embeddings");
    const saved = { ...process.env };
    process.env.OPENAI_API_KEY = "test-key-not-real";
    process.env.AI_ALLOW_EXTERNAL_EMBEDDINGS = "1";
    process.env.EMBEDDING_TIMEOUT_MS = "50";
    resetEnvCache();
    // سيرفر ما بيرد أبدًا — بس بيحترم الإلغاء.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    try {
      const started = Date.now();
      const outcome = await Promise.race([
        new OpenAIEmbeddingProvider().embed("سؤال").then(() => "resolved", () => "rejected"),
        new Promise((r) => setTimeout(() => r("hung"), 1_000)),
      ]);
      expect(outcome).toBe("rejected");
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  });

  it("تحديث مخزن المستندات كل دقيقة ما بيوقّف الرد (بيتحدّث بالخلفية)", async () => {
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
    const db = createFakeDb() as FakeDb;
    realisticModel();
    await seed(db);
    await customerSays(db, "مرحبا");
    await drainUntilAllAnswered(db, 5_000);
    expect(aiReplies(db)).toHaveLength(1);

    // بعد دقيقة: قراءة المستندات بطيئة (1000 متجه + JSON.parse بالإنتاج).
    vi.setSystemTime(Date.now() + 61_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = db.knowledgeChunk.findMany.bind(db.knowledgeChunk);
    let reloads = 0;
    db.knowledgeChunk.findMany = async (args: unknown) => {
      reloads += 1;
      await gate;
      return original(args);
    };
    await customerSays(db, `عندكم ${PRODUCT}؟`);
    const tick = workerTick(db);
    try {
      await vi.waitFor(() => expect(aiReplies(db)).toHaveLength(2), { timeout: 1_500, interval: 20 });
      expect(reloads).toBe(1);
    } finally {
      release();
      await tick;
    }
  });

  it("إعادة رسالة فاشلة بعد ما انرد على رسالة أحدث: ما في رد متأخر، المهمة بتخلص، والكنس ما بيرجّعها", async () => {
    const db = createFakeDb() as FakeDb;
    modelThatInventsWholesalePrice();
    await seed(db);
    await customerSays(db, `عندكم ${PRODUCT}؟ وسعر الجملة؟`);
    await workerTick(db);
    await customerSays(db, "طيب متوفر؟");
    await drainUntilAllAnswered(db, 5_000, () => diagnose(db)[1]?.replied === true);
    expect(diagnose(db).map((d) => d.replied)).toEqual([false, true]);

    // الموديل صار بيرد صح — بس الرسالة الأقدم انغطّت بالرد الأحدث.
    realisticModel();
    const sentBefore = sent.length;
    vi.setSystemTime(Date.now() + 31_000); // تراجع إعادة المهمة (30s) خلص
    for (let i = 0; i < 4; i++) await workerTick(db);

    const first = inboundRows(db)[0];
    const d = diagnose(db);
    expect(d[0].replied).toBe(false);
    expect(sent.length).toBe(sentBefore);
    expect(d[0].statuses.at(-1)).toBe(`SKIPPED:SUPERSEDED_BY:${inboundRows(db)[1].id}`);
    expect(d[0].job.startsWith("DONE#2")).toBe(true);

    // الكنس (كل 10 دورات) على مدى ساعات: ولا مهمة جديدة للرسالة الأقدم.
    for (let h = 0; h < 6; h++) {
      vi.setSystemTime(Date.now() + 3_600_000);
      for (let i = 0; i < 10; i++) await workerTick(db);
    }
    const jobs = (db._stores.backgroundJob as any[]).filter((j) => j.idempotencyKey === `ai:${first.id}`);
    expect(jobs).toHaveLength(1);
    expect(sent.length).toBe(sentBefore);
  });

  it("إعادة رسالة فاشلة وما في رسالة أحدث انرد عليها: الإعادة بترد زي قبل", async () => {
    const db = createFakeDb() as FakeDb;
    modelThatInventsWholesalePrice();
    await seed(db);
    await customerSays(db, `عندكم ${PRODUCT}؟ وسعر الجملة؟`);
    await workerTick(db);
    expect(diagnose(db)[0].replied).toBe(false);
    realisticModel();
    vi.setSystemTime(Date.now() + 31_000);
    await drainUntilAllAnswered(db, 5_000);
    expect(diagnose(db)[0].replied).toBe(true);
  });

  it("نفس الشي لما الرسائل توصل ورا بعض قبل أي رد", async () => {
    const db = createFakeDb() as FakeDb;
    modelThatInventsWholesalePrice();
    await seed(db);
    await customerSays(db, `عندكم ${PRODUCT}؟`);
    await customerSays(db, "وسعر الجملة؟");
    await customerSays(db, "طيب متوفر؟");
    await drainUntilAllAnswered(db, 5_000, () => diagnose(db)[2]?.replied === true);
    const d = diagnose(db);
    expect(d.map((x) => x.replied)).toEqual([true, false, true]);
  });
});
