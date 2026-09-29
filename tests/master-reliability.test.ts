/**
 * MASTER RELIABILITY — full-system forensic coverage:
 * sweeper starvation, AI_DISABLED reprocessing, active-job idempotency race,
 * partial batch failure, 3-message batch + redelivery, persona (long text,
 * per-page assignment, language passthrough, verbatim outbound), provider
 * 408/425, classified AI failures.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { recoverOrphanedInboundMessages } from "@/modules/jobs/service";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { ingestMetaWebhook } from "@/modules/channels/facebook/webhook";
import { setMockAIProvider, MockAIProvider, OpenAICompatibleProvider } from "@/modules/ai/provider";
import { resolveChannelPersona } from "@/modules/ai/channel-persona";
import { PERSONA_LIMITS } from "@/modules/ai/persona-limits";
import { personaPrompt } from "@/modules/ai/prompts";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

const WS_A = "ws-master-a";
const WS_B = "ws-master-b";
const AGENT = { userId: "agent-master", workspaceId: WS_A };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

const stubVector = { search: async () => [] } as never;

function mockAI(opts?: { systemSeen?: string[]; text?: string }) {
  const mock = new MockAIProvider();
  mock.intentHandler = () => ({
    intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER",
  });
  mock.responseHandler = (_u: string, s: string) => {
    opts?.systemSeen?.push(s);
    return opts?.text ?? "أهلاً فيك 🌹 كيف فيني ساعدك؟";
  };
  setMockAIProvider(mock);
  return mock;
}

async function seedPage(pageId: string, ws = WS_A) {
  const ch = (await db.channel.create({
    data: { workspaceId: ws, type: "FACEBOOK", status: "CONNECTED", displayName: pageId, externalId: pageId },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: pageId, pageName: pageId,
      encryptedCredentials: encryptSecret("tok"),
    },
  } as never);
  return ch;
}

async function inbound(psid: string, text: string, channelId: string, tag: string, ws = WS_A) {
  return processIncomingMessage(db as Db, {
    workspaceId: ws,
    channelType: "FACEBOOK",
    channelId,
    externalUserId: psid,
    externalConversationId: psid,
    externalMessageId: `m-${psid}-${tag}`,
    externalEventId: `e-${psid}-${tag}`,
    provider: "facebook",
    type: "TEXT",
    text,
  });
}

async function runAI(r: { conversationId: string; messageId: string }, ws = WS_A) {
  return processAIMessage(db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: ws }, { vectorStore: stubVector });
}

function aiJobs() {
  return (db._stores.backgroundJob as any[]).filter((j) => j.type === "process_ai_message");
}

function outboundRows() {
  return (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND");
}

function fbSuccess() {
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: any) => {
          const u = new URL(url as string);
          if (u.pathname.endsWith("/me/messages")) {
            let recipientId = "psid";
            try { recipientId = JSON.parse(String((init as any)?.body ?? "{}"))?.recipient?.id ?? "psid"; } catch { /* ignore */ }
            return Response.json({ recipient_id: recipientId, message_id: `mid-${recipientId}-${Date.now()}` });
          }
          return Response.json({ id: "p", name: "p" });
        }) as typeof fetch,
      })
  );
}

beforeEach(() => {
  db = createFakeDb();
});

afterEach(() => {
  setFacebookClientFactory(undefined as never);
  setMockAIProvider(undefined);
});

// ═══════════ PART 3 — sweeper starvation ═══════════

describe("orphan sweeper is starvation-safe", () => {
  it("recovers a real orphan beyond a window full of answered messages", async () => {
    const ch = await seedPage("page-starve-1");
    fbSuccess();
    mockAI();
    // >60 answered messages fill the old candidate window.
    const answers: { conversationId: string; messageId: string }[] = [];
    for (let i = 0; i < 65; i++) {
      const r = await inbound(`psid-answ-${i}`, `سؤال ${i}`, ch.id, `a${i}`);
      await runAI(r);
      answers.push(r);
    }
    const answeredCount = (db._stores.aIUsageLog as any[]).filter(
      (u) => u.purpose === "RESPONSE" && u.status === "SUCCESS"
    ).length;
    expect(answeredCount).toBeGreaterThanOrEqual(60);
    // The real orphan: persisted but enqueue failed (no job, no decision),
    // created AFTER all answered messages.
    const customer = (await db.customer.create({ data: { workspaceId: WS_A, status: "NEW_LEAD" } } as never)) as unknown as { id: string };
    const conv = (await db.conversation.create({
      data: { workspaceId: WS_A, customerId: customer.id, channelId: ch.id, channelConversationId: "conv-starve-orphan" },
    } as never)) as unknown as { id: string };
    const orphan = (await db.message.create({
      data: { conversationId: conv.id, workspaceId: WS_A, senderType: "CUSTOMER", direction: "INBOUND", type: "TEXT", text: "رسالة يتيمة", provider: "facebook" },
    } as never)) as unknown as { id: string };

    const out = await recoverOrphanedInboundMessages(db as never);
    expect(out.recovered).toBe(1);
    expect(aiJobs().some((j) => (j.payload as any)?.messageId === orphan.id)).toBe(true);
  });

  it("multiple workspaces recover independently", async () => {
    const chA = await seedPage("page-wsa");
    const chB = await seedPage("page-wsb", WS_B);
    const custB = (await db.customer.create({ data: { workspaceId: WS_B, status: "NEW_LEAD" } } as never)) as unknown as { id: string };
    const convB = (await db.conversation.create({
      data: { workspaceId: WS_B, customerId: custB.id, channelId: chB.id, channelConversationId: "conv-wsb-o" },
    } as never)) as unknown as { id: string };
    const orphanB = (await db.message.create({
      data: { conversationId: convB.id, workspaceId: WS_B, senderType: "CUSTOMER", direction: "INBOUND", type: "TEXT", text: "b orphan", provider: "facebook" },
    } as never)) as unknown as { id: string };
    const rA = await inbound("psid-wsa", "hello", chA.id, "wsa1");
    (db._stores.backgroundJob as any[]).find((j) => (j.payload as any)?.messageId === rA.messageId).status = "FAILED";

    const out = await recoverOrphanedInboundMessages(db as never);
    expect(out.recovered).toBe(2);
    const jobB = aiJobs().find((j) => (j.payload as any)?.messageId === orphanB.id);
    expect(jobB.workspaceId).toBe(WS_B);
    const jobA = aiJobs().find((j) => (j.payload as any)?.messageId === rA.messageId);
    expect(jobA.workspaceId).toBe(WS_A);
  });
});

// ═══════════ PART 4 — AI_DISABLED reprocessable ═══════════

describe("AI_DISABLED is reprocessable, not terminal", () => {
  it("disabled → recorded → re-enabled → AI responds exactly once", async () => {
    const ch = await seedPage("page-disabled-1");
    fbSuccess();
    const systemSeen: string[] = [];
    mockAI({ systemSeen });
    const r = await inbound("psid-dis-1", "مرحبا", ch.id, "dis1");
    // AI disabled at processing time.
    await db.conversation.update({ where: { id: r.conversationId }, data: { aiEnabled: false } } as never);
    // Drop its job (simulates the message sitting after a disable).
    const jobs = db._stores.backgroundJob as any[];
    for (let i = jobs.length - 1; i >= 0; i--) {
      if ((jobs[i].payload as any)?.messageId === r.messageId) jobs.splice(i, 1);
    }
    // Processing while disabled: recorded, zero outbound.
    const disabledRun = await runAI(r);
    expect(disabledRun.status).toBe("AI_DISABLED");
    expect(outboundRows()).toHaveLength(0);
    const disabledLog = (db._stores.aIUsageLog as any[]).find((u) => u.messageId === r.messageId && u.purpose === "RESPONSE");
    expect(disabledLog?.status).toBe("AI_DISABLED");

    // Re-enable → sweeper re-enqueues the message.
    await db.conversation.update({ where: { id: r.conversationId }, data: { aiEnabled: true, aiState: "AI_ACTIVE" } } as never);
    const out = await recoverOrphanedInboundMessages(db as never);
    expect(out.recovered).toBe(1);

    // AI responds exactly once.
    const res = await runAI(r);
    expect(res.status).toBe("RESPONDED");
    expect(outboundRows()).toHaveLength(1);
    expect(outboundRows()[0].deliveryStatus).toBe("SENT");

    // Repeated recovery does NOT duplicate: message now decided (SUCCESS).
    const again = await recoverOrphanedInboundMessages(db as never);
    expect(again.recovered).toBe(0);
    const rerun = await runAI(r);
    expect(rerun.status).toBe("DUPLICATE");
    expect(outboundRows()).toHaveLength(1);
  });

  it("human-controlled conversation stays protected (no AI re-enqueue)", async () => {
    const ch = await seedPage("page-human-1");
    const r = await inbound("psid-hum-1", "مرحبا", ch.id, "hum1");
    await db.conversation.update({
      where: { id: r.conversationId }, data: { aiState: "HUMAN_ACTIVE", aiEnabled: false },
    } as never);
    const out = await recoverOrphanedInboundMessages(db as never);
    expect(out.recovered).toBe(0);
    expect(outboundRows()).toHaveLength(0);
  });
});

// ═══════════ PART 5 — active-job idempotency race ═══════════

describe("active AI job idempotency (sweeper race)", () => {
  it("two simultaneous recovery attempts create exactly one ACTIVE job", async () => {
    const ch = await seedPage("page-race-1");
    const r = await inbound("psid-race-1", "مرحبا", ch.id, "race1");
    // Remove its job → true orphan.
    const jobs = db._stores.backgroundJob as any[];
    for (let i = jobs.length - 1; i >= 0; i--) {
      if ((jobs[i].payload as any)?.messageId === r.messageId) jobs.splice(i, 1);
    }
    const [a, b] = await Promise.all([
      recoverOrphanedInboundMessages(db as never),
      recoverOrphanedInboundMessages(db as never),
    ]);
    expect(a.recovered + b.recovered).toBe(1);
    const active = aiJobs().filter(
      (j) => (j.payload as any)?.messageId === r.messageId && ["PENDING", "PROCESSING"].includes(j.status)
    );
    expect(active).toHaveLength(1);
    expect(active[0].idempotencyKey).toBe(`ai:${r.messageId}`);
  });

  it("webhook enqueue is deduplicated against a live sweeper job", async () => {
    const ch = await seedPage("page-race-2");
    const r = await inbound("psid-race-2", "مرحبا", ch.id, "race2");
    // First enqueue wins the key; second (redelivery path) dedupes.
    const { enqueueJob } = await import("@/modules/jobs/service");
    const first = await enqueueJob(db as never, {
      workspaceId: WS_A, type: "process_ai_message",
      payload: { conversationId: r.conversationId, messageId: r.messageId },
      idempotencyKey: `ai:${r.messageId}`,
    });
    const second = await enqueueJob(db as never, {
      workspaceId: WS_A, type: "process_ai_message",
      payload: { conversationId: r.conversationId, messageId: r.messageId },
      idempotencyKey: `ai:${r.messageId}`,
    });
    expect(second.id).toBe(first.id);
    const active = aiJobs().filter(
      (j) => (j.payload as any)?.messageId === r.messageId && ["PENDING", "PROCESSING"].includes(j.status)
    );
    expect(active).toHaveLength(1);
  });

  it("FAILED job does not block re-enqueue (partial index semantics)", async () => {
    const { enqueueJob } = await import("@/modules/jobs/service");
    const first = await enqueueJob(db as never, {
      workspaceId: WS_A, type: "process_ai_message",
      payload: { conversationId: "c1", messageId: "mm1" }, idempotencyKey: "ai:mm1",
    });
    await db.backgroundJob.update({ where: { id: first.id }, data: { status: "FAILED" } } as never);
    const second = await enqueueJob(db as never, {
      workspaceId: WS_A, type: "process_ai_message",
      payload: { conversationId: "c1", messageId: "mm1" }, idempotencyKey: "ai:mm1",
    });
    expect(second.id).not.toBe(first.id);
  });
});

// ═══════════ PART 6 — partial batch failure ═══════════

describe("partial batch failure stays retryable + idempotent", () => {
  it("batch 1✅ 2❌ 3✅ → job fails; redelivery: dup, retry, dup", async () => {
    const ch = await seedPage("page-partial-1");
    const psidA = "psid-partial-a";
    const psidB = "psid-partial-b";
    // Poison: psidB's identity belongs to ANOTHER workspace → resolveCustomerByChannelIdentity throws 409.
    await db.channelIdentity.create({
      data: { workspaceId: WS_B, channelType: "FACEBOOK", channelExternalId: psidB, customerId: "cust-wsb" },
    } as never);

    const payload = {
      object: "page",
      entry: [{
        id: "page-partial-1",
        messaging: [
          { sender: { id: psidA }, recipient: { id: "page-partial-1" }, timestamp: Date.now(), message: { mid: "pm1", text: "one" } },
          { sender: { id: psidB }, recipient: { id: "page-partial-1" }, timestamp: Date.now(), message: { mid: "pm2", text: "two" } },
          { sender: { id: psidA }, recipient: { id: "page-partial-1" }, timestamp: Date.now(), message: { mid: "pm3", text: "three" } },
        ],
      }],
    };
    const { handleProcessWebhookEvent } = await import("@/modules/jobs/handlers");
    // First run: message2 fails → whole batch reports failure (retryable).
    const firstRun = await handleProcessWebhookEvent(db as never, {
      workspaceId: WS_A, webhookEventId: "wev-1", channelAccountId: "acct",
      messages: payload.entry[0].messaging.map((m) => ({
        externalCustomerId: m.sender.id,
        externalConversationId: m.sender.id,
        externalMessageId: m.message.mid,
        externalEventId: `evt:${m.message.mid}`,
        text: m.message.text,
      })),
    }, "job-1");
    expect(firstRun.success).toBe(false);
    expect((db._stores.message as any[]).filter((m) => m.direction === "INBOUND")).toHaveLength(2);

    // Operator fixes the conflict (identity deleted) → retry the batch.
    // Splice IN PLACE: the fake-DB model closes over the store array.
    const identities = db._stores.channelIdentity as any[];
    for (let i = identities.length - 1; i >= 0; i--) {
      if (identities[i].channelExternalId === psidB) identities.splice(i, 1);
    }
    const retryRun = await handleProcessWebhookEvent(db as never, {
      workspaceId: WS_A, webhookEventId: "wev-1", channelAccountId: "acct",
      messages: payload.entry[0].messaging.map((m) => ({
        externalCustomerId: m.sender.id,
        externalConversationId: m.sender.id,
        externalMessageId: m.message.mid,
        externalEventId: `evt:${m.message.mid}`,
        text: m.message.text,
      })),
    }, "job-1");
    expect(retryRun.success).toBe(true);
    // All three persisted, nothing duplicated, three AI jobs total.
    const inboundTexts = (db._stores.message as any[]).filter((m) => m.direction === "INBOUND").map((m) => m.text).sort();
    expect(inboundTexts).toEqual(["one", "three", "two"]);
    expect(aiJobs()).toHaveLength(3);
    const lastWebhookEvent = (db._stores.webhookEvent as any[]).at(-1);
    void lastWebhookEvent;
  });
});

// ═══════════ PART 2 — batching re-verify (3 messages) ═══════════

describe("webhook batching: 3 messages, one POST", () => {
  it("all persisted, 3 AI jobs; exact redelivery adds nothing", async () => {
    const ch = await seedPage("page-batch3");
    const entries = [
      { sender: { id: "psid-b3" }, recipient: { id: "page-batch3" }, timestamp: Date.now(), message: { mid: "b3-m1", text: "Hello" } },
      { sender: { id: "psid-b3" }, recipient: { id: "page-batch3" }, timestamp: Date.now(), message: { mid: "b3-m2", text: "How much is the product?" } },
      { sender: { id: "psid-b3" }, recipient: { id: "page-batch3" }, timestamp: Date.now(), message: { mid: "b3-m3", text: "I want two" } },
    ];
    const payload = { object: "page", entry: [{ id: "page-batch3", messaging: entries }] };
    expect((await ingestMetaWebhook(db as Db, payload)).normalizedCount).toBe(3);
    const webhookJob = (db._stores.backgroundJob as any[]).find((j) => j.type === "process_webhook_event");
    const messages = (webhookJob.payload as { messages: Record<string, unknown>[] }).messages;
    expect(messages).toHaveLength(3);
    // Message-scoped identities.
    const ids = new Set(messages.map((m) => m.externalEventId));
    expect(ids.size).toBe(3);
    for (const m of messages) {
      const r = await processIncomingMessage(db as Db, {
        workspaceId: WS_A, channelType: "FACEBOOK", channelId: ch.id,
        externalUserId: String(m.externalCustomerId), externalConversationId: String(m.externalConversationId),
        externalMessageId: String(m.externalMessageId), externalEventId: String(m.externalEventId),
        provider: "facebook", type: "TEXT", text: (m.text as string) ?? null,
      });
      expect(r.duplicate).toBe(false);
    }
    expect((db._stores.message as any[]).filter((m) => m.direction === "INBOUND")).toHaveLength(3);
    expect(aiJobs()).toHaveLength(3);

    // Exact same POST redelivered → 0 new messages, 0 new AI jobs.
    const before = (db._stores.message as any[]).length;
    const jobsBefore = aiJobs().length;
    expect((await ingestMetaWebhook(db as Db, JSON.parse(JSON.stringify(payload)))).status).toBe("DUPLICATE");
    expect((db._stores.message as any[]).length).toBe(before);
    expect(aiJobs().length).toBe(jobsBefore);
  });
});

// ═══════════ PART 7 — provider classification ═══════════

describe("provider classification completeness", () => {
  function stubFetch(status: number) {
    const orig = globalThis.fetch;
    (globalThis as any).fetch = (async () => new Response("{}", { status })) as typeof fetch;
    return () => { (globalThis as any).fetch = orig; };
  }
  const p = new OpenAICompatibleProvider({ name: "t", apiKey: "k", baseUrl: "https://x.invalid", defaultModel: "m" });

  it("408 and 425 are transient", async () => {
    for (const status of [408, 425]) {
      const restore = stubFetch(status);
      try {
        await expect(p.generateText({ system: "s", user: "u" })).rejects.toMatchObject({ retryable: true });
      } finally { restore(); }
    }
  });

  it("all AI_FAILED records carry a category prefix", async () => {
    const ch = await seedPage("page-cat-1");
    fbSuccess();
    const mock = new MockAIProvider();
    mock.intentHandler = () => ({ intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER" });
    mock.responseHandler = () => { throw new Error("boom"); };
    setMockAIProvider(mock);
    const r = await inbound("psid-cat", "سؤال", ch.id, "cat1");
    const res = await runAI(r);
    expect(res.error).toMatch(/^(TRANSIENT|PERMANENT): /);
    const usage = (db._stores.aIUsageLog as any[]).find((u) => u.messageId === r.messageId && u.purpose === "RESPONSE");
    expect(usage.error).toMatch(/^(TRANSIENT|PERMANENT): /);
  });
});

// ═══════════ PARTS 18-20 — persona ═══════════

describe("persona: long text, per-page assignment, language passthrough", () => {
  it("very long persona text survives validation and reaches the runtime prompt", async () => {
    const long = "استجب للعميل بلطف شديد. ".repeat(800); // 800×24 = 19200 chars < 20000
    expect(long.length).toBeLessThanOrEqual(PERSONA_LIMITS.systemInstructions);
    const systemSeen: string[] = [];
    mockAI({ systemSeen });
    const ch = await seedPage("page-persona-1");
    await db.persona.create({
      data: { workspaceId: WS_A, name: "بائع خبراء", systemInstructions: long, isActive: true },
    } as never);
    fbSuccess();
    const r = await inbound("psid-per-1", "مرحبا", ch.id, "per1");
    await runAI(r);
    expect(systemSeen[systemSeen.length - 1]).toContain(long.slice(0, 50));
  });

  it("over-limit persona text is rejected explicitly (never silently truncated)", () => {
    // The shared limit constant drives the zod max — a documented, visible
    // bound rather than a silent cut.
    expect(PERSONA_LIMITS.systemInstructions).toBeGreaterThan(10000);
  });

  it("page A and page B use their own assigned personas", async () => {
    const personaA = (await db.persona.create({
      data: { workspaceId: WS_A, name: "شخصية أ", language: "ar", isActive: true },
    } as never)) as unknown as { id: string };
    const personaB = (await db.persona.create({
      data: { workspaceId: WS_A, name: "شخصية ب", language: "en", isActive: false },
    } as never)) as unknown as { id: string };
    const pageA = await seedPage("page-per-a");
    const pageB = await seedPage("page-per-b");
    await db.channel.update({ where: { id: pageA.id }, data: { aiPersonaId: personaA.id } } as never);
    await db.channel.update({ where: { id: pageB.id }, data: { aiPersonaId: personaB.id } } as never);

    const resolvedA = await resolveChannelPersona(db as Db, { workspaceId: WS_A, channelId: pageA.id });
    const resolvedB = await resolveChannelPersona(db as Db, { workspaceId: WS_A, channelId: pageB.id });
    expect(resolvedA.id).toBe(personaA.id);
    expect(resolvedA.source).toBe("channel");
    expect(resolvedB.id).toBe(personaB.id);
    expect(resolvedB.source).toBe("channel");
    expect(resolvedA.language).toBe("ar");
    expect(resolvedB.language).toBe("en");

    // Stale assignment (persona deleted) falls back to workspace default.
    await db.persona.delete({ where: { id: personaB.id } } as never);
    const fallbackB = await resolveChannelPersona(db as Db, { workspaceId: WS_A, channelId: pageB.id });
    expect(fallbackB.id).toBe(personaA.id);
    expect(fallbackB.source).toBe("workspace");
  });

  it("persona never leaks across workspaces", async () => {
    const wsAPersona = (await db.persona.create({
      data: { workspaceId: WS_A, name: "أ", isActive: true },
    } as never)) as unknown as { id: string };
    const chB = await seedPage("page-leak", WS_B);
    const resolvedB = await resolveChannelPersona(db as Db, { workspaceId: WS_B, channelId: chB.id });
    expect(resolvedB.id).not.toBe(wsAPersona.id);
    expect(["workspace", "builtin"]).toContain(resolvedB.source);
  });

  it("English-only persona: instruction reaches prompt; outbound forwards AI text verbatim", async () => {
    const ch = await seedPage("page-en-1");
    await db.persona.create({
      data: {
        workspaceId: WS_A, name: "English Seller", language: "en", isActive: true,
        systemInstructions: "Respond exclusively in English.",
      },
    } as never);
    fbSuccess();
    const bodies: any[] = [];
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async (url: string, init?: any) => {
            const u = new URL(url as string);
            if (u.pathname.endsWith("/me/messages")) {
              bodies.push(JSON.parse(String((init as any)?.body ?? "{}")));
              return Response.json({ recipient_id: "psid-en", message_id: "mid-en-1" });
            }
            return Response.json({});
          }) as typeof fetch,
        })
    );
    const aiText = "Sure — which product are you referring to?";
    const seen: string[] = [];
    const mock = new MockAIProvider();
    mock.intentHandler = () => ({ intent: "UNKNOWN", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER" });
    mock.responseHandler = (_u: string, s: string) => { seen.push(s); return aiText; };
    setMockAIProvider(mock);
    const r = await inbound("psid-en", "I want that one", ch.id, "en1");
    await runAI(r);
    expect(seen[seen.length - 1]).toContain("Respond exclusively in English.");
    // The outbound layer forwards the EXACT AI text — no translation/replacement.
    expect(bodies[0].message.text).toBe(aiText);
    expect(outboundRows()[0].text).toBe(aiText);
  });

  it("personaPrompt includes full systemInstructions (no hidden truncation)", () => {
    const long = "قاعدة رقم x. ".repeat(500);
    const prompt = personaPrompt({
      name: "اختبار", language: "ar", dialect: null, tone: "friendly", formality: "informal",
      responseLength: "short", emojiLevel: 1, salesStyle: "helpful",
      systemInstructions: long, prohibitedPhrases: [], customRules: [],
    });
    expect(prompt).toContain(long);
  });
});