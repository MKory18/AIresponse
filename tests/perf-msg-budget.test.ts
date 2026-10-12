/**
 * PERF BUDGETS — per-reply DB-operation ceilings (fail-before/pass-after).
 *
 * Each budget pins a PROVEN duplicate query found by PERF-OPS measurement:
 *  - product.findUnique ≤ 1  (context-builder + sales-plan double fetch)
 *  - catalog.count ≤ 1       (extraction pre-check + resolveCatalogForChannel)
 *  - channel.findUnique ≤ 1  (gating select + resolveChannelPersona)
 *
 * Behavior (reply text, isolation, catalog scoping) is unchanged — only the
 * duplicate round-trips are removed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { ingestMetaWebhook } from "@/modules/channels/facebook/webhook";
import { handleProcessWebhookEvent } from "@/modules/jobs/handlers";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import {
  FacebookClient,
  setFacebookClientFactory,
} from "@/modules/channels/facebook/client";
import { processInboundGroups } from "@/modules/channels/inbound-job";
import { nextPollDelayMs } from "@/modules/jobs/service";
import { encryptSecret } from "@/core/crypto";

const WS = "ws-budget";
const PAGE = "page-budget-1";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
const stubVector = { search: async () => [] } as never;

function countingDb(base: any) {
  const counts: Record<string, number> = {};
  const proxy = new Proxy(base, {
    get(t, prop, _recv) {
      if (prop === "_stores") return Reflect.get(t, prop);
      const v = Reflect.get(t, prop);
      if (v && typeof v === "object") {
        return new Proxy(v, {
          get(mt, fn) {
            const f = Reflect.get(mt, fn);
            if (typeof f === "function") {
              return (...a: any[]) => {
                const k = `${String(prop)}.${String(fn)}`;
                counts[k] = (counts[k] ?? 0) + 1;
                return Reflect.apply(f as (...args: any[]) => unknown, mt, a);
              };
            }
            return f;
          },
        });
      }
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { proxy, counts };
}

beforeEach(() => { db = createFakeDb(); });
afterEach(() => {
  setFacebookClientFactory(undefined as never);
  setMockAIProvider(undefined);
});

describe("perf budgets — no duplicate queries per reply", () => {
  it("one product-question reply stays within query budgets", async () => {
    const mock = new MockAIProvider();
    mock.intentHandler = () => ({
      intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER",
    });
    mock.responseHandler = () => "العسل متوفر بسعر 100 دولار.";
    setMockAIProvider(mock);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = new URL(String(url));
      if (u.hostname === "graph.facebook.com") {
        if (u.pathname.endsWith("/me/messages")) {
          return Response.json({ recipient_id: "psid", message_id: `mid-${Date.now()}` });
        }
        return Response.json({ id: "p", name: "Budget User" });
      }
      return (origFetch as typeof fetch)(url, init);
    }) as typeof fetch;
    setFacebookClientFactory(() => new FacebookClient({}));
    try {
      const ch = (await db.channel.create({
        data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "Budget Page", externalId: PAGE },
      } as never)) as any;
      await db.channelAccount.create({
        data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: PAGE, pageName: "Budget Page", encryptedCredentials: encryptSecret("tok-budget") },
      } as never);
      await (db as any).aISettings.create({
        data: { workspaceId: WS, provider: "mock", temperature: 0.4, maxTokens: 500, aiEnabled: true, autoRespond: true },
      });
      const product = (await (db as any).product.create({
        data: { workspaceId: WS, name: "عسل طبيعي", sku: "HONEY-001", price: 100, currency: "USD", category: "أطعمة", isActive: true, isArchived: false, stockStatus: "IN_STOCK" },
      })) as any;
      // Catalogs exist + page assigned: exercises the catalog scope path.
      const catalog = (await (db as any).catalog.create({
        data: { workspaceId: WS, name: "كتالوج 1", isActive: true },
      })) as any;
      await (db as any).catalogPageAssignment.create({
        data: { channelId: ch.id, catalogId: catalog.id, workspaceId: WS },
      });
      await (db as any).catalogProduct.create({ data: { catalogId: catalog.id, productId: product.id, sortOrder: 0 } });

      const { proxy, counts } = countingDb(db);
      const res = await ingestMetaWebhook(proxy as Db, {
        object: "page",
        entry: [{ id: PAGE, messaging: [{ sender: { id: "psid-budget-1" }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: "mid-budget-1", text: "بكم العسل الطبيعي؟" } }] }],
      });
      expect(res.status).toBe("OK");
      const jb = (db._stores.backgroundJob as any[]).find((j) => j.type === "process_webhook_event");
      const jr = await handleProcessWebhookEvent(proxy as never, jb.payload as Record<string, unknown>);
      expect(jr.success).toBe(true);
      const aiJob = (db._stores.backgroundJob as any[]).filter((j) => j.type === "process_ai_message").at(-1) as any;
      const out = await processAIMessage(
        proxy as Db,
        { conversationId: aiJob.payload.conversationId, messageId: aiJob.payload.messageId, workspaceId: WS },
        { vectorStore: stubVector }
      );
      expect((out as { status?: string }).status ?? "SUCCESS").not.toBe("AI_FAILED");
      // Reply still sent exactly once.
      const sent = (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND" && m.deliveryStatus === "SENT");
      expect(sent).toHaveLength(1);

      expect(counts["product.findUnique"] ?? 0).toBeLessThanOrEqual(1);
      expect(counts["catalog.count"] ?? 0).toBeLessThanOrEqual(1);
      expect(counts["channel.findUnique"] ?? 0).toBeLessThanOrEqual(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  }, 120000);
});

describe("perf guards — ordering + worker polling", () => {
  it("nextPollDelayMs: full batch re-polls fast, partial keeps idle cadence", () => {
    expect(nextPollDelayMs({ processed: 10, failed: 0, limit: 10, idleMs: 5000 })).toBe(250);
    expect(nextPollDelayMs({ processed: 7, failed: 3, limit: 10, idleMs: 5000 })).toBe(250);
    expect(nextPollDelayMs({ processed: 9, failed: 0, limit: 10, idleMs: 5000 })).toBe(5000);
    expect(nextPollDelayMs({ processed: 0, failed: 0, limit: 10, idleMs: 5000 })).toBe(5000);
    expect(nextPollDelayMs({ processed: 10, failed: 0, limit: 10, idleMs: 5000, busyMs: 100 })).toBe(100);
  });

  it("processInboundGroups: concurrent across conversations, ordered within", async () => {
    const order: string[] = [];
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const res = await processInboundGroups(
      [
        { conv: "A", seq: 1 }, { conv: "B", seq: 1 }, { conv: "A", seq: 2 },
        { conv: "B", seq: 2 }, { conv: "A", seq: 3 },
      ],
      {
        groupKey: (m) => m.conv,
        run: async (m) => { await delay(m.conv === "A" ? 20 : 5); order.push(`${m.conv}${m.seq}`); },
      }
    );
    expect(res).toEqual({ processed: 5, failed: 0 });
    // A-group strictly ordered despite B finishing faster.
    expect(order.filter((x) => x.startsWith("A"))).toEqual(["A1", "A2", "A3"]);
    expect(order.filter((x) => x.startsWith("B"))).toEqual(["B1", "B2"]);
  });

  it("processInboundGroups: poison message does not drop the batch", async () => {
    const seen: string[] = [];
    const res = await processInboundGroups(["ok1", "boom", "ok2"], {
      groupKey: (m) => (m === "boom" ? "X" : "Y"),
      run: async (m) => {
        if (m === "boom") throw new Error("poison");
        seen.push(m);
      },
    });
    expect(res).toEqual({ processed: 2, failed: 1 });
    expect(seen.sort()).toEqual(["ok1", "ok2"]);
  });

  it("messenger batch: same-conversation messages keep input order", async () => {
    const mock = new MockAIProvider();
    mock.intentHandler = () => ({
      intent: "GREETING", confidence: 0.99, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER",
    });
    mock.responseHandler = () => "أهلاً";
    setMockAIProvider(mock);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      const u = new URL(String(url));
      if (u.hostname === "graph.facebook.com") return Response.json({ id: "p", name: "Order User" });
      return (origFetch as typeof fetch)(url);
    }) as typeof fetch;
    try {
      const ch = (await db.channel.create({
      data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "Order Page", externalId: PAGE },
    } as never)) as any;
    await db.channelAccount.create({
      data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: PAGE, pageName: "Order Page", encryptedCredentials: encryptSecret("tok-order") },
    } as never);
    const res = await ingestMetaWebhook(db as Db, {
      object: "page",
      entry: [{
        id: PAGE,
        messaging: [
          { sender: { id: "psid-ord" }, recipient: { id: PAGE }, timestamp: 1000, message: { mid: "m-o1", text: "أول" } },
          { sender: { id: "psid-other" }, recipient: { id: PAGE }, timestamp: 1001, message: { mid: "m-o2", text: "غريب" } },
          { sender: { id: "psid-ord" }, recipient: { id: PAGE }, timestamp: 1002, message: { mid: "m-o3", text: "ثاني" } },
        ],
      }],
    });
    expect(res.status).toBe("OK");
    const jb = (db._stores.backgroundJob as any[]).find((j) => j.type === "process_webhook_event");
    const jr = await handleProcessWebhookEvent(db as never, jb.payload as Record<string, unknown>);
    expect(jr.success).toBe(true);
    const conv = (db._stores.conversation as any[]).find((c) => c.channelConversationId === "psid-ord");
    const texts = (db._stores.message as any[])
      .filter((m) => m.conversationId === conv.id && m.direction === "INBOUND")
      .map((m) => m.text);
    expect(texts).toEqual(["أول", "ثاني"]);
    } finally {
      globalThis.fetch = origFetch;
    }
  }, 120000);
});
