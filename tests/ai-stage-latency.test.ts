/**
 * P13/P14 — قياس زمن مراحل خط أنابيب الذكاء + زمن الرد حسب نوع المجيب.
 *
 * يثبت:
 *  - دالة النسبة المئوية (nearest-rank) صحيحة.
 *  - تجميع P50/P95 لكل مرحلة من **كل** سجلات الرد (نجحت أو فشلت) — لا استبعاد.
 *  - تفصيل byStatus لكل مرحلة (نجاح/فشل) بدل إخفاء الفشل.
 *  - فصل زمن الرد حسب AI / HUMAN / AUTOMATION من الرسائل الفعلية.
 *  - عزل المساحة، وإظهار غير المتاح صراحة، وبلا أي نص رسالة بالاستجابة.
 *  - خط الأنابيب الفعلي يكتب stageTimings على سجل الرد (نجاحًا وفشلًا).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { getAiStageLatency } from "@/modules/analytics/service";
import { percentile } from "@/core/analytics/time";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

const WS_A = "ws-stage-a";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

const stubVector = { search: async () => [] } as never;

beforeEach(() => {
  db = createFakeDb();
});

afterEach(() => {
  setMockAIProvider(undefined);
  setFacebookClientFactory(undefined as never);
});

function fbSuccess() {
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string) => {
          const u = new URL(url);
          if (u.pathname.endsWith("/me/messages")) {
            return Response.json({ recipient_id: "psid", message_id: `mid-${Date.now()}` });
          }
          return Response.json({ id: "p", name: "p" });
        }) as typeof fetch,
      })
  );
}

async function seedPage() {
  const ch = (await db.channel.create({
    data: { workspaceId: WS_A, type: "FACEBOOK", status: "CONNECTED", displayName: "Stage Page", externalId: "page-stage-1" },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-stage-1", pageName: "Stage Page",
      encryptedCredentials: encryptSecret("page-token-stage"),
    },
  } as never);
  return ch;
}

describe("percentile — nearest-rank", () => {
  it("يحسب P50/P95 على القيم الفعلية", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.5)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
  });
});

describe("getAiStageLatency — تجميع المراحل (نجاح + فشل)", () => {
  it("يضم الفاشل والبطيء ولا يستبعدهما، مع تفصيل byStatus", async () => {
    db._stores.aIUsageLog.push(
      { id: "l1", workspaceId: WS_A, purpose: "RESPONSE", status: "SUCCESS", stageTimings: { extraction: 100, total: 350 }, createdAt: new Date() },
      { id: "l2", workspaceId: WS_A, purpose: "RESPONSE", status: "SUCCESS", stageTimings: { extraction: 300, total: 800 }, createdAt: new Date() },
      { id: "l3", workspaceId: WS_A, purpose: "RESPONSE", status: "AI_FAILED", stageTimings: { extraction: 9999, total: 12000 }, createdAt: new Date() },
      { id: "l4", workspaceId: WS_A, purpose: "EXTRACTION", status: "SUCCESS", stageTimings: { extraction: 5000 }, createdAt: new Date() }
    );

    const r = await getAiStageLatency(db as never, WS_A, { range: "last_7_days" });
    // كل سجلات RESPONSE (٣) — والفاشل ضمنها، وسجل EXTRACTION مستثنى (غرض مختلف).
    expect(r.totals.responseLogs).toBe(3);
    expect(r.totals.withTimings).toBe(3);
    expect(r.totals.byStatus.SUCCESS).toBe(2);
    expect(r.totals.byStatus.AI_FAILED).toBe(1);

    const ex = r.stages.find((s) => s.stage === "extraction");
    expect(ex?.count).toBe(3); // الفاشل (9999) ضمن العينات
    // تفصيل الحالة: النجاح منفصل عن الفشل.
    expect(ex?.byStatus.SUCCESS.count).toBe(2);
    expect(ex?.byStatus.SUCCESS.p50).toBe(100);
    expect(ex?.byStatus.AI_FAILED.count).toBe(1);
    expect(ex?.byStatus.AI_FAILED.p95).toBe(9999);
  });

  it("مساحة أخرى لا تظهر، وغير المتاح يُعلن صراحة بدل صفر مضلل", async () => {
    db._stores.aIUsageLog.push(
      { id: "x1", workspaceId: "ws-other", purpose: "RESPONSE", status: "SUCCESS", stageTimings: { extraction: 42 }, createdAt: new Date() }
    );
    const r = await getAiStageLatency(db as never, WS_A, { range: "last_7_days" });
    expect(r.totals.responseLogs).toBe(0);
    expect(r.stages).toHaveLength(0);
    expect(r.unavailable.join(" ")).toContain("STAGE_TIMINGS");
    // الأنواع الثلاثة مُعلنة دائمًا، وغير المتاح منها بلا عينات.
    expect(r.byResponder.map((x) => x.kind)).toEqual(["AI", "HUMAN", "AUTOMATION"]);
  });

  it("يفصل زمن الرد حسب AI وHUMAN وAUTOMATION", async () => {
    const mk = async (convId: string, kind: string, deltaMin: number) => {
      const base = new Date(Date.now() - 5 * 60_000);
      await db.message.create({ data: { workspaceId: WS_A, conversationId: convId, direction: "INBOUND", senderType: "CUSTOMER", createdAt: base } } as never);
      await db.message.create({ data: { workspaceId: WS_A, conversationId: convId, direction: "OUTBOUND", senderType: kind, senderId: kind === "HUMAN" ? "agent-1" : null, createdAt: new Date(base.getTime() + deltaMin * 60_000) } } as never);
    };
    await mk("conv-ai", "AI", 1);
    await mk("conv-human", "HUMAN", 3);
    await mk("conv-auto", "AUTOMATION", 5);

    const r = await getAiStageLatency(db as never, WS_A, { range: "last_7_days" });
    const by = Object.fromEntries(r.byResponder.map((x) => [x.kind, x.minutes.p50]));
    expect(by.AI).toBeCloseTo(1, 6);
    expect(by.HUMAN).toBeCloseTo(3, 6);
    expect(by.AUTOMATION).toBeCloseTo(5, 6);
    // ولا نص رسالة ولا بيانات عميل بالاستجابة.
    expect(JSON.stringify(r)).not.toContain("CUSTOMER");
  });
});

describe("خط الأنابيب يكتب مراحل الزمن على سجل الرد", () => {
  it("RESPONSE SUCCESS يحمل stageTimings (مراحل + total + send)", async () => {
    const ch = await seedPage();
    fbSuccess();
    const mock = new MockAIProvider();
    mock.intentHandler = () => ({
      intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER",
    });
    mock.responseHandler = () => "أهلاً فيك 🌹";
    setMockAIProvider(mock);

    const r = await processIncomingMessage(db as Db, {
      workspaceId: WS_A,
      channelType: "FACEBOOK",
      channelId: ch.id,
      externalUserId: "psid-stage",
      externalConversationId: "psid-stage",
      externalMessageId: "m-stage-1",
      externalEventId: "e-stage-1",
      provider: "facebook",
      type: "TEXT",
      text: "شو مواصفات المنتج؟",
    });

    const res = await processAIMessage(
      db as Db,
      { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A },
      { vectorStore: stubVector }
    );
    expect(["RESPONDED", "CLARIFIED"]).toContain(res.status);

    const log = (db._stores.aIUsageLog as any[]).find(
      (u) => u.purpose === "RESPONSE" && u.status === "SUCCESS" && u.messageId === r.messageId
    );
    expect(log).toBeTruthy();
    expect(log.stageTimings).toBeTruthy();
    expect(typeof log.stageTimings.total).toBe("number");
    expect(typeof log.stageTimings.send).toBe("number");
    expect(typeof log.stageTimings.extraction).toBe("number");

    const agg = await getAiStageLatency(db as never, WS_A, { range: "last_7_days" });
    expect(agg.totals.responseLogs).toBeGreaterThanOrEqual(1);
    expect(agg.stages.some((s) => s.stage === "total")).toBe(true);
  });
});
