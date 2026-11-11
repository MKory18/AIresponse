/**
 * Reply speed: only the safe changes. Per-conversation ordering stays with
 * the ordering guard and the job chain.
 *
 * In-memory DB and fake providers: these prove order and limits, not real
 * latency.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import { createProduct } from "@/modules/products/service";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import {
  AIProviderError,
  MockAIProvider,
  OpenAICompatibleProvider,
  setMockAIProvider,
  type StructuredRequest,
} from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { deferDelayMs, processPendingJobs } from "@/modules/jobs/service";
import { AI_DEFERRED_RETRY_MS } from "@/modules/jobs/handlers";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & { _stores: Record<string, unknown[]> };
const WS = "ws-speed";
const NAME = "ماء الورد الطبيعي";

let db: FakeDb;
const asDb = () => db as unknown as Db;
let counter = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  db = createFakeDb() as FakeDb;
  setMockAIProvider(undefined);
});

afterEach(() => {
  setMockAIProvider(undefined);
  setFacebookClientFactory(undefined as never);
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bookkeeping(n: number) {
  return Array.from({ length: n }, (_, i) =>
    db.backgroundJob.create({
      data: { workspaceId: WS, type: "bookkeeping", payload: {}, runAfter: new Date(0), createdAt: new Date(1000 + i) },
    } as never)
  );
}

describe("a. DEFERRED retry", () => {
  it("retries in about one second", () => {
    expect(AI_DEFERRED_RETRY_MS).toBeGreaterThanOrEqual(500);
    expect(AI_DEFERRED_RETRY_MS).toBeLessThanOrEqual(1500);
  });

  it("a tiny delay cannot hot-loop: the floor holds", () => {
    expect(deferDelayMs(0, 0)).toBeGreaterThanOrEqual(500);
    expect(deferDelayMs(1, 0)).toBeGreaterThanOrEqual(500);
  });

  it("the requested delay is kept while the job is young", () => {
    expect(deferDelayMs(1000, 5_000)).toBe(1000);
    expect(deferDelayMs(3000, 5_000)).toBe(3000);
  });

  it("a job waiting a long time backs off", () => {
    expect(deferDelayMs(1000, 120_000)).toBeGreaterThanOrEqual(5000);
  });

  async function deferred(createdAt: Date, deferMs: number) {
    await db.backgroundJob.create({
      data: { workspaceId: WS, type: "process_ai_message", payload: { conversationId: "c1" }, runAfter: new Date(0), createdAt },
    } as never);
    const before = Date.now();
    const res = await processPendingJobs(
      asDb(),
      { process_ai_message: async () => ({ success: true, deferMs }) } as never,
      { limit: 5, maintenance: false }
    );
    const job = (db._stores.backgroundJob as Array<Record<string, any>>)[0];
    return { res, job, wait: new Date(job.runAfter).getTime() - before };
  }

  it("the queue applies the floor and does not count an attempt or a processed job", async () => {
    const { res, job, wait } = await deferred(new Date(), 1);
    expect(wait).toBeGreaterThanOrEqual(400);
    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(job.status).toBe("PENDING");
    expect(job.attempts).toBe(0);
  });

  it("the queue applies the back-off to an old job", async () => {
    const { wait } = await deferred(new Date(Date.now() - 120_000), 1000);
    expect(wait).toBeGreaterThanOrEqual(4500);
  });
});

describe("b. process_channel_inbound is on the reply path", () => {
  it("is picked before a backlog of older bookkeeping", async () => {
    await Promise.all(bookkeeping(5));
    await db.backgroundJob.create({
      data: { workspaceId: WS, type: "process_channel_inbound", payload: {}, runAfter: new Date(0), createdAt: new Date(9000) },
    } as never);
    const ran: string[] = [];
    await processPendingJobs(
      asDb(),
      {
        bookkeeping: async () => (ran.push("bookkeeping"), { success: true }),
        process_channel_inbound: async () => (ran.push("inbound"), { success: true }),
      } as never,
      { limit: 3, maintenance: false }
    );
    expect(ran[0]).toBe("inbound");
  });
});

async function makePage(opts: { catalogProducts?: string[] } = {}) {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", externalId: "page-1", sendMode: "AUTO_REPLY" },
  } as never)) as { id: string };
  await db.channelAccount.create({
    data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-1", pageName: "صفحة", encryptedCredentials: encryptSecret("tok") },
  } as never);
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string) => {
          if (new URL(url).pathname.includes("/messages")) {
            return Response.json({ recipient_id: "psid-1", message_id: `mid-${counter++}` });
          }
          return Response.json({ id: "p", name: "p" });
        }) as typeof fetch,
      })
  );
  if (opts.catalogProducts) {
    const catalog = (await db.catalog.create({ data: { workspaceId: WS, name: "كتالوج", isActive: true } } as never)) as { id: string };
    await db.catalogPageAssignment.create({ data: { workspaceId: WS, catalogId: catalog.id, channelId: ch.id } } as never);
    for (const productId of opts.catalogProducts) {
      await db.catalogProduct.create({ data: { catalogId: catalog.id, productId } } as never);
    }
  }
  await db.aISettings.create({
    data: { workspaceId: WS, provider: "mock", temperature: 0.4, maxTokens: 500, aiEnabled: true, autoRespond: true },
  } as never);
  return ch.id;
}

async function inbound(channelId: string, text: string) {
  const n = counter++;
  return processIncomingMessage(asDb(), {
    workspaceId: WS, channelType: "FACEBOOK", channelId, externalUserId: "psid-1", externalConversationId: "psid-1",
    externalMessageId: `m-${n}`, externalEventId: `e-${n}`, provider: "facebook", type: "TEXT", text,
  });
}

// Long enough and word-y enough to avoid every extraction fast path.
const REAL_QUESTION = `عندي استفسار طويل عن ${NAME} وكيف بينفع للبشرة الجافة`;

describe("c. read-only work starts before the extraction call finishes", () => {
  class SlowExtraction extends MockAIProvider {
    seenDuringExtraction: { memory: number; search: number } | null = null;
    constructor(private readonly probe: () => { memory: number; search: number }) {
      super();
    }
    override async generateStructured<T>(req: StructuredRequest<T>) {
      await sleep(40);
      this.seenDuringExtraction = this.probe();
      return super.generateStructured<T>(req);
    }
  }

  async function run(catalog: boolean) {
    const p = (await createProduct(asDb(), { userId: "a", workspaceId: WS }, { name: NAME, sku: "R", price: 25, currency: "USD" } as never)) as unknown as { id: string };
    const channelId = await makePage(catalog ? { catalogProducts: [p.id] } : {});
    const msg = await inbound(channelId, REAL_QUESTION);

    let memory = 0;
    const memoryModel = db.customerMemory as unknown as { findMany: (a: unknown) => Promise<unknown> };
    const baseMemory = memoryModel.findMany.bind(memoryModel);
    memoryModel.findMany = (a) => ((memory += 1), baseMemory(a));

    let catalogReads = 0;
    const catalogModel = db.catalog as unknown as { findFirst: (a: unknown) => Promise<unknown> };
    const baseCatalog = catalogModel.findFirst.bind(catalogModel);
    catalogModel.findFirst = (a) => ((catalogReads += 1), baseCatalog(a));

    let search = 0;
    const provider = new SlowExtraction(() => ({ memory, search }));
    provider.intentHandler = () => ({ intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER" }) as never;
    provider.responseHandler = () => "أهلا فيك";
    setMockAIProvider(provider);

    const res = await processAIMessage(
      asDb(),
      { conversationId: msg.conversationId, messageId: msg.messageId, workspaceId: WS },
      { vectorStore: { size: 1, search: async () => ((search += 1), []) } as never }
    );
    return { res, seen: provider.seenDuringExtraction, memory, search, catalogReads };
  }

  it("memory and document search are already running during extraction", async () => {
    const { res, seen } = await run(false);
    expect(res.status).toBe("RESPONDED");
    expect(seen?.memory).toBeGreaterThan(0);
    expect(seen?.search).toBeGreaterThan(0);
  });

  it("each runs once per turn: started early, not repeated", async () => {
    const { memory, search } = await run(false);
    expect(memory).toBe(1);
    expect(search).toBe(1);
  });

  it("the page's catalog is read once, not twice", async () => {
    const { res, catalogReads } = await run(true);
    expect(res.status).toBe("RESPONDED");
    expect(catalogReads).toBe(1);
  });

  // Changed on purpose (tests/reply-every-message.test.ts): documents only
  // enrich the reply. A failing search used to throw the whole turn and park
  // the job in its 30s back-off with the customer unanswered; now the reply
  // goes out without documents and the failure is logged.
  it("a failing document search no longer fails the turn: the reply goes out without documents", async () => {
    await createProduct(asDb(), { userId: "a", workspaceId: WS }, { name: NAME, sku: "R", price: 25, currency: "USD" } as never);
    const channelId = await makePage();
    const msg = await inbound(channelId, REAL_QUESTION);
    const provider = new MockAIProvider();
    provider.intentHandler = () => ({ intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER" }) as never;
    provider.responseHandler = () => "أهلا فيك";
    setMockAIProvider(provider);
    const res = await processAIMessage(
      asDb(),
      { conversationId: msg.conversationId, messageId: msg.messageId, workspaceId: WS },
      { vectorStore: { size: 1, search: async () => { throw new Error("search down"); } } as never }
    );
    expect(res.status).toBe("RESPONDED");
    expect(res.response).toBe("أهلا فيك");
  });
});

describe("d. the orphan sweep does not hold up the batch", () => {
  /** Holds the sweep's first candidate read open until `release` is called. */
  function holdSweep() {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const model = db.message as unknown as { findMany: (a: any) => Promise<unknown> };
    const base = model.findMany.bind(model);
    model.findMany = async (a) => {
      if (a?.where?.direction === "INBOUND" && a?.where?.senderType === "CUSTOMER" && a?.where?.createdAt) await gate;
      return base(a);
    };
    return () => release();
  }

  it("the batch runs while the sweep is still working", async () => {
    await db.backgroundJob.create({
      data: { workspaceId: WS, type: "process_ai_message", payload: { conversationId: "c1" }, runAfter: new Date(0) },
    } as never);
    const release = holdSweep();
    const ran: string[] = [];
    const run = processPendingJobs(
      asDb(),
      {
        process_ai_message: async () => {
          ran.push("reply");
          release();
          return { success: true };
        },
      } as never,
      { limit: 5 }
    );
    const winner = await Promise.race([run.then(() => "done"), sleep(2000).then(() => "stuck")]);
    release();
    expect(winner).toBe("done");
    expect(ran).toEqual(["reply"]);
  });

  it("a failing sweep does not fail the batch", async () => {
    await db.backgroundJob.create({
      data: { workspaceId: WS, type: "t_one", payload: {}, runAfter: new Date(0) },
    } as never);
    const model = db.message as unknown as { findMany: (a: any) => Promise<unknown> };
    const base = model.findMany.bind(model);
    model.findMany = async (a) => {
      if (a?.where?.direction === "INBOUND" && a?.where?.senderType === "CUSTOMER") throw new Error("sweep down");
      return base(a);
    };
    const res = await processPendingJobs(asDb(), { t_one: async () => ({ success: true }) } as never, { limit: 5 });
    expect(res.processed).toBe(1);
  });
});

describe("e. extraction has its own short limit", () => {
  const hangUntilAbort = (init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });

  it("one bounded attempt, then the reply still goes out", async () => {
    vi.stubEnv("AI_EXTRACTION_TIMEOUT_MS", "1000");
    let extractionCalls = 0;
    let responseCalls = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(body.messages[0].content).includes("Respond with a single valid JSON object")) {
        extractionCalls += 1;
        return hangUntilAbort(init);
      }
      responseCalls += 1;
      return Response.json({ choices: [{ message: { content: "أهلا فيك" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch;

    await createProduct(asDb(), { userId: "a", workspaceId: WS }, { name: NAME, sku: "R", price: 25, currency: "USD" } as never);
    const channelId = await makePage();
    const msg = await inbound(channelId, REAL_QUESTION);
    const started = Date.now();
    const res = await processAIMessage(
      asDb(),
      { conversationId: msg.conversationId, messageId: msg.messageId, workspaceId: WS },
      {
        vectorStore: { size: 0, search: async () => [] } as never,
        provider: new OpenAICompatibleProvider({ name: "internal", apiKey: "k", baseUrl: "http://llm.test/v1/chat/completions", defaultModel: "m", delivery: "internal" }),
      }
    );
    expect(extractionCalls).toBe(1);
    expect(responseCalls).toBe(1);
    expect(res.status).toBe("RESPONDED");
    expect(Date.now() - started).toBeLessThan(5000);
  }, 8000);

  it("AI_EXTRACTION_ATTEMPTS can restore a second attempt", async () => {
    vi.stubEnv("AI_EXTRACTION_TIMEOUT_MS", "1000");
    vi.stubEnv("AI_EXTRACTION_ATTEMPTS", "2");
    let extractionCalls = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(body.messages[0].content).includes("Respond with a single valid JSON object")) {
        extractionCalls += 1;
        return hangUntilAbort(init);
      }
      return Response.json({ choices: [{ message: { content: "أهلا فيك" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch;
    await createProduct(asDb(), { userId: "a", workspaceId: WS }, { name: NAME, sku: "R", price: 25, currency: "USD" } as never);
    const channelId = await makePage();
    const msg = await inbound(channelId, REAL_QUESTION);
    await processAIMessage(
      asDb(),
      { conversationId: msg.conversationId, messageId: msg.messageId, workspaceId: WS },
      {
        vectorStore: { size: 0, search: async () => [] } as never,
        provider: new OpenAICompatibleProvider({ name: "internal", apiKey: "k", baseUrl: "http://llm.test/v1/chat/completions", defaultModel: "m", delivery: "internal" }),
      }
    );
    expect(extractionCalls).toBe(2);
  }, 8000);

  function provider() {
    return new OpenAICompatibleProvider({ name: "p", apiKey: "k", baseUrl: "http://llm.test/v1/chat/completions", defaultModel: "m" });
  }

  it("a request with no limit of its own keeps AI_REQUEST_TIMEOUT_MS", async () => {
    vi.stubEnv("AI_REQUEST_TIMEOUT_MS", "1000");
    globalThis.fetch = ((_u: string, init?: RequestInit) => hangUntilAbort(init)) as typeof fetch;
    await expect(provider().generateText({ system: "s", user: "u" })).rejects.toThrow("after 1000ms");
  }, 4000);

  it("a request's own limit wins and is not sent to the model", async () => {
    vi.stubEnv("AI_REQUEST_TIMEOUT_MS", "60000");
    let sent: Record<string, unknown> = {};
    globalThis.fetch = ((_u: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return hangUntilAbort(init);
    }) as typeof fetch;
    const err = await provider().generateText({ system: "s", user: "u", timeoutMs: 1200 }).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderError);
    expect(err.message).toContain("after 1200ms");
    expect(err.retryable).toBe(true);
    expect(sent).not.toHaveProperty("timeoutMs");
  }, 4000);

  it("a body that stalls after the headers is still bounded by the request's own limit", async () => {
    globalThis.fetch = ((_u: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        type: "basic",
        headers: new Headers(),
        json: () => hangUntilAbort(init),
      } as unknown as Response)) as typeof fetch;
    const err = await provider().generateText({ system: "s", user: "u", timeoutMs: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderError);
    expect(err.message).toContain("after 1000ms");
  }, 4000);
});
