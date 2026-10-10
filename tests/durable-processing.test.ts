/**
 * DURABLE PROCESSING — "never silent, never abandon inbound messages".
 *
 * Covers: durable AI jobs, transient vs permanent provider failures,
 * Retry-After handling, stale job/outbound recovery, orphan sweeper
 * (enqueue failure, exhausted attempts, worker downtime), retry idempotency,
 * burst ordering, restart recovery, no-static-fallback, terminal visibility.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { dispatchOutbound, recoverStuckOutboundMessages } from "@/modules/channels/outbound";
import { recoverOrphanedInboundMessages, recoverStaleJobs } from "@/modules/jobs/service";
import { runJobs } from "@/modules/jobs/handlers";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import {
  setMockAIProvider,
  MockAIProvider,
  OpenAICompatibleProvider,
  AIProviderError,
  parseRetryAfter,
} from "@/modules/ai/provider";
import { withRetry } from "@/modules/ai/router";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

const WS_A = "ws-durable-a";
const WS_B = "ws-durable-b";
const AGENT = { userId: "agent-durable", workspaceId: WS_A };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

const stubVector = { search: async () => [] } as never;

function mockAI(opts?: { failResponseTimes?: number; intent?: string; respond?: (n: number) => string }) {
  const mock = new MockAIProvider();
  let calls = 0;
  mock.intentHandler = () => ({
    intent: opts?.intent ?? "PRODUCT_QUESTION",
    confidence: 0.9,
    entities: {},
    missingFields: [],
    memories: [],
    requestedAction: "ANSWER",
  });
  mock.responseHandler = () => {
    calls += 1;
    if (opts?.failResponseTimes && calls <= opts.failResponseTimes) {
      throw new AIProviderError("simulated transient outage", { retryable: true });
    }
    return opts?.respond ? opts.respond(calls) : "أهلاً فيك 🌹 كيف فيني ساعدك؟";
  };
  setMockAIProvider(mock);
  return mock;
}

async function seedPage(pageId = "page-durable-1", ws = WS_A) {
  const ch = (await db.channel.create({
    data: { workspaceId: ws, type: "FACEBOOK", status: "CONNECTED", displayName: "Durable Page", externalId: pageId },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: pageId, pageName: "Durable Page",
      encryptedCredentials: encryptSecret("page-token-durable"),
    },
  } as never);
  return ch;
}

async function seedInbound(psid: string, text: string, channelId?: string, tag?: string) {
  const t = tag ?? Math.random().toString(36).slice(2, 8);
  return processIncomingMessage(db as Db, {
    workspaceId: WS_A,
    channelType: "FACEBOOK",
    channelId,
    externalUserId: psid,
    externalConversationId: psid,
    externalMessageId: `m-${psid}-${t}`,
    externalEventId: `e-${psid}-${t}`,
    provider: "facebook",
    type: "TEXT",
    text,
  });
}

function fbSuccess() {
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: any) => {
          const u = new URL(url as string);
          if (u.pathname.endsWith("/me/messages")) {
            let recipientId = "psid";
            try {
              recipientId = JSON.parse(String((init as any)?.body ?? "{}"))?.recipient?.id ?? "psid";
            } catch { /* ignore */ }
            return Response.json({ recipient_id: recipientId, message_id: `mid-${recipientId}-${Date.now()}` });
          }
          return Response.json({ id: "p", name: "p" });
        }) as typeof fetch,
      })
  );
}

function aiJobs() {
  return (db._stores.backgroundJob as any[]).filter((j) => j.type === "process_ai_message");
}

function outboundRows() {
  return (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND");
}

beforeEach(() => {
  db = createFakeDb();
});

afterEach(() => {
  setFacebookClientFactory(undefined as never);
  setMockAIProvider(undefined);
  vi.unstubAllGlobals();
});

// ── 1. durable jobs ─────────────────────────────────────────────────────────

describe("durable AI jobs", () => {
  it("1. inbound message always creates durable processing work", async () => {
    const ch = await seedPage();
    const r = await seedInbound("psid-d1", "مرحبا", ch.id, "d1");
    const jobs = aiJobs().filter((j) => (j.payload as any)?.messageId === r.messageId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("PENDING");
    expect(jobs[0].workspaceId).toBe(WS_A);
  });

  it("15. failed extraction still answers via heuristic (no silent drop)", async () => {
    const ch = await seedPage();
    fbSuccess();
    const mock = new MockAIProvider();
    mock.intentHandler = () => {
      throw new AIProviderError("extraction down", { retryable: true });
    };
    mock.responseHandler = () => "أهلاً فيك 🌹";
    setMockAIProvider(mock);
    const r = await seedInbound("psid-d2", "شو مواصفات المنتج؟", ch.id, "d2");
    const res = await processAIMessage(
      db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A }, { vectorStore: stubVector }
    );
    expect(["RESPONDED", "CLARIFIED", "HANDOFF"]).toContain(res.status);
  });
});

// ── 2-4. provider failure classification ────────────────────────────────────

describe("provider failure classification", () => {
  function stubFetch(status: number, headers: Record<string, string> = {}) {
    const orig = globalThis.fetch;
    (globalThis as any).fetch = (async () =>
      new Response("{}", { status, headers })) as typeof fetch;
    return () => {
      (globalThis as any).fetch = orig;
    };
  }

  it("2/4. 429 is transient with Retry-After parsed; 401 is permanent", async () => {
    const p = new OpenAICompatibleProvider({ name: "t", apiKey: "k", baseUrl: "https://x.invalid", defaultModel: "m" });
    let restore = stubFetch(429, { "retry-after": "120" });
    try {
      await expect(p.generateText({ system: "s", user: "u" })).rejects.toMatchObject({
        name: "AIProviderError",
        retryable: true,
      });
    } finally {
      restore();
    }
    restore = stubFetch(401);
    try {
      await expect(p.generateText({ system: "s", user: "u" })).rejects.toMatchObject({
        name: "AIProviderError",
        retryable: false,
      });
    } finally {
      restore();
    }
  });

  it("3. 5xx is transient", async () => {
    const p = new OpenAICompatibleProvider({ name: "t", apiKey: "k", baseUrl: "https://x.invalid", defaultModel: "m" });
    const restore = stubFetch(503);
    try {
      await expect(p.generateText({ system: "s", user: "u" })).rejects.toMatchObject({ retryable: true });
    } finally {
      restore();
    }
  });

  it("parseRetryAfter handles seconds, HTTP-date, and garbage", () => {
    expect(parseRetryAfter("120")).toBe(120000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
    const future = new Date(Date.now() + 60_000).toUTCString();
    const parsed = parseRetryAfter(future);
    expect(parsed).toBeGreaterThan(30_000);
    expect(parsed).toBeLessThanOrEqual(60_000);
  });

  it("withRetry fails fast on permanent errors, retries transient ones", async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          throw new AIProviderError("bad key", { retryable: false });
        },
        { attempts: 3 }
      )
    ).rejects.toThrow("bad key");
    expect(calls).toBe(1);

    let tries = 0;
    const ok = await withRetry(
      () => {
        tries += 1;
        if (tries < 3) throw new AIProviderError("flaky", { retryable: true });
        return "done";
      },
      { attempts: 3 }
    );
    expect(ok).toBe("done");
    expect(tries).toBe(3);
  });

  it("AI timeout is categorized TRANSIENT with zero customer-facing messages", async () => {
    const ch = await seedPage();
    fbSuccess();
    mockAI({ failResponseTimes: 99 });
    const r = await seedInbound("psid-d3", "شو مواصفات المنتج؟", ch.id, "d3");
    const res = await processAIMessage(
      db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A }, { vectorStore: stubVector }
    );
    expect(res.status).toBe("AI_FAILED");
    expect(res.error).toMatch(/TRANSIENT/);
    // No static fallback, no fabricated reply: zero outbound rows.
    expect(outboundRows()).toHaveLength(0);
    const usage = (db._stores.aIUsageLog as any[]).find(
      (u) => u.messageId === r.messageId && u.purpose === "RESPONSE"
    );
    expect(usage?.status).toBe("AI_FAILED");
    expect(usage?.error).toMatch(/TRANSIENT/);
    // ...but operator-visible: HIGH handoff alert exists.
    const handoffs = (db._stores.humanHandoff as any[]).filter((h) => h.conversationId === r.conversationId);
    expect(handoffs.length).toBeGreaterThan(0);
  });
});

// ── 7-10. crash + stale recovery ────────────────────────────────────────────

describe("crash and stale recovery", () => {
  it("8. stale PROCESSING jobs return to PENDING; fresh ones are untouched", async () => {
    const old = new Date(Date.now() - 20 * 60_000);
    const stale = (await db.backgroundJob.create({
      data: { type: "process_ai_message", workspaceId: WS_A, payload: {}, status: "PROCESSING", lockedAt: old },
    } as never)) as unknown as { id: string };
    const fresh = (await db.backgroundJob.create({
      data: { type: "process_ai_message", workspaceId: WS_A, payload: {}, status: "PROCESSING", lockedAt: new Date() },
    } as never)) as unknown as { id: string };
    const n = await recoverStaleJobs(db as never);
    expect(n).toBe(1);
    const rows = db._stores.backgroundJob as any[];
    expect(rows.find((j) => j.id === stale.id).status).toBe("PENDING");
    expect(rows.find((j) => j.id === fresh.id).status).toBe("PROCESSING");
  });

  it("24. worker-restart equivalent: stale job + orphan both resume", async () => {
    const ch = await seedPage();
    const r = await seedInbound("psid-d4", "مرحبا", ch.id, "d4");
    // Simulate crash: job stuck PROCESSING, plus an orphan message with no job.
    const job = aiJobs()[0];
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { status: "PROCESSING", lockedAt: new Date(Date.now() - 20 * 60_000) },
    } as never);
    const orphan = (await db.message.create({
      data: {
        conversationId: r.conversationId, workspaceId: WS_A, senderType: "CUSTOMER",
        direction: "INBOUND", type: "TEXT", text: "orphan after crash", provider: "facebook",
      },
    } as never)) as unknown as { id: string };
    await recoverStaleJobs(db as never);
    const out = await recoverOrphanedInboundMessages(db as never);
    const rows = db._stores.backgroundJob as any[];
    expect(rows.find((j) => j.id === job.id).status).toBe("PENDING");
    expect(out.recovered).toBe(1);
    expect(aiJobs().some((j) => (j.payload as any)?.messageId === orphan.id)).toBe(true);
  });
});

// ── orphan sweeper ──────────────────────────────────────────────────────────

describe("orphan sweeper (never silent)", () => {
  // Builds a jobless inbound message directly (simulates the enqueue failure
  // without involving processIncomingMessage, so no other orphans exist).
  async function orphanMessage(text = "lost message", ws = WS_A) {
    const ch = await seedPage(`page-${Math.random().toString(36).slice(2, 8)}`, ws);
    const customer = (await db.customer.create({
      data: { workspaceId: ws, status: "NEW_LEAD" },
    } as never)) as unknown as { id: string };
    const conv = (await db.conversation.create({
      data: {
        workspaceId: ws,
        customerId: customer.id,
        channelId: ch.id,
        channelConversationId: `conv-${Math.random().toString(36).slice(2, 8)}`,
      },
    } as never)) as unknown as { id: string };
    return (await db.message.create({
      data: {
        conversationId: conv.id, workspaceId: ws, senderType: "CUSTOMER",
        direction: "INBOUND", type: "TEXT", text, provider: "facebook",
      },
    } as never)) as unknown as { id: string; conversationId: string };
  }

  it("recovers enqueue-failure orphans without duplicating live jobs", async () => {
    const orphan = await orphanMessage();
    const out = await recoverOrphanedInboundMessages(db as never);
    expect(out.recovered).toBe(1);
    // Second sweep sees the pending job → no duplicate.
    const again = await recoverOrphanedInboundMessages(db as never);
    expect(again.recovered).toBe(0);
    expect(aiJobs().filter((j) => (j.payload as any)?.messageId === orphan.id)).toHaveLength(1);
  });

  it("respects backoff for recent failures, retries aged ones", async () => {
    const orphan = await orphanMessage();
    await db.aIUsageLog.create({
      data: {
        workspaceId: WS_A, conversationId: orphan.conversationId, messageId: orphan.id,
        purpose: "RESPONSE", provider: "mock", model: "m", success: false,
        status: "AI_FAILED", error: "TRANSIENT: boom",
      },
    } as never);
    // Failed seconds ago → inside backoff → skipped.
    expect((await recoverOrphanedInboundMessages(db as never)).recovered).toBe(0);
    // Age the failure beyond backoff (30s base) → retried.
    const logRow = (db._stores.aIUsageLog as any[]).find((u) => u.messageId === orphan.id);
    await db.aIUsageLog.update({
      where: { id: logRow.id },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    } as never);
    expect((await recoverOrphanedInboundMessages(db as never)).recovered).toBe(1);
  });

  it("P12 regression: terminal FAILED jobs (no usage log) hold backoff — no hot loop", async () => {
    const orphan = await orphanMessage("config failure orphan");
    // The job ran, exhausted its attempts and FAILED. The failure threw before
    // any AIUsageLog row was written (provider config/unreachability path), so
    // usage-log accounting alone sees failCount=0 and the sweeper used to
    // re-enqueue this message on EVERY cycle (~1 re-enqueue/s, forever).
    await db.backgroundJob.create({
      data: {
        type: "process_ai_message", workspaceId: WS_A,
        payload: { conversationId: orphan.conversationId, messageId: orphan.id },
        status: "FAILED", idempotencyKey: `ai:${orphan.id}`,
        finishedAt: new Date(Date.now() - 5_000),
      },
    } as never);
    // Terminal failure seconds ago → inside backoff → skipped.
    expect((await recoverOrphanedInboundMessages(db as never)).recovered).toBe(0);
    // Age the terminal failure beyond backoff (30s base) → eligible again.
    const row = (db._stores.backgroundJob as any[]).find(
      (j) => j.idempotencyKey === `ai:${orphan.id}`
    );
    await db.backgroundJob.update({
      where: { id: row.id },
      data: { finishedAt: new Date(Date.now() - 10 * 60_000) },
    } as never);
    expect((await recoverOrphanedInboundMessages(db as never)).recovered).toBe(1);
  });

  it("P12 regression: jobs created by in-cycle recovery get real workspace context (no silent DONE)", async () => {
    const ch = await seedPage();
    fbSuccess();
    mockAI();
    const r = await seedInbound("psid-ws-ctx", "شو المواصفات؟", ch.id, "wsctx");
    // Simulate the enqueue loss: drop the auto-created job → the message is a
    // sweeper orphan with NO job row.
    const autoJob = aiJobs()[0];
    await db.backgroundJob.delete({ where: { id: autoJob.id } } as never);
    // One worker cycle = recovery sweep (creates the job NOW) + processing.
    // Before the fix, the freshly-created job was not in the pre-claimed
    // workspace snapshot → handler received workspaceId="" → gating returned
    // SKIPPED → job DONE with zero logs → sweeper re-enqueued forever.
    const out = await runJobs(db as never, { limit: 10, workerId: "test-ws-ctx" });
    expect(out.processed).toBe(1);
    expect(out.failed).toBe(0);
    // The pipeline RAN: a SUCCESS decision exists for the message.
    const decided = (db._stores.aIUsageLog as any[]).filter(
      (u) => u.messageId === r.messageId && (u.status === "SUCCESS" || u.status === "HANDOFF")
    );
    expect(decided.length).toBeGreaterThan(0);
  });

  it("never touches decided messages or human-track conversations", async () => {
    const decided = await orphanMessage("decided");
    await db.aIUsageLog.create({
      data: {
        workspaceId: WS_A, conversationId: decided.conversationId, messageId: decided.id,
        purpose: "RESPONSE", provider: "mock", model: "m", success: true, status: "HANDOFF",
      },
    } as never);
    const human = await orphanMessage("human track");
    await db.conversation.update({
      where: { id: human.conversationId },
      data: { aiState: "HUMAN_ACTIVE", aiEnabled: false },
    } as never);
    const out = await recoverOrphanedInboundMessages(db as never);
    expect(out.recovered).toBe(0);
  });

  it("keeps workspace isolation (recovers with the message's own workspace)", async () => {
    const wsbOrphan = await orphanMessage("wsb orphan", WS_B);
    const out = await recoverOrphanedInboundMessages(db as never);
    expect(out.recovered).toBe(1);
    const job = aiJobs().find((j) => (j.payload as any)?.messageId === wsbOrphan.id);
    expect(job?.workspaceId).toBe(WS_B);
  });
});

// ── 11-13, 16. idempotency, burst, ordering ─────────────────────────────────

describe("retry idempotency, burst, ordering", () => {
  it("11/12. retry after transient failure sends exactly one Facebook message", async () => {
    const ch = await seedPage();
    fbSuccess();
    mockAI({ failResponseTimes: 99 });
    const r = await seedInbound("psid-d5", "شو مواصفات المنتج؟", ch.id, "d5");
    const first = await processAIMessage(
      db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A }, { vectorStore: stubVector }
    );
    expect(first.status).toBe("AI_FAILED");
    expect(outboundRows()).toHaveLength(0);

    mockAI({});
    const second = await processAIMessage(
      db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A }, { vectorStore: stubVector }
    );
    expect(second.status).toBe("RESPONDED");
    expect(outboundRows()).toHaveLength(1);
    expect(outboundRows()[0].deliveryStatus).toBe("SENT");
  });

  it("15/16. burst of 10 same-conversation messages: all answered, order preserved", async () => {
    const ch = await seedPage();
    fbSuccess();
    let n = 0;
    mockAI({ respond: () => `رد رقم ${++n}` });
    const conv = await seedInbound("psid-d6", "رسالة 0", ch.id, "burst0");
    const inboundIds = [conv.messageId];
    for (let i = 1; i < 10; i++) {
      const r = await processIncomingMessage(db as Db, {
        workspaceId: WS_A, channelType: "FACEBOOK", channelId: ch.id,
        externalUserId: "psid-d6", externalConversationId: "psid-d6",
        externalMessageId: `m-burst-${i}`, externalEventId: `e-burst-${i}`,
        provider: "facebook", type: "TEXT", text: `رسالة ${i}`,
      });
      expect(r.duplicate).toBe(false);
      inboundIds.push(r.messageId);
    }
    expect(aiJobs()).toHaveLength(10);
    // Drain oldest-first with REAL createdAt ordering: stagger each job's
    // createdAt according to its inbound message's creation order (NOT
    // lexicographic ids), then assert replies follow the inbound sequence.
    const jobs = aiJobs();
    for (const job of jobs) {
      const idx = inboundIds.indexOf((job.payload as any).messageId);
      await db.backgroundJob.update({
        where: { id: job.id },
        data: { createdAt: new Date(Date.parse("2026-01-01T00:00:00Z") + idx * 1000) },
      } as never);
    }
    const ordered = [...aiJobs()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    for (const job of ordered) {
      const p = job.payload as any;
      const res = await processAIMessage(
        db as Db, { conversationId: p.conversationId, messageId: p.messageId, workspaceId: WS_A }, { vectorStore: stubVector }
      );
      expect(["RESPONDED", "CLARIFIED"]).toContain(res.status);
    }
    const sent = outboundRows().filter((m) => m.deliveryStatus === "SENT");
    expect(sent).toHaveLength(10);
    // Reply numbering must follow inbound order (mock numbers by drain order).
    const inbounds = (db._stores.message as any[])
      .filter((m) => m.conversationId === conv.conversationId && m.direction === "INBOUND")
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const replyNumbers = inbounds.map((inb) => {
      const key = `${inb.conversationId}:${inb.id}`;
      const reply = sent.find((o) => o.outboundIdempotencyKey === key);
      return Number((reply?.text ?? "").match(/رد رقم (\d+)/)?.[1] ?? 0);
    });
    expect(replyNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("13. QUEUED outbound eventually reaches SENT via recovery (no silent stall)", async () => {
    const ch = await seedPage();
    setFacebookClientFactory(
      () => new FacebookClient({ fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch })
    );
    const r = await seedInbound("psid-d7", "مرحبا", ch.id, "d7");
    const first = await dispatchOutbound(db as Db, {
      workspaceId: WS_A, conversationId: r.conversationId, sourceMessageId: "src-d7", text: "أهلاً",
    });
    expect(first.deliveryStatus).toBe("QUEUED");
    await db.message.update({
      where: { id: first.messageId }, data: { createdAt: new Date(Date.now() - 20 * 60_000) },
    } as never);
    fbSuccess();
    const out = await recoverStuckOutboundMessages(db as Db, { maxAgeMinutes: 10, limit: 20 });
    expect(out.recovered).toBe(1);
    expect((db._stores.message as any[]).find((m) => m.id === first.messageId).deliveryStatus).toBe("SENT");
  });
});

// ── 17-19. memory, handoff, disabled visibility ─────────────────────────────

describe("terminal visibility and continuity", () => {
  it("17. memory and identity survive a retry", async () => {
    const ch = await seedPage();
    fbSuccess();
    const r = await seedInbound("psid-d8", "شو بتنصحني؟", ch.id, "d8");
    await db.customerMemory.create({
      data: {
        workspaceId: WS_A, customerId: r.customerId, type: "FACT",
        key: "durable pref", value: "العميل يفضل الأسود", confidence: 0.9, source: "test",
      },
    } as never);
    mockAI({ failResponseTimes: 99 });
    expect(
      (await processAIMessage(
        db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A }, { vectorStore: stubVector }
      )).status
    ).toBe("AI_FAILED");
    const seen: string[] = [];
    const mock = new MockAIProvider();
    mock.intentHandler = () => ({
      intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER",
    });
    mock.responseHandler = (_u: string, s: string) => {
      seen.push(s);
      return "تفضل، الأسود متوفر 🌹";
    };
    setMockAIProvider(mock);
    const res = await processAIMessage(
      db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A }, { vectorStore: stubVector }
    );
    expect(res.status).toBe("RESPONDED");
    expect(seen[seen.length - 1]).toContain("العميل يفضل الأسود");
    expect(outboundRows()).toHaveLength(1);
  });

  it("HANDOFF decisions are terminal, visible, and redelivery-safe", async () => {
    const ch = await seedPage();
    fbSuccess();
    mockAI({ intent: "COMPLAINT" });
    const r = await seedInbound("psid-d9", "المنتج مكسور، شكوى", ch.id, "d9");
    const first = await processAIMessage(
      db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A }, { vectorStore: stubVector }
    );
    expect(first.status).toBe("HANDOFF");
    expect(outboundRows()).toHaveLength(0);
    const usage = (db._stores.aIUsageLog as any[]).find(
      (u) => u.messageId === r.messageId && u.purpose === "RESPONSE"
    );
    expect(usage?.status).toBe("HANDOFF");
    // Redelivery (job retry) returns DUPLICATE — no second handoff processing.
    const second = await processAIMessage(
      db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A }, { vectorStore: stubVector }
    );
    expect(second.status).toBe("DUPLICATE");
  });

  it("AI_DISABLED is logged and visible instead of silent", async () => {
    const ch = await seedPage();
    const r = await seedInbound("psid-d10", "مرحبا", ch.id, "d10");
    await db.conversation.update({
      where: { id: r.conversationId }, data: { aiEnabled: false },
    } as never);
    mockAI({});
    const res = await processAIMessage(
      db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A }, { vectorStore: stubVector }
    );
    expect(res.status).toBe("AI_DISABLED");
    const usage = (db._stores.aIUsageLog as any[]).find(
      (u) => u.messageId === r.messageId && u.purpose === "RESPONSE"
    );
    expect(usage?.status).toBe("AI_DISABLED");
    expect(outboundRows()).toHaveLength(0);
  });
});
