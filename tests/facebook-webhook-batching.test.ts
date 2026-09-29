/**
 * REGRESSION — batched same-customer webhook POSTs must not lose messages.
 *
 * Proven production bug: normalizeFacebookWebhook() stamped every message in
 * a Meta POST with the same POST-scoped externalEventId, and
 * processIncomingMessage() dedupes on (conversationId, externalEventId) —
 * so the 2nd+ message from the same customer in one POST was silently
 * dropped (no row, no AI job, no error).
 *
 * Fix: externalEventId is scoped per message (`${rawEventId}:${mid}`).
 * Redeliveries (same mid) still produce identical keys → dedupe intact.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import {
  deriveEventId,
  normalizeFacebookWebhook,
} from "@/modules/channels/facebook/normalizer";
import { ingestMetaWebhook } from "@/modules/channels/facebook/webhook";
import { processIncomingMessage } from "@/modules/conversations/service";

const WS = "ws-batch";
const PAGE = "page-batch-1";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

const PSID_A = "psid-batch-a";
const PSID_B = "psid-batch-b";

function batchPayload(entries: Array<{ psid: string; mid: string; text: string }>) {
  return {
    object: "page",
    entry: [
      {
        id: PAGE,
        messaging: entries.map((e) => ({
          sender: { id: e.psid },
          recipient: { id: PAGE },
          timestamp: Date.now(),
          message: { mid: e.mid, text: e.text },
        })),
      },
    ],
  };
}

async function seedPage() {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "Batch Page", externalId: PAGE },
  } as never)) as any;
  const account = (await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: PAGE, pageName: "Batch Page",
      encryptedCredentials: "enc",
    },
  } as never)) as any;
  return { ch, account };
}

async function ingestNormalized(entries: Array<{ psid: string; mid: string; text: string }>) {
  const payload = batchPayload(entries);
  const res = await ingestMetaWebhook(db as Db, payload);
  expect(res.status).toBe("OK");
  const job = (db._stores.backgroundJob as any[]).find((j) => j.type === "process_webhook_event");
  expect(job).toBeTruthy();
  return (job.payload as { messages: Record<string, unknown>[] }).messages;
}

async function processNormalized(m: Record<string, unknown>, channelId: string) {
  return processIncomingMessage(db as Db, {
    workspaceId: WS,
    channelType: "FACEBOOK",
    channelId,
    externalUserId: String(m.externalCustomerId),
    externalConversationId: String(m.externalConversationId),
    externalMessageId: String(m.externalMessageId),
    externalEventId: String(m.externalEventId),
    provider: "facebook",
    type: "TEXT",
    text: (m.text as string) ?? null,
  });
}

function aiJobs() {
  return (db._stores.backgroundJob as any[]).filter((j) => j.type === "process_ai_message");
}

beforeEach(() => {
  db = createFakeDb();
});

describe("normalizer — per-message delivery identity", () => {
  it("same PSID batch yields distinct externalEventIds, each bound to its mid", () => {
    const payload = batchPayload([
      { psid: PSID_A, mid: "mid_1", text: "Hello" },
      { psid: PSID_A, mid: "mid_2", text: "How much is the product?" },
    ]);
    const raw = deriveEventId(payload);
    const out = normalizeFacebookWebhook(payload as never, "acct-1", PAGE, raw);
    expect(out).toHaveLength(2);
    expect(out[0].externalEventId).not.toBe(out[1].externalEventId);
    expect(out[0].externalEventId).toContain("mid_1");
    expect(out[1].externalEventId).toContain("mid_2");
    // POST-level trace preserved.
    expect(out[0].rawEventId).toBe(raw);
    expect(out[1].rawEventId).toBe(raw);
  });

  it("same payload redelivered yields byte-identical keys (dedupe intact)", () => {
    const payload = batchPayload([
      { psid: PSID_A, mid: "mid_1", text: "Hello" },
      { psid: PSID_A, mid: "mid_2", text: "How much is the product?" },
    ]);
    const raw = deriveEventId(payload);
    const first = normalizeFacebookWebhook(payload as never, "acct-1", PAGE, raw);
    const second = normalizeFacebookWebhook(
      JSON.parse(JSON.stringify(payload)) as never, "acct-1", PAGE, deriveEventId(payload)
    );
    expect(second.map((m) => m.externalEventId)).toEqual(first.map((m) => m.externalEventId));
  });

  it("different PSIDs in one POST stay separated by conversation", () => {
    const payload = batchPayload([
      { psid: PSID_A, mid: "mid_a1", text: "Hello" },
      { psid: PSID_B, mid: "mid_b1", text: "Hi" },
    ]);
    const out = normalizeFacebookWebhook(payload as never, "acct-1", PAGE, deriveEventId(payload));
    expect(out).toHaveLength(2);
    expect(out[0].externalConversationId).toBe(PSID_A);
    expect(out[1].externalConversationId).toBe(PSID_B);
    expect(out[0].externalEventId).not.toBe(out[1].externalEventId);
  });
});

describe("pipeline — batched same-customer POST loses nothing", () => {
  it("Hello + follow-up in one POST: both persisted, both enqueue AI, neither duplicate", async () => {
    const { ch } = await seedPage();
    const messages = await ingestNormalized([
      { psid: PSID_A, mid: "mid_1", text: "Hello" },
      { psid: PSID_A, mid: "mid_2", text: "How much is the product?" },
    ]);
    expect(messages).toHaveLength(2);

    const r1 = await processNormalized(messages[0], ch.id);
    const r2 = await processNormalized(messages[1], ch.id);

    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(false);
    expect(r1.conversationId).toBe(r2.conversationId);
    expect(r1.messageId).not.toBe(r2.messageId);

    const rows = (db._stores.message as any[]).filter((m) => m.conversationId === r1.conversationId);
    expect(rows.map((m) => m.text).sort()).toEqual(["Hello", "How much is the product?"].sort());
    // Both can be processed independently: one AI job per inbound message.
    expect(aiJobs()).toHaveLength(2);
  });

  it("identical POST redelivered: WebhookEvent dedupes, no new rows, no new AI jobs", async () => {
    const { ch } = await seedPage();
    const entries = [
      { psid: PSID_A, mid: "mid_1", text: "Hello" },
      { psid: PSID_A, mid: "mid_2", text: "How much is the product?" },
    ];
    const first = await ingestNormalized(entries);
    await processNormalized(first[0], ch.id);
    await processNormalized(first[1], ch.id);
    const rowsBefore = (db._stores.message as any[]).length;
    const jobsBefore = aiJobs().length;

    // Exact same POST redelivered by Meta.
    const dup = await ingestMetaWebhook(db as Db, batchPayload(entries));
    expect(dup.status).toBe("DUPLICATE");
    expect((db._stores.message as any[]).length).toBe(rowsBefore);
    expect(aiJobs().length).toBe(jobsBefore);
  });

  it("same mid redelivered at message level dedupes without harming siblings", async () => {
    const { ch } = await seedPage();
    const messages = await ingestNormalized([
      { psid: PSID_A, mid: "mid_1", text: "Hello" },
      { psid: PSID_A, mid: "mid_2", text: "How much is the product?" },
    ]);
    const r1 = await processNormalized(messages[0], ch.id);
    await processNormalized(messages[1], ch.id);

    // Redeliver only mid_1 (same per-message key).
    const again = await processNormalized(messages[0], ch.id);
    expect(again.duplicate).toBe(true);
    expect(again.messageId).toBe(r1.messageId);
    const rows = (db._stores.message as any[]).filter((m) => m.conversationId === r1.conversationId);
    expect(rows).toHaveLength(2);
  });

  it("two PSIDs in one POST: separate conversations, separate customers, both answered", async () => {
    const { ch } = await seedPage();
    const messages = await ingestNormalized([
      { psid: PSID_A, mid: "mid_a1", text: "Hello" },
      { psid: PSID_B, mid: "mid_b1", text: "Hi there" },
    ]);
    const ra = await processNormalized(messages[0], ch.id);
    const rb = await processNormalized(messages[1], ch.id);
    expect(ra.duplicate).toBe(false);
    expect(rb.duplicate).toBe(false);
    expect(ra.conversationId).not.toBe(rb.conversationId);
    expect(ra.customerId).not.toBe(rb.customerId);
    expect(aiJobs()).toHaveLength(2);
  });
});
