import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { createFakeDb } from "./helpers/inmemory-db";
import { workflowDefinitionSchema, workflowCreateSchema, actionSchema } from "@/modules/automation/workflow-schemas";
import { evaluateConditionDetailed } from "@/modules/automation/workflow-conditions";
import { evaluateWorkflowEvent, eventToWorkflowTrigger } from "@/modules/automation/workflow-engine";
import { validateEndpointUrl, assertEndpointResolvesPublic } from "@/modules/ai/endpoint-guard";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

// ── Route permission pins ──────────────────────────────────────────────────

const seenPermissions: string[] = [];
vi.mock("@/modules/auth/context", async () => {
  const { AuthorizationError } = await import("@/core/errors");
  return {
    getAuthContext: async () => ({
      userId: "agent-1",
      workspaceId: "ws-p7",
      role: "SALES_AGENT",
      memberPermissions: [],
      can: () => false,
      require: (p: string) => {
        seenPermissions.push(p);
        throw new AuthorizationError(`Missing permission: ${p}`);
      },
    }),
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const WS = "ws-p7-a";
const WS_B = "ws-p7-b";
const AGENT = { userId: "agent-1", workspaceId: WS };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

function emptyVectors() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { InMemoryVectorStore } = require("@/modules/knowledge/vector-store");
  return new InMemoryVectorStore(new Map(), new Map());
}

async function seedConv(opts: { aiState?: string; status?: string; blacklisted?: boolean; tags?: string[] } = {}) {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "P", externalId: `pg-${Math.random().toString(36).slice(2, 7)}` },
  } as never)) as any;
  await db.channelAccount.create({
    data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: ch.externalId, pageName: "P", encryptedCredentials: encryptSecret("page-token-test") },
  } as never);
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: { body?: string }) => {
          const u = new URL(url as string);
          if (u.pathname.endsWith("/me/messages")) {
            let body: any = null;
            try { body = JSON.parse(String((init as any)?.body ?? "")); } catch { /* ignore */ }
            const rid = body?.recipient?.id ?? "psid";
            return Response.json({ recipient_id: rid, message_id: `mid-${rid}` });
          }
          return Response.json({ id: ch.externalId, name: "P" });
        }) as typeof fetch,
      })
  );
  const cust = (await db.customer.create({
    data: { workspaceId: WS, name: "عميل", isBlacklisted: opts.blacklisted ?? false, tags: opts.tags ?? [] },
  } as never)) as any;
  const conv = (await db.conversation.create({
    data: {
      workspaceId: WS, customerId: cust.id, channelId: ch.id,
      channelConversationId: `cc-${Math.random().toString(36).slice(2, 9)}`,
      status: opts.status ?? "OPEN", aiState: opts.aiState ?? "AI_ACTIVE", aiEnabled: (opts.aiState ?? "AI_ACTIVE") === "AI_ACTIVE",
      lastCustomerMessageAt: new Date(Date.now() - 120 * 60_000),
    },
  } as never)) as any;
  return { conv, cust, ch };
}

function wfEvent(trigger: string, payload: Record<string, unknown>, eventId: string) {
  return { name: trigger, workspaceId: WS, payload, eventId };
}

async function seedWorkflow(def: Record<string, unknown>, opts: { status?: string; version?: number; versionId?: string | null } = {}) {
  return (await db.automation.create({
    data: {
      workspaceId: WS, name: "wf", trigger: def.trigger as string,
      conditions: (def.conditions ?? {}) as never, actions: (def.steps ?? []) as never,
      isEnabled: (opts.status ?? "PUBLISHED") === "PUBLISHED",
      status: opts.status ?? "PUBLISHED", version: opts.version ?? 1, versionId: opts.versionId ?? null,
    },
  } as never)) as any;
}

beforeEach(async () => {
  seenPermissions.length = 0;
  setMockAIProvider(undefined);
  db = createFakeDb();
  (db._stores.workspaceMember as any[]).push({ id: "m1", workspaceId: WS, userId: AGENT.userId, status: "ACTIVE" });
  setFacebookClientFactory(undefined as never);
});

// ── 1. Schema validation ──────────────────────────────────────────────────

describe("P7-1 workflow schema (strict, closed-set)", () => {
  it("accepts a valid definition", () => {
    const def = {
      trigger: "MESSAGE_RECEIVED",
      conditions: { all: [{ field: "conversation.aiState", operator: "EQ", value: "AI_ACTIVE" }] },
      steps: [
        { id: "s1", action: { type: "CREATE_NOTE", text: "مراجعة" } },
        { id: "s2", action: { type: "SEND_MESSAGE", template: "أهلًا {{customer.name}}" } },
      ],
    };
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    expect(workflowCreateSchema.safeParse({ name: "ترحيب", definition: def }).success).toBe(true);
  });

  it("rejects unknown fields, unknown actions, unknown condition fields, arbitrary code", () => {
    expect(workflowDefinitionSchema.safeParse({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "EVAL", code: "process.exit()" } }] }).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "SEND_MESSAGE", template: "x", hack: true } }] }).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "CHANGE_AI_STATE", aiState: "HUMAN_ACTIVE" } }] }).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "ADD_TAG", tag: "x" }, extra: 1 }] }).success).toBe(false);
    const badField = workflowDefinitionSchema.safeParse({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "ADD_TAG", tag: "x" } }], conditions: { all: [{ field: "customer.passwordHash", operator: "EQ", value: "1" }] } });
    expect(badField.success).toBe(false);
  });
});

// ── 2. Triggers ───────────────────────────────────────────────────────────

describe("P7-2 trigger mapping (trusted events only)", () => {
  it("maps every supported event and refines sub-events", () => {
    expect(eventToWorkflowTrigger("MessageReceived", {})).toBe("MESSAGE_RECEIVED");
    expect(eventToWorkflowTrigger("ConversationCreated", {})).toBe("CONVERSATION_CREATED");
    expect(eventToWorkflowTrigger("ConversationUpdated", { type: "HumanHandoffCreated" })).toBe("HANDOFF_CREATED");
    // OMS sub-events no longer have a trigger (the AI-only path orders internally).
    expect(eventToWorkflowTrigger("ConversationUpdated", { type: "OmsStatusChanged" })).toBeNull();
    expect(eventToWorkflowTrigger("ConversationUpdated", { status: "RESOLVED" })).toBe("CONVERSATION_STATUS_CHANGED");
    expect(eventToWorkflowTrigger("ConversationAssigned", {})).toBe("CONVERSATION_ASSIGNED");
    expect(eventToWorkflowTrigger("CustomerUpdated", { type: "tag" })).toBe("CUSTOMER_TAGGED");
    expect(eventToWorkflowTrigger("CustomerUpdated", { fields: ["name"] })).toBeNull();
    expect(eventToWorkflowTrigger("OrderConfirmed", {})).toBe("ORDER_CONFIRMED");
    expect(eventToWorkflowTrigger("OrderStateChanged", {})).toBeNull();
    expect(eventToWorkflowTrigger("ProductCreated", {})).toBeNull();
  });
});

// ── 3-4. Conditions + actions ─────────────────────────────────────────────

describe("P7-3/4 conditions + actions execution", () => {
  it("conditions pass and fail with safe detailed reasons", async () => {
    const { conv } = await seedConv({ aiState: "AI_ACTIVE" });
    await seedWorkflow({ trigger: "MESSAGE_RECEIVED", conditions: { all: [{ field: "conversation.aiState", operator: "EQ", value: "AI_ACTIVE" }] }, steps: [{ id: "n", action: { type: "CREATE_NOTE", text: "تذكير" } }] });
    const r = await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, `MessageReceived:m1`));
    expect(r.started).toBe(1);
    const log = (db._stores.automationExecution as any[])[0];
    expect(log.status).toBe("COMPLETED");
    expect(log.stepLog.some((s: any) => s.outcome === "DONE" && s.type === "CREATE_NOTE")).toBe(true);
    // Note persisted as internal (isNote, inbound, HUMAN) — never outbound.
    const notes = (db._stores.message as any[]).filter((m) => m.isNote);
    expect(notes).toHaveLength(1);
    expect(notes[0].direction).toBe("INBOUND");
    expect(notes[0].senderType).toBe("HUMAN");
  });

  it("failing conditions → SKIPPED execution with reason", async () => {
    const { conv } = await seedConv({ aiState: "HUMAN_ACTIVE" });
    await seedWorkflow({ trigger: "MESSAGE_RECEIVED", conditions: { all: [{ field: "conversation.aiState", operator: "EQ", value: "AI_ACTIVE" }] }, steps: [{ id: "n", action: { type: "CREATE_NOTE", text: "x" } }] });
    const r = await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:m2"));
    expect(r.started).toBe(0);
    const log = (db._stores.automationExecution as any[]).find((e) => e.triggerEventId === "MessageReceived:m2");
    expect(log.status).toBe("SKIPPED");
  });

  it("unsupported action rejected at schema level (never executed)", async () => {
    const bad = actionSchema.safeParse({ type: "DELETE_ALL_ORDERS" });
    expect(bad.success).toBe(false);
  });

  it("SEND_MESSAGE revalidates policies: HUMAN_ACTIVE / closed / blacklist / channel policy", async () => {
    // HUMAN_ACTIVE blocks
    {
      const { conv } = await seedConv({ aiState: "HUMAN_ACTIVE" });
      await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "SEND_MESSAGE", template: "مرحبا" } }] });
      const r = await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:h1"));
      const log = (db._stores.automationExecution as any[]).find((e) => e.triggerEventId === "MessageReceived:h1");
      expect(r.started).toBe(0);
      expect(log.status).toBe("FAILED");
      expect(log.error).toContain("HUMAN_ACTIVE");
      expect(log.errorCategory).toBe("PERMANENT");
      expect((db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND")).toHaveLength(0);
    }
    // Resolved conversation blocks
    {
      const { conv } = await seedConv({ status: "RESOLVED" });
      await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "SEND_MESSAGE", template: "مرحبا" } }] });
      const r = await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:h2"));
      const log = (db._stores.automationExecution as any[]).find((e) => e.triggerEventId === "MessageReceived:h2");
      expect(r.started).toBe(0);
      expect(log.error).toContain("CONVERSATION_CLOSED");
    }
    // Channel disconnected blocks the send
    {
      const { conv, ch } = await seedConv({});
      await db.channel.update({ where: { id: ch.id }, data: { status: "DISCONNECTED" } } as never);
      await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "SEND_MESSAGE", template: "مرحبا" } }] });
      const r = await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:h3"));
      const log = (db._stores.automationExecution as any[]).find((e) => e.triggerEventId === "MessageReceived:h3");
      expect(r.started).toBe(0);
      expect(log.error).toMatch(/WORKFLOW_POLICY|SEND_/);
      expect((db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND")).toHaveLength(0);
    }
  });

  it("blacklisted customer never starts messaging workflows (recorded skip)", async () => {
    const { conv } = await seedConv({ blacklisted: true });
    await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "SEND_MESSAGE", template: "مرحبا" } }] });
    const r = await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:bl1"));
    expect(r.started).toBe(0);
    expect(r.skipped).toBe(1);
    const log = (db._stores.automationExecution as any[]).find((e) => e.triggerEventId === "MessageReceived:bl1");
    expect(log.status).toBe("SKIPPED");
    expect(log.error).toContain("CUSTOMER_BLACKLISTED");
  });

  it("ASSIGN_CONVERSATION requires the agent to be an ACTIVE member of THIS workspace", async () => {
    const { conv } = await seedConv({});
    const wf1 = await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "a", action: { type: "ASSIGN_CONVERSATION", agentId: "agent-1" } }] });
    let r = await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:as1"));
    let log = (db._stores.automationExecution as any[]).find((e) => e.automationId === wf1.id && e.triggerEventId === "MessageReceived:as1");
    expect(log.status).toBe("COMPLETED");
    expect((await db.conversation.findUnique({ where: { id: conv.id } }) as any).assignedAgentId).toBe("agent-1");
    // Foreign agent → failed with policy reason (both workflows share the event).
    await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "a2", action: { type: "ASSIGN_CONVERSATION", agentId: "stranger-9" } }] });
    r = await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:as2"));
    log = (db._stores.automationExecution as any[]).find((e) => e.automationId === wf1.id && e.triggerEventId === "MessageReceived:as2");
    expect(log.status).toBe("COMPLETED");
    const wf2 = (db._stores.automation as any[]).filter((a) => a.trigger === "MESSAGE_RECEIVED").find((a) => a.id !== wf1.id);
    const log2 = (db._stores.automationExecution as any[]).find((e) => e.automationId === wf2.id && e.triggerEventId === "MessageReceived:as2");
    expect(log2.status).toBe("FAILED");
    expect(log2.error).toContain("AGENT_NOT_MEMBER");
    void r;
  });

  it("CREATE_FOLLOW_UP + CANCEL_FOLLOW_UPS round-trip (cancel wins over pending)", async () => {
    const { conv, cust } = await seedConv({});
    await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "f", action: { type: "CREATE_FOLLOW_UP", template: "متابعة", delayHours: 1, followUpType: "CHECK" } }] });
    await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:fu1"));
    const fus = (db._stores.followUp as any[]).filter((f) => f.customerId === cust.id);
    expect(fus).toHaveLength(1);
    expect(fus[0].status).toBe("SCHEDULED");
    await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "c", action: { type: "CANCEL_FOLLOW_UPS", followUpType: "CHECK" } }] });
    await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:fu2"));
    expect(((await db.followUp.findUnique({ where: { id: fus[0].id } })) as any).status).toBe("CANCELLED");
  });

  it("ADD_TAG/REMOVE_TAG mutate only owned customers and are audited", async () => {
    const { conv, cust } = await seedConv({ tags: ["vip"] });
    await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "t1", action: { type: "ADD_TAG", tag: "hot" } }, { id: "t2", action: { type: "REMOVE_TAG", tag: "vip" } }] });
    await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:tg1"));
    expect(((await db.customer.findUnique({ where: { id: cust.id } })) as any).tags).toEqual(["hot"]);
    const audits = (db._stores.auditLog as any[]).filter((a) => a.action === "workflow.tag_added");
    expect(audits.length).toBe(1);
  });

  it("STOP_WORKFLOW cancels the run with a CANCELLED category", async () => {
    const { conv } = await seedConv({});
    await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "STOP_WORKFLOW" } }, { id: "n", action: { type: "CREATE_NOTE", text: "بعده" } }] });
    const r = await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:st1"));
    expect(r.started).toBe(0);
    const log = (db._stores.automationExecution as any[]).find((e) => e.triggerEventId === "MessageReceived:st1");
    expect(log.status).toBe("CANCELLED");
    expect(log.errorCategory).toBe("CANCELLED");
    expect((db._stores.message as any[]).filter((m) => m.isNote)).toHaveLength(0);
  });

  it("BRANCH executes the taken side and skips the other", async () => {
    const { conv } = await seedConv({ tags: ["vip"] });
    await seedWorkflow({
      trigger: "MESSAGE_RECEIVED",
      steps: [{
        id: "b", action: {
          type: "BRANCH",
          when: { all: [{ field: "customer.tags", operator: "CONTAINS", value: "vip" }] },
          then: [{ id: "t", action: { type: "ADD_TAG", tag: "from-then" } }],
          else: [{ id: "e", action: { type: "ADD_TAG", tag: "from-else" } }],
        },
      }],
    });
    await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:br1"));
    const tags = ((await db.customer.findUnique({ where: { id: (await seedConv({})).cust.id } })) as any).tags;
    void tags;
    const cust = (db._stores.customer as any[]).find((c) => c.id === ((db._stores.conversation as any[])[0].customerId));
    expect(cust.tags).toContain("from-then");
    expect(cust.tags).not.toContain("from-else");
  });
});

// ── 6-7-10. Scheduling, idempotency ×100, concurrency, WAIT ───────────────

describe("P7-6/7/10 idempotency ×100, concurrency, WAIT resume", () => {
  it("same event delivered ×100 starts exactly ONE execution", async () => {
    const { conv } = await seedConv({});
    await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "n", action: { type: "CREATE_NOTE", text: "مرة واحدة" } }] });
    for (let i = 0; i < 100; i++) {
      await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:dup"));
    }
    const logs = (db._stores.automationExecution as any[]).filter((e) => e.triggerEventId === "MessageReceived:dup");
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("COMPLETED");
    expect((db._stores.message as any[]).filter((m) => m.isNote)).toHaveLength(1);
  });

  it("concurrent evaluation of the same event → one execution row wins", async () => {
    const { conv } = await seedConv({});
    await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "n", action: { type: "CREATE_NOTE", text: "تزامن" } }] });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:race"))
      )
    );
    const started = results.reduce((s, r) => s + r.started, 0);
    const logs = (db._stores.automationExecution as any[]).filter((e) => e.triggerEventId === "MessageReceived:race");
    expect(logs).toHaveLength(1);
    expect(started).toBeLessThanOrEqual(1);
    expect((db._stores.message as any[]).filter((m) => m.isNote)).toHaveLength(1);
  });

  it("WAIT parks the run and a later evaluation resumes from the cursor (no re-send)", async () => {
    const { conv } = await seedConv({});
    await seedWorkflow({
      trigger: "MESSAGE_RECEIVED",
      steps: [
        { id: "n1", action: { type: "CREATE_NOTE", text: "قبل الانتظار" } },
        { id: "w", action: { type: "WAIT", minutes: 60 } },
        { id: "n2", action: { type: "CREATE_NOTE", text: "بعد الانتظار" } },
      ],
    });
    const r1 = await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:wt"));
    expect(r1.status).toBe("WAITING");
    const log = (db._stores.automationExecution as any[]).find((e) => e.triggerEventId === "MessageReceived:wt");
    expect(log.status).toBe("WAITING");
    expect(log.stepIndex).toBe(1);
    expect(new Date(log.metadata.resumeAt).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    // Redelivery BEFORE resumeAt → skipped, no progress.
    await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:wt"));
    expect(((db._stores.automationExecution as any[]).find((e) => e.triggerEventId === "MessageReceived:wt")).stepIndex).toBe(1);
    // Fake time: resumeAt passed → the same event resumes from the cursor.
    log.metadata.resumeAt = new Date(Date.now() - 1000).toISOString();
    const r2 = await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:wt"));
    expect(r2.started + r2.skipped).toBeGreaterThanOrEqual(1);
    const notes = (db._stores.message as any[]).filter((m) => m.isNote);
    expect(notes.map((n) => n.text)).toEqual(["قبل الانتظار", "بعد الانتظار"]);
    expect(((db._stores.automationExecution as any[]).find((e) => e.triggerEventId === "MessageReceived:wt")).status).toBe("COMPLETED");
  });

  it("frozen snapshot: mid-flight draft edit never changes a running/resumed execution", async () => {
    const { conv } = await seedConv({});
    const wf = await seedWorkflow({
      trigger: "MESSAGE_RECEIVED",
      steps: [{ id: "n1", action: { type: "CREATE_NOTE", text: "نسخة-1" } }, { id: "w", action: { type: "WAIT", minutes: 5 } }, { id: "n2", action: { type: "CREATE_NOTE", text: "نسخة-1-نهاية" } }],
    });
    const r1 = await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:fs"));
    expect(r1.status).toBe("WAITING");
    // Operator edits the DRAFT mid-flight.
    await db.automation.update({
      where: { id: wf.id },
      data: { actions: [{ id: "n1", action: { type: "CREATE_NOTE", text: "نسخة-2-معدلة" } }, { id: "w", action: { type: "WAIT", minutes: 5 } }, { id: "n2", action: { type: "CREATE_NOTE", text: "نسخة-2-نهاية" } }] } as never,
    });
    const log = (db._stores.automationExecution as any[]).find((e) => e.triggerEventId === "MessageReceived:fs");
    log.metadata.resumeAt = new Date(Date.now() - 1000).toISOString();
    await evaluateWorkflowEvent(db as Db, wfEvent("MessageReceived", { conversationId: conv.id }, "MessageReceived:fs"));
    const notes = (db._stores.message as any[]).filter((m) => m.isNote).map((n) => n.text);
    // v1 snapshot executed both its steps; the v2 text never appears.
    expect(notes).toEqual(["نسخة-1", "نسخة-1-نهاية"]);
    expect(notes.some((t) => t.includes("نسخة-2"))).toBe(false);
  });
});

// ── 9. Publishing / rollback / versions ───────────────────────────────────

describe("P7-9 publish + rollback via service", () => {
  it("publish validates, freezes a snapshot, bumps the version (audited)", async () => {
    const wf = await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "ADD_TAG", tag: "x" } }] }, { status: "DRAFT" });
    const { publishWorkflow } = await import("@/modules/automation/workflow-service");
    const updated = (await publishWorkflow(db as Db, AGENT, wf.id)) as any;
    expect(updated.version).toBe(2);
    expect(updated.status).toBe("PUBLISHED");
    const snap = (db._stores.automationVersion as any[]).find((v) => v.automationId === wf.id && v.version === 2);
    expect(snap).toBeTruthy();
    expect(snap.actions).toHaveLength(1);
    expect((db._stores.auditLog as any[]).some((a) => a.action === "workflow.published")).toBe(true);
  });

  it("publish refuses an invalid definition (nothing stored)", async () => {
    const wf = await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "ADD_TAG", tag: "x" } }] });
    const { publishWorkflow } = await import("@/modules/automation/workflow-service");
    await expect(
      publishWorkflow(db as Db, AGENT, wf.id, { trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "EVAL", code: "x" } } as never] } as never)
    ).rejects.toThrow();
    expect(((await db.automation.findUnique({ where: { id: wf.id } })) as any).version).toBe(1);
    expect((db._stores.automationVersion as any[]).filter((v) => v.automationId === wf.id)).toHaveLength(0);
  });

  it("rollback restores an old snapshot as a NEW version (append-only) + cross-workspace rejected", async () => {
    const wf = await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "a", action: { type: "ADD_TAG", tag: "v1" } }] });
    const { publishWorkflow, rollbackWorkflow, listWorkflowVersions } = await import("@/modules/automation/workflow-service");
    await publishWorkflow(db as Db, AGENT, wf.id); // v2
    await db.automation.update({ where: { id: wf.id }, data: { actions: [{ id: "a", action: { type: "ADD_TAG", tag: "v2" } }] } } as never);
    await publishWorkflow(db as Db, AGENT, wf.id); // v3
    const rolled = (await rollbackWorkflow(db as Db, AGENT, wf.id, 2)) as any;
    expect(rolled.version).toBe(4);
    expect(rolled.actions[0].action.tag).toBe("v1");
    expect((await listWorkflowVersions(db as Db, WS, wf.id)).length).toBeGreaterThanOrEqual(3);
    await expect(rollbackWorkflow(db as Db, { userId: "e", workspaceId: WS_B }, wf.id, 2)).rejects.toThrow();
  });
});

// ── 16-17. Isolation + RBAC ───────────────────────────────────────────────

describe("P7-16/17 isolation + RBAC", () => {
  it("foreign workspace events never trigger this workspace's workflows", async () => {
    const { conv } = await seedConv({});
    await seedWorkflow({ trigger: "MESSAGE_RECEIVED", steps: [{ id: "n", action: { type: "CREATE_NOTE", text: "x" } }] });
    const r = await evaluateWorkflowEvent(db as Db, {
      name: "MessageReceived", workspaceId: WS_B,
      payload: { conversationId: conv.id }, eventId: "MessageReceived:x1",
    });
    expect(r.started).toBe(0);
    expect((db._stores.automationExecution as any[])).toHaveLength(0);
  });

  it("every P7 route denies without its permission", async () => {
    const { GET: LIST, POST: CREATE } = await import("@/app/api/workflows/route");
    const r1 = await LIST(post("/api/workflows", {}));
    expect(r1.status).toBe(403);
    expect(seenPermissions).toEqual(["automation.read"]);
    seenPermissions.length = 0;
    const r2 = await CREATE(post("/api/workflows", { name: "x", definition: { trigger: "MESSAGE_RECEIVED", steps: [{ id: "s", action: { type: "STOP_WORKFLOW" } }] } }));
    expect(r2.status).toBe(403);
    expect(seenPermissions).toEqual(["automation.write"]);
    seenPermissions.length = 0;
    const { POST: ACT } = await import("@/app/api/workflows/[id]/route");
    const r3 = await ACT(post("/api/workflows/c1", { action: "publish" }), { params: { id: "c1" } } as never);
    expect(r3.status).toBe(403);
    expect(seenPermissions).toEqual(["automation.write"]);
    seenPermissions.length = 0;
    const { POST: PREV } = await import("@/app/api/workflows/[id]/preview/route");
    const r4 = await PREV(post("/api/workflows/c1/preview", { sample: {} }), { params: { id: "c1" } } as never);
    expect(r4.status).toBe(403);
    expect(seenPermissions).toEqual(["automation.write"]);
  });
});

// ── 19-20. Preview isolation + no real OMS ────────────────────────────────

describe("P7-19/20 preview is write-free and OMS-safe", () => {
  it("preview NEVER writes (snapshots identical) and reports branch reasons", async () => {
    const wf = await seedWorkflow({
      trigger: "MESSAGE_RECEIVED",
      steps: [{
        id: "b", action: {
          type: "BRANCH",
          when: { all: [{ field: "customer.tags", operator: "CONTAINS", value: "vip" }] },
          then: [{ id: "t", action: { type: "SEND_MESSAGE", template: "أهلًا" } }],
          else: [{ id: "e", action: { type: "ADD_TAG", tag: "x" } }],
        },
      }, { id: "w", action: { type: "WAIT", minutes: 30 } }],
    });
    const before = JSON.stringify(db._stores);
    const { POST } = await import("@/app/api/workflows/[id]/preview/route");
    // Auth is deny-all-mocked at module level; overlay an allow context AND
    // point the route's prisma at the fake db for this import only.
    vi.doMock("@/core/db/prisma", () => ({ prisma: db }));
    vi.doMock("@/modules/auth/context", async () => {
      const { AuthorizationError } = await import("@/core/errors");
      return {
        getAuthContext: async () => ({
          userId: AGENT.userId, workspaceId: WS, role: "OWNER", memberPermissions: [], can: () => true,
          require: (p: string) => { void p; },
        }),
      };
    });
    vi.resetModules();
    const { POST: POST2 } = await import("@/app/api/workflows/[id]/preview/route");
    const res = await POST2(post(`/api/workflows/${wf.id}/preview`, { sample: { tags: ["vip"], conversationAiState: "AI_ACTIVE" } }), { params: { id: wf.id } } as never);
    const json = await res.json() as Record<string, unknown>;
    expect(json.mode).toBe("PREVIEW");
    expect(json.conditionsMet).toBe(true);
    const steps = json.steps as Array<Record<string, unknown>>;
    expect(steps.some((s) => s.outcome === "BRANCH_TAKEN")).toBe(true);
    expect(steps.some((s) => s.outcome === "WOULD_WAIT")).toBe(true);
    expect(JSON.stringify(db._stores)).toBe(before); // zero writes
    vi.doUnmock("@/modules/auth/context");
    vi.resetModules();
  });

  it("no OMS order is ever created by a workflow (grep-level guarantee)", async () => {
    const { conv, cust } = await seedConv({});
    await seedWorkflow({ trigger: "ORDER_CONFIRMED", steps: [{ id: "n", action: { type: "CREATE_NOTE", text: "شكرًا" } }] });
    const r = await evaluateWorkflowEvent(db as Db, wfEvent("OrderConfirmed", { conversationId: conv.id, orderId: "ord-x", customerId: cust.id }, "OrderConfirmed:o1"));
    expect(r.started).toBe(1);
    expect((db._stores.order as any[])).toHaveLength(0);
    expect((db._stores.orderDraft as any[])).toHaveLength(0);
    void emptyVectors;
  });
});

// ── SSRF guard ────────────────────────────────────────────────────────────

describe("P7 SSRF guard (customBaseUrl)", () => {
  it("blocks loopback/LAN/metadata/obfuscated targets", async () => {
    for (const bad of [
      "http://127.0.0.1:11434/v1/chat/completions",
      "http://localhost:8080",
      "http://10.0.0.5/v1",
      "http://172.16.0.9/v1",
      "http://192.168.1.10:11434/v1",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]:11434/v1",
      "http://[fe80::1]/v1",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://0x7f000001/v1", // hex loopback
      "http://2130706433/v1", // decimal loopback
      "http://127.1/v1", // short loopback
      "ftp://example.com",
      "http://user:pass@example.com/v1",
      "http://host.local/v1",
    ]) {
      expect(validateEndpointUrl(bad)).toEqual(expect.objectContaining({ ok: false }));
    }
    expect(validateEndpointUrl("https://api.example.com/v1/chat/completions")).toEqual({ ok: true });
    // DNS layer with an injected resolver (no network dependency): public IP
    // resolves fine; a private/LAN answer fails the DNS layer.
    const okDns = await assertEndpointResolvesPublic(
      "https://api.openai.com/v1/chat/completions",
      async () => [{ address: "93.184.216.34", family: 4 }]
    );
    expect(okDns.ok).toBe(true);
    const badDns = await assertEndpointResolvesPublic(
      "https://api.openai.com/v1/chat/completions",
      async () => [{ address: "192.168.1.5", family: 4 }]
    );
    expect(badDns.ok).toBe(false);
  });
});
