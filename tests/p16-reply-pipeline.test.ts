/**
 * P16 — مسار الرد: التقاط المهمة بنفس الدورة · عدم حجب محادثة وراء محادثة ·
 * الحفاظ على ترتيب المحادثة الواحدة · إيقاف حلقة AI_DISABLED بالكنس.
 *
 * ملاحظة قياس: كل الاختبارات هنا على قاعدة بالذاكرة (mock DB) ومزوّد وهمي —
 * تثبت السلوك والمسار، ولا تُقدَّم كقياس زمن إنتاجي.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { processPendingJobs, recoverOrphanedInboundMessages } from "@/modules/jobs/service";
import { runWorkerTick } from "@/modules/jobs/handlers";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;

const WS = "ws-p16";

function mockReply() {
  const mock = new MockAIProvider();
  mock.intentHandler = () => ({
    intent: "PRODUCT_QUESTION",
    confidence: 0.9,
    entities: {},
    missingFields: [],
    memories: [],
    requestedAction: "ANSWER",
  });
  mock.responseHandler = () => "أهلاً فيك 🌹";
  setMockAIProvider(mock);
}

function fbSuccess() {
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string) => {
          const u = new URL(url);
          if (u.pathname.includes("/messages")) {
            return Response.json({ recipient_id: "psid", message_id: `mid-${Date.now()}` });
          }
          return Response.json({ id: "p", name: "p" });
        }) as typeof fetch,
      })
  );
}

function outboundRows(db: FakeDb) {
  return (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND");
}

function aiJobs(db: FakeDb) {
  return (db._stores.backgroundJob as any[]).filter((j) => j.type === "process_ai_message");
}

async function createJob(
  db: FakeDb,
  args: { conversationId: string; messageId: string; createdAt: number }
) {
  await db.backgroundJob.create({
    data: {
      workspaceId: WS,
      type: "process_ai_message",
      payload: { conversationId: args.conversationId, messageId: args.messageId },
      runAfter: new Date(0),
      createdAt: new Date(args.createdAt),
    },
  } as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  setMockAIProvider(undefined);
  setFacebookClientFactory(undefined as never);
});

describe("P16 — العامل يلتقط مهمة أنشأها الويب هوك بنفس الدورة", () => {
  it("رسالة جديدة: الويب هوك يحفظها ويُصفّي الرد، والعامل يرسل الرد بنفس النداء (بلا انتظار دورة تالية)", async () => {
    const db = createFakeDb() as FakeDb;
    mockReply();
    fbSuccess();

    // صفحة حقيقية (قناة + حساب) حتى يكون الإرسال ممكنًا كما بالإنتاج.
    const ch = (await db.channel.create({
      data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "p16-page", externalId: "p16-page" },
    } as never)) as any;
    const account = (await db.channelAccount.create({
      data: {
        channelId: ch.id,
        provider: "FACEBOOK",
        externalAccountId: "p16-page",
        pageName: "p16-page",
        encryptedCredentials: encryptSecret("tok"),
      },
    } as never)) as any;

    // مهمة الويب هوك كما تُصفّ فعليًا من مسار ميتا (رسالة واحدة من زبون جديد).
    await db.backgroundJob.create({
      data: {
        workspaceId: WS,
        type: "process_webhook_event",
        payload: {
          workspaceId: WS,
          webhookEventId: "wh-p16-1",
          channelAccountId: account.id,
          messages: [
            {
              externalCustomerId: "psid-p16",
              externalConversationId: "psid-p16",
              externalMessageId: "mid-p16",
              externalEventId: "evt-p16",
              text: "شو مواصفات المنتج؟",
            },
          ],
        },
        runAfter: new Date(0),
      },
    } as never);

    const out = await runWorkerTick(db as never);

    // الرد خرج بنفس نداء العامل — لا حاجة لنداء ثانٍ من الـ cron.
    expect(outboundRows(db)).toHaveLength(1);
    expect(outboundRows(db)[0].senderType).toBe("AI");
    // ومهمة الرد نفسها انتهت DONE (لا إعادة معالجة ولا تكرار).
    expect(aiJobs(db)).toHaveLength(1);
    expect(aiJobs(db)[0].status).toBe("DONE");
    expect(out.processed).toBeGreaterThanOrEqual(2); // ويب هوك + رد
  });
});

describe("P16 — محادثة بطيئة ما بتحجب محادثة تانية", () => {
  it("مهمة رد معلّقة على محادثة A لا تمنع إتمام رد محادثة B", async () => {
    const db = createFakeDb() as FakeDb;
    const events: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const handlers = {
      process_ai_message: async (payload: Record<string, unknown>) => {
        const conv = String(payload.conversationId);
        events.push(`start:${conv}`);
        if (conv === "conv-a") await gateA;
        events.push(`end:${conv}`);
        return { success: true } as const;
      },
    };

    await createJob(db, { conversationId: "conv-a", messageId: "m-a", createdAt: 1_000 });
    await createJob(db, { conversationId: "conv-b", messageId: "m-b", createdAt: 2_000 });

    const running = processPendingJobs(db as unknown as Db, handlers, { limit: 10, maintenance: false });

    // B لازم تخلص بينما A لسا معلّقة. قبل الإصلاح: التنفيذ متسلسل فـ B ما بت起步.
    await vi.waitFor(() => expect(events).toContain("end:conv-b"), { timeout: 500, interval: 10 });
    expect(events).toContain("start:conv-a");
    expect(events).not.toContain("end:conv-a"); // A لسا محجوزة عن قصد

    releaseA();
    const result = await running;
    expect(result.processed).toBe(2);
    expect(events).toEqual(["start:conv-a", "start:conv-b", "end:conv-b", "end:conv-a"]);
  });

  it("حارس: رسالتان بنفس المحادثة تتنفذان بالترتيب (الأقدم أولًا)", async () => {
    const db = createFakeDb() as FakeDb;
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const handlers = {
      process_ai_message: async (payload: Record<string, unknown>) => {
        const mid = String(payload.messageId);
        events.push(`start:${mid}`);
        if (mid === "m-1") await gate;
        events.push(`end:${mid}`);
        return { success: true } as const;
      },
    };

    await createJob(db, { conversationId: "conv-c", messageId: "m-1", createdAt: 1_000 });
    await createJob(db, { conversationId: "conv-c", messageId: "m-2", createdAt: 2_000 });

    const running = processPendingJobs(db as unknown as Db, handlers, { limit: 10, maintenance: false });
    await vi.waitFor(() => expect(events).toContain("start:m-1"), { timeout: 500, interval: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(events).not.toContain("start:m-2"); // ما بتسبق الأقدم

    releaseFirst();
    await running;
    expect(events).toEqual(["start:m-1", "end:m-1", "start:m-2", "end:m-2"]);
  });
});

describe("P16 — الكنس ما بيعيد تصفيف رسالة معطّلة بإعدادات المساحة (بلا حلقة ساخنة)", () => {
  it("AI مطفأ بإعدادات المساحة: لا إعادة تصفيف كل دورة، وفور التفعيل تُعالَج", async () => {
    const db = createFakeDb() as FakeDb;
    const now = new Date();
    const settings = (await db.aISettings.create({
      data: { workspaceId: WS, aiEnabled: false, autoRespond: true },
    } as never)) as any;
    db._stores.customer.push({ id: "cu-p16", workspaceId: WS, name: "زبون" });
    db._stores.conversation.push({
      id: "cv-p16",
      workspaceId: WS,
      customerId: "cu-p16",
      channelId: "ch-p16",
      channelConversationId: "fb-p16",
      aiState: "AI_ACTIVE",
      aiEnabled: true,
    });
    db._stores.message.push({
      id: "m-p16",
      conversationId: "cv-p16",
      workspaceId: WS,
      senderType: "CUSTOMER",
      direction: "INBOUND",
      text: "مرحبا",
      createdAt: now,
    });
    // محاولة سابقة سجّلت AI_DISABLED (غير نهائية بحسب التصميم) قبل لحظات.
    db._stores.aIUsageLog.push({
      id: "u-p16",
      workspaceId: WS,
      conversationId: "cv-p16",
      messageId: "m-p16",
      purpose: "RESPONSE",
      provider: "none",
      model: "none",
      status: "AI_DISABLED",
      success: true,
      createdAt: now,
    });

    // الإعدادات مطفئة: ما في فايدة من إعادة التصفيف كل دورة.
    expect((await recoverOrphanedInboundMessages(db as never)).recovered).toBe(0);

    // تفعيل الذكاء بالمساحة → الرسالة ترجع مؤهّلة فورًا (لا انتظار مؤقت).
    await db.aISettings.update({ where: { id: settings.id }, data: { aiEnabled: true } } as never);
    expect((await recoverOrphanedInboundMessages(db as never)).recovered).toBe(1);
  });
});
