/**
 * PERF OPS COUNTER — counts DB operations per full Messenger reply.
 * Read-only instrumentation (Proxy); prints a sorted histogram.
 * Used to find duplicate/unnecessary queries with evidence.
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
import { encryptSecret } from "@/core/crypto";

const WS = "ws-ops";
const PAGE = "page-ops-1";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
const stubVector = { search: async () => [] } as never;

function countingDb(base: any) {
  const counts: Record<string, number> = {};
  const proxy = new Proxy(base, {
    get(t, prop, _recv) {
      if (prop === "_stores" || prop === "__counts") return Reflect.get(t, prop);
      const v = Reflect.get(t, prop);
      if (v && typeof v === "object") {
        return new Proxy(v, {
          get(mt, fn) {
            const f = Reflect.get(mt, fn);
            if (typeof f === "function") {
              return (...a: any[]) => {
                const k = `${String(prop)}.${String(fn)}`;
                counts[k] = (counts[k] ?? 0) + 1;
                // Preserve `this` (fake models call e.g. this.create inside upsert).
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

describe("perf ops — DB operations per reply", () => {
  it("histogram for one product-question reply", async () => {
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
        return Response.json({ id: "p", name: "Ops User" });
      }
      return (origFetch as typeof fetch)(url, init);
    }) as typeof fetch;
    setFacebookClientFactory(() => new FacebookClient({}));
    try {
      const ch = (await db.channel.create({
        data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "Ops Page", externalId: PAGE },
      } as never)) as any;
      await db.channelAccount.create({
        data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: PAGE, pageName: "Ops Page", encryptedCredentials: encryptSecret("tok-ops") },
      } as never);
      await (db as any).aISettings.create({
        data: { workspaceId: WS, provider: "mock", temperature: 0.4, maxTokens: 500, aiEnabled: true, autoRespond: true },
      });
      await (db as any).product.create({
        data: { workspaceId: WS, name: "عسل طبيعي", sku: "HONEY-001", price: 100, currency: "USD", category: "أطعمة", isActive: true, isArchived: false, stockStatus: "IN_STOCK" },
      });

      const { proxy, counts } = countingDb(db);
      const res = await ingestMetaWebhook(proxy as Db, {
        object: "page",
        entry: [{ id: PAGE, messaging: [{ sender: { id: "psid-ops-1" }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: "mid-ops-1", text: "بكم العسل الطبيعي؟" } }] }],
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

      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const total = entries.reduce((a, [, c]) => a + c, 0);
      console.log(`PERF-OPS total=${total} ${JSON.stringify(entries)}`);
      expect(total).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  }, 120000);
});
