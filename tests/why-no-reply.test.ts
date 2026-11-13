/**
 * «ليش ما رد؟» — رقم المهام الفاشلة لحاله ما بيدلّ على شي.
 * حالة الطابور لازم ترجّع أسباب الفشل مجمّعة، وبلا أي بيانات زبون.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { getQueueMetrics, scrubFailureReason } from "@/modules/analytics/service";

type Db = Prisma.TransactionClient;
const WS = "ws-why";
let db: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  db = createFakeDb();
});

async function failedJob(type: string, lastError: string) {
  await db.backgroundJob.create({
    data: { workspaceId: WS, type, status: "FAILED", payload: {}, lastError, finishedAt: new Date() },
  } as never);
}

describe("أسباب فشل الردود", () => {
  it("بتتجمّع بالسبب مع العدد", async () => {
    await failedJob("process_ai_message", "PERMANENT: Guardrail violations persist after retry: PRICE_MISMATCH");
    await failedJob("process_ai_message", "PERMANENT: Guardrail violations persist after retry: PRICE_MISMATCH");
    await failedJob("process_ai_message", "TRANSIENT: timeout");

    const m = await getQueueMetrics(db as unknown as Db, WS);
    expect(m.failed).toBe(3);
    expect(m.topFailures?.[0]).toMatchObject({ type: "process_ai_message", count: 2 });
    expect(m.topFailures?.[0].reason).toContain("PRICE_MISMATCH");
    expect(m.topFailures).toHaveLength(2);
  });

  it("ما بترجّع أسباب من مساحة تانية", async () => {
    await failedJob("process_ai_message", "PERMANENT: x");
    await db.backgroundJob.create({
      data: { workspaceId: "ws-other", type: "process_ai_message", status: "FAILED", payload: {}, lastError: "سرّ الجيران", finishedAt: new Date() },
    } as never);

    const m = await getQueueMetrics(db as unknown as Db, WS);
    expect(m.topFailures).toHaveLength(1);
    expect(JSON.stringify(m.topFailures)).not.toContain("الجيران");
  });

  it("ما في فشل = ما في أسباب", async () => {
    const m = await getQueueMetrics(db as unknown as Db, WS);
    expect(m.failed).toBe(0);
    expect(m.topFailures).toEqual([]);
  });
});

describe("نص السبب بلا بيانات زبون", () => {
  it("بيشيل رقم الموبايل", () => {
    expect(scrubFailureReason("send failed for 0930123456")).not.toContain("0930123456");
  });

  it("بيشيل المعرّفات", () => {
    const out = scrubFailureReason("SUPERSEDED_BY:cmh9x2k4l0001abcd3fgh5ijk");
    expect(out).not.toContain("cmh9x2k4l0001abcd3fgh5ijk");
    expect(out).toContain("SUPERSEDED_BY");
  });

  it("بلا سبب = نص مفهوم مش فاضي", () => {
    expect(scrubFailureReason(null)).toBe("سبب غير معروف");
  });

  it("بيقصّ النص الطويل", () => {
    expect(scrubFailureReason("x".repeat(500)).length).toBeLessThanOrEqual(160);
  });
});
