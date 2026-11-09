/**
 * Phase 3 — قبول تحسينات السرعة والقياس.
 *
 *  - معالجة مهمة الذكاء فورًا داخل نفس دورة العامل (same-cycle) بدل انتظار دورة.
 *  - جدولة أعمال الصيانة الثقيلة كل N دورات (shouldRunMaintenance).
 *  - حفظ زمن الرد الحقيقي (respondedAt + replyLatencyMs) على الرسالة الصادرة.
 *  - تفصيل «زمن أول رد» حسب مصدره (AI / HUMAN / أتمتة) لا رقمًا مخلوطًا.
 */
import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { processPendingJobs, shouldRunMaintenance } from "@/modules/jobs/service";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { getConversationAnalytics } from "@/modules/analytics/service";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;

const WS = "ws-speed";

describe("Phase 3 — جدولة الصيانة (shouldRunMaintenance)", () => {
  it("يفرّق بين دورة الصيانة والدورات العادية", () => {
    expect(shouldRunMaintenance(0, 10)).toBe(true);
    expect(shouldRunMaintenance(1, 10)).toBe(false);
    expect(shouldRunMaintenance(9, 10)).toBe(false);
    expect(shouldRunMaintenance(10, 10)).toBe(true);
    // كل دورة (السلوك القديم) عند 1 أو أقل.
    expect(shouldRunMaintenance(3, 1)).toBe(true);
    expect(shouldRunMaintenance(3, 0)).toBe(true);
    expect(shouldRunMaintenance(3, Number.NaN)).toBe(true);
  });
});

describe("Phase 3 — same-cycle: مهمة أنشئت خلال الدورة تُنفَّذ بنفس الدورة", () => {
  function seedTwoStage() {
    const db = createFakeDb() as FakeDb;
    const ran: string[] = [];
    const handlers = {
      t_first: async () => {
        await db.backgroundJob.create({
          data: { workspaceId: WS, type: "t_second", payload: {}, runAfter: new Date(0) },
        } as never);
        ran.push("t_first");
        return { success: true } as const;
      },
      t_second: async () => {
        ran.push("t_second");
        return { success: true } as const;
      },
    };
    return { db, handlers, ran };
  }

  async function pendingSecond(db: FakeDb) {
    return (db._stores.backgroundJob as Array<Record<string, any>>).filter(
      (j) => j.type === "t_second" && j.status === "PENDING"
    ).length;
  }

  it("بدون same-cycle تبقى المهمة الثانية معلّقة (السلوك القديم)", async () => {
    const { db, handlers, ran } = seedTwoStage();
    await db.backgroundJob.create({
      data: { workspaceId: WS, type: "t_first", payload: {}, runAfter: new Date(0) },
    } as never);

    const res = await processPendingJobs(db as unknown as Db, handlers, { limit: 10 });
    expect(res.processed).toBe(1);
    expect(ran).toEqual(["t_first"]);
    expect(await pendingSecond(db)).toBe(1);
  });

  it("مع same-cycle تُنفَّذ المهمة الثانية بنفس النداء", async () => {
    const { db, handlers, ran } = seedTwoStage();
    await db.backgroundJob.create({
      data: { workspaceId: WS, type: "t_first", payload: {}, runAfter: new Date(0) },
    } as never);

    const res = await processPendingJobs(db as unknown as Db, handlers, { limit: 10, sameCycle: true });
    expect(res.processed).toBe(2);
    expect(ran.sort()).toEqual(["t_first", "t_second"]);
    expect(await pendingSecond(db)).toBe(0);
  });

  it("مع maintenance=false لا تُشغَّل أعمال الصيانة", async () => {
    const { db, handlers } = seedTwoStage();
    await db.backgroundJob.create({
      data: { workspaceId: WS, type: "t_first", payload: {}, runAfter: new Date(0) },
    } as never);
    const res = await processPendingJobs(db as unknown as Db, handlers, { limit: 10, maintenance: false });
    expect(res.processed).toBe(1);
  });
});

describe("أولوية مهام الرد على العميل", () => {
  it("مهمة الرد (process_ai_message) تتنفّذ قبل مهام ثانوية أقدم منها", async () => {
    const db = createFakeDb() as FakeDb;
    const ran: string[] = [];
    const handlers = {
      bookkeeping: async () => {
        ran.push("bookkeeping");
        return { success: true } as const;
      },
      process_ai_message: async () => {
        ran.push("reply");
        return { success: true } as const;
      },
    };
    // 5 مهام ثانوية أقدم، ثم مهمة رد واحدة أحدث. الحد 3 → الرد لازم يدخل الدفعة.
    for (let i = 0; i < 5; i++) {
      await db.backgroundJob.create({
        data: { workspaceId: WS, type: "bookkeeping", payload: {}, runAfter: new Date(0), createdAt: new Date(1000 + i) },
      } as never);
    }
    await db.backgroundJob.create({
      data: { workspaceId: WS, type: "process_ai_message", payload: { conversationId: "c1" }, runAfter: new Date(0), createdAt: new Date(5000) },
    } as never);

    await processPendingJobs(db as unknown as Db, handlers, { limit: 3, maintenance: false });
    expect(ran).toContain("reply");
  });
});

describe("مهام بداية الرد والمهام البطيئة", () => {
  it("حدث الويبهوك يدخل الدفعة قبل مهام ثانوية أقدم منه", async () => {
    const db = createFakeDb() as FakeDb;
    const ran: string[] = [];
    const handlers = {
      bookkeeping: async () => {
        ran.push("bookkeeping");
        return { success: true } as const;
      },
      process_webhook_event: async () => {
        ran.push("webhook");
        return { success: true } as const;
      },
    };
    for (let i = 0; i < 5; i++) {
      await db.backgroundJob.create({
        data: { workspaceId: WS, type: "bookkeeping", payload: {}, runAfter: new Date(0), createdAt: new Date(1000 + i) },
      } as never);
    }
    await db.backgroundJob.create({
      data: { workspaceId: WS, type: "process_webhook_event", payload: {}, runAfter: new Date(0), createdAt: new Date(5000) },
    } as never);

    await processPendingJobs(db as unknown as Db, handlers, { limit: 3, maintenance: false });
    expect(ran).toContain("webhook");
  });

  function trackingHandler() {
    const state = { active: 0, max: 0 };
    const handler = async () => {
      state.active += 1;
      state.max = Math.max(state.max, state.active);
      await new Promise((r) => setTimeout(r, 20));
      state.active -= 1;
      return { success: true } as const;
    };
    return { state, handler };
  }

  it("مهام الذكاء الثانوية لمحادثات مختلفة تشتغل بالتوازي", async () => {
    const db = createFakeDb() as FakeDb;
    const { state, handler } = trackingHandler();
    for (const conversationId of ["c1", "c2", "c3"]) {
      await db.backgroundJob.create({
        data: { workspaceId: WS, type: "extract_customer_intel", payload: { conversationId }, runAfter: new Date(0) },
      } as never);
    }
    await processPendingJobs(db as unknown as Db, { extract_customer_intel: handler }, { limit: 10, maintenance: false });
    expect(state.max).toBeGreaterThan(1);
  });

  it("مهام نفس المحادثة تضل بالترتيب وما بتتداخل", async () => {
    const db = createFakeDb() as FakeDb;
    const { state, handler } = trackingHandler();
    for (let i = 0; i < 3; i++) {
      await db.backgroundJob.create({
        data: { workspaceId: WS, type: "generate_summary", payload: { conversationId: "same" }, runAfter: new Date(0) },
      } as never);
    }
    await processPendingJobs(db as unknown as Db, { generate_summary: handler }, { limit: 10, maintenance: false });
    expect(state.max).toBe(1);
  });
});

describe("تأجيل مهمة الرد لما رسالة أقدم لسا قيد المعالجة", () => {
  it("المهمة المؤجلة بترجع للدور بدون ما تنحسب محاولة", async () => {
    const db = createFakeDb() as FakeDb;
    const handlers = {
      process_ai_message: async () => ({ success: true, deferMs: 3000 }) as const,
    };
    await db.backgroundJob.create({
      data: { workspaceId: WS, type: "process_ai_message", payload: { conversationId: "c1" }, runAfter: new Date(0) },
    } as never);

    const before = Date.now();
    const res = await processPendingJobs(db as unknown as Db, handlers as never, { limit: 5, maintenance: false });

    const job = (db._stores.backgroundJob as Array<Record<string, any>>)[0];
    expect(res.processed).toBe(0);
    expect(res.failed).toBe(0);
    expect(job.status).toBe("PENDING");
    expect(job.attempts).toBe(0);
    expect(new Date(job.runAfter).getTime()).toBeGreaterThanOrEqual(before + 2500);
    expect(job.lockedBy).toBeNull();
  });
});

describe("Phase 3 — قياس زمن الرد الحقيقي", () => {
  function seedPage(db: FakeDb) {
    db._stores.channel.push({
      id: "ch-speed",
      workspaceId: WS,
      type: "FACEBOOK",
      status: "CONNECTED",
      displayName: "صفحة",
      sendMode: "AUTO_REPLY",
    });
    db._stores.conversation.push({
      id: "cv-speed",
      workspaceId: WS,
      customerId: "cu-speed",
      channelId: "ch-speed",
      channelConversationId: "fb-speed",
      aiState: "AI_ACTIVE",
    });
  }

  it("يحفظ respondedAt و replyLatencyMs من فرق زمن الرسالة الواردة", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    // القناة مربوطة بالمحادثة (كما يفعل مسار الرسالة الوارد فعليًا).
    await db.conversation.findFirst({ where: { id: "cv-speed" } });
    db._stores.message.push({
      id: "m-in",
      conversationId: "cv-speed",
      workspaceId: WS,
      senderType: "CUSTOMER",
      direction: "INBOUND",
      text: "مرحبا",
      createdAt: new Date(Date.now() - 5000),
    });

    await dispatchOutbound(db as unknown as Db, {
      workspaceId: WS,
      conversationId: "cv-speed",
      sourceMessageId: "m-in",
      text: "أهلين وسهلين",
      senderType: "AI",
    });

    const outbound = (db._stores.message as Array<Record<string, any>>).find((m) => m.direction === "OUTBOUND");
    expect(outbound).toBeTruthy();
    expect(outbound!.respondedAt).toBeInstanceOf(Date);
    expect(outbound!.replyLatencyMs).toBeGreaterThanOrEqual(4000);
  });

  it("لا يخترع زمنًا لمصدر صناعي (بلا رسالة واردة)", async () => {
    const db = createFakeDb() as FakeDb;
    seedPage(db);
    await db.conversation.findFirst({ where: { id: "cv-speed" } });

    await dispatchOutbound(db as unknown as Db, {
      workspaceId: WS,
      conversationId: "cv-speed",
      sourceMessageId: "campaign:camp-1:rec-1",
      text: "عرض خاص",
      senderType: "SYSTEM",
      automationSource: "CAMPAIGN",
    });

    const outbound = (db._stores.message as Array<Record<string, any>>).find((m) => m.direction === "OUTBOUND");
    expect(outbound).toBeTruthy();
    expect(outbound!.replyLatencyMs ?? null).toBeNull();
  });
});

describe("Phase 3 — تفصيل زمن أول رد حسب المصدر", () => {
  it("يفصل رد الموظف عن رد الوكيل", async () => {
    const db = createFakeDb() as FakeDb;
    const now = Date.now();
    db._stores.conversation.push({
      id: "cv-a", workspaceId: WS, customerId: "cu-a", channelId: "ch-a",
      channelConversationId: "x", createdAt: new Date(now - 3600_000),
    });
    db._stores.message.push(
      { id: "a1", conversationId: "cv-a", workspaceId: WS, senderType: "CUSTOMER", direction: "INBOUND", isNote: false, createdAt: new Date(now - 1200_000) },
      { id: "a2", conversationId: "cv-a", workspaceId: WS, senderType: "HUMAN", direction: "OUTBOUND", isNote: false, createdAt: new Date(now - 900_000) }
    );
    db._stores.conversation.push({
      id: "cv-b", workspaceId: WS, customerId: "cu-b", channelId: "ch-b",
      channelConversationId: "y", createdAt: new Date(now - 3600_000),
    });
    db._stores.message.push(
      { id: "b1", conversationId: "cv-b", workspaceId: WS, senderType: "CUSTOMER", direction: "INBOUND", isNote: false, createdAt: new Date(now - 1200_000) },
      { id: "b2", conversationId: "cv-b", workspaceId: WS, senderType: "AI", direction: "OUTBOUND", isNote: false, createdAt: new Date(now - 600_000) }
    );

    const r = await getConversationAnalytics(db as unknown as Db, WS, { range: "last_7_days" });
    expect(r.firstResponse.count).toBe(2);
    expect(r.firstResponse.bySource.human.count).toBe(1);
    expect(r.firstResponse.bySource.human.avgMinutes).toBeCloseTo(5, 6); // (1200-900)/60
    expect(r.firstResponse.bySource.ai.count).toBe(1);
    expect(r.firstResponse.bySource.ai.avgMinutes).toBeCloseTo(10, 6); // (1200-600)/60
  });
});
