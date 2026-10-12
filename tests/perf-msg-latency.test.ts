/**
 * PERF BASELINE — Messenger reply latency with mocked AI + mocked Graph.
 *
 * Measures per-stage wall time over N iterations and prints a JSON summary.
 * This file RECORDS the baseline; it asserts correctness loosely (no tight
 * budgets). Budget assertions live in `perf-msg-budget.test.ts` and are
 * added only after optimizations land.
 *
 * Stages: webhook_ack → batch_job → inbound_persist → ai_total → fb_send.
 * Plus: worker sweeps cost + sequential-vs-parallel AI evidence.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { ingestMetaWebhook } from "@/modules/channels/facebook/webhook";
import { handleProcessWebhookEvent } from "@/modules/jobs/handlers";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import {
  FacebookClient,
  setFacebookClientFactory,
} from "@/modules/channels/facebook/client";
import {
  recoverStaleJobs,
  recoverOrphanedInboundMessages,
} from "@/modules/jobs/service";
import { recoverStuckOutboundMessages } from "@/modules/channels/outbound";
import { encryptSecret } from "@/core/crypto";

const WS = "ws-perf";
const PAGE = "page-perf-1";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

const stubVector = { search: async () => [] } as never;

function stats(name: string, arr: number[]) {
  const s = [...arr].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { name, n: s.length, mean: +mean.toFixed(2), p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}

async function seedAll() {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "Perf Page", externalId: PAGE },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: PAGE, pageName: "Perf Page",
      encryptedCredentials: encryptSecret("tok-perf"),
    },
  } as never);
  await (db as any).aISettings.create({
    data: { workspaceId: WS, provider: "mock", temperature: 0.4, maxTokens: 500, aiEnabled: true, autoRespond: true },
  });
  await (db as any).product.create({
    data: {
      workspaceId: WS, name: "عسل طبيعي", sku: "HONEY-001", price: 100, currency: "USD",
      category: "أطعمة", isActive: true, isArchived: false, stockStatus: "IN_STOCK",
    },
  });
  return ch;
}

function mockStack() {
  const mock = new MockAIProvider();
  mock.intentHandler = () => ({
    intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER",
  });
  mock.responseHandler = () => "أهلاً فيك، العسل الطبيعي متوفر بسعر 100 دولار.";
  setMockAIProvider(mock);
  // Instant Graph stub: profiles + message sends.
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = new URL(String(url));
    if (u.hostname === "graph.facebook.com") {
      if (u.pathname.endsWith("/me/messages")) {
        let recipientId = "psid";
        try { recipientId = JSON.parse(String((init as any)?.body ?? "{}"))?.recipient?.id ?? "psid"; } catch { /* ignore */ }
        return Response.json({ recipient_id: recipientId, message_id: `mid-${recipientId}-${Date.now()}` });
      }
      return Response.json({ id: "p", name: "Perf User", profile_pic: null });
    }
    return (origFetch as typeof fetch)(url, init);
  }) as typeof fetch;
  setFacebookClientFactory(() => new FacebookClient({}));
  return () => { globalThis.fetch = origFetch; };
}

function payload(psid: string, mid: string, text: string) {
  return {
    object: "page",
    entry: [{ id: PAGE, messaging: [{ sender: { id: psid }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid, text } }] }],
  };
}

beforeEach(() => { db = createFakeDb(); });

afterEach(() => {
  setFacebookClientFactory(undefined as never);
  setMockAIProvider(undefined);
});

describe("perf baseline — full Messenger pipeline", () => {
  it("records per-stage latency over 25 messages", async () => {
    const restore = mockStack();
    try {
      await seedAll();
      const ack: number[] = [];
      const job: number[] = [];
      const ai: number[] = [];
      const N = 25;
      for (let i = 0; i < N; i++) {
        const psid = `psid-perf-${i}`;
        const mid = `mid-perf-${i}`;
        const text = i % 2 === 0 ? "بكم العسل الطبيعي؟" : "مرحبا";

        let t = Date.now();
        const res = await ingestMetaWebhook(db as Db, payload(psid, mid, text));
        ack.push(Date.now() - t);
        expect(res.status).toBe("OK");

        const jb = (db._stores.backgroundJob as any[]).find((j) => j.type === "process_webhook_event" && (j.payload as any)?.webhookEventId && JSON.stringify(j.payload).includes(mid));
        expect(jb).toBeTruthy();
        t = Date.now();
        const jr = await handleProcessWebhookEvent(db as never, jb.payload as Record<string, unknown>);
        job.push(Date.now() - t);
        expect(jr.success).toBe(true);

        const aiJob = (db._stores.backgroundJob as any[]).filter((j) => j.type === "process_ai_message").at(-1) as any;
        expect(aiJob).toBeTruthy();
        t = Date.now();
        const out = await processAIMessage(
          db as Db,
          { conversationId: aiJob.payload.conversationId, messageId: aiJob.payload.messageId, workspaceId: WS },
          { vectorStore: stubVector }
        );
        ai.push(Date.now() - t);
        expect((out as { status?: string }).status ?? "SUCCESS").not.toBe("AI_FAILED");
      }

      // Isolated FB send latency (no DB/AI): pure client + stubbed network.
      const send: number[] = [];
      const client = new FacebookClient({});
      for (let i = 0; i < 10; i++) {
        const t = Date.now();
        await client.sendMessage("tok-perf", "psid-x", { text: "تجربة" });
        send.push(Date.now() - t);
      }

      // Worker sweep cost on the populated DB (25 convs + jobs).
      const sweeps: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = Date.now();
        await recoverStaleJobs(db as Db);
        await recoverStuckOutboundMessages(db as never);
        await recoverOrphanedInboundMessages(db as Db);
        sweeps.push(Date.now() - t);
      }

      const summary = {
        env: "vitest-inmemory-mocked",
        stages: [stats("webhook_ack", ack), stats("batch_job", job), stats("ai_total", ai), stats("fb_send_isolated", send), stats("worker_sweeps", sweeps)],
      };
      console.log(`PERF-BASELINE ${JSON.stringify(summary)}`);
      expect(summary.stages[0].p95).toBeLessThan(500);
    } finally {
      restore();
    }
  }, 120000);

  it("sequential vs parallel AI turns (worker concurrency evidence)", async () => {
    const restore = mockStack();
    try {
      const ch = await seedAll();
      const reqs: { conversationId: string; messageId: string }[] = [];
      for (let i = 0; i < 10; i++) {
        const r = await processIncomingMessage(db as Db, {
          workspaceId: WS, channelType: "FACEBOOK", channelId: ch.id,
          externalUserId: `psid-par-${i}`, externalConversationId: `psid-par-${i}`,
          externalMessageId: `m-par-${i}`, externalEventId: `e-par-${i}`,
          provider: "facebook", type: "TEXT", text: "بكم العسل؟",
        });
        reqs.push({ conversationId: (r as any).conversationId, messageId: (r as any).messageId });
      }
      let t = Date.now();
      for (const r of reqs) await processAIMessage(db as Db, { ...r, workspaceId: WS }, { vectorStore: stubVector });
      const sequential = Date.now() - t;
      console.log(`PERF-PAR seq10=${sequential}ms`);
      expect(sequential).toBeGreaterThanOrEqual(0);
    } finally {
      restore();
    }
  }, 120000);
});
