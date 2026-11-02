/**
 * P24 — transactional outbox for independent orders.
 * Jobs are persisted with the orders; Telegram is sent by the worker only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { assignPageCatalog } from "./helpers/catalog";
import { createProduct } from "@/modules/products/service";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createOrderFromDraft } from "@/modules/orders/order-service";
import { runJobs } from "@/modules/jobs/handlers";
import { TelegramClient, setTelegramClientFactory } from "@/modules/channels/telegram/client";
import { encryptSecret } from "@/core/crypto";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;
const WS = "ws-outbox";
const AGENT = { userId: "agent-outbox", workspaceId: WS };

let db: FakeDb;
let calls: string[] = [];

async function seed() {
  db = createFakeDb() as FakeDb;
  await db.workspace.create({ data: { id: WS, name: "WS", slug: "outbox", timezone: "Asia/Amman" } } as never);
  const ids: string[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const p = await createProduct(db as unknown as Db, AGENT, {
      name: `منتج ${i}`,
      sku: `OUT-${i}`,
      price: 10 * i,
      currency: "USD",
    });
    ids.push(p.id);
  }
  const customer = (await db.customer.create({
    data: { workspaceId: WS, name: "سامر", phone: "0791234567", address: "عمان", province: "عمان" },
  } as never)) as { id: string };
  const channel = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "P", externalId: "page-outbox" },
  } as never)) as { id: string };
  await assignPageCatalog(db as unknown as Db, WS, channel.id, ids);
  await db.conversation.create({
    data: { workspaceId: WS, customerId: customer.id, channelId: channel.id, channelConversationId: "conv-outbox" },
  } as never);
  await db.telegramOrderSettings.create({
    data: {
      workspaceId: WS,
      enabled: true,
      botTokenEnc: encryptSecret("123:TOKEN"),
      chatId: "-100",
      topicId: "7",
    },
  } as never);
  return { customer, ids };
}

function jobs() {
  return (db._stores.backgroundJob as any[]).filter((j) => j.type === "notify_order_telegram");
}

beforeEach(() => {
  calls = [];
});
afterEach(() => setTelegramClientFactory(null));

describe("P24 transactional outbox", () => {
  it("3 orders → 3 persisted jobs → 3 messages; duplicate confirm creates nothing", async () => {
    const { customer } = await seed();
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async (url: string) => {
            calls.push(String(url));
            return Response.json({ ok: true, result: { message_id: calls.length } });
          }) as typeof fetch,
        })
    );
    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: {
        items: [
          { productName: "منتج 1", quantity: 1 },
          { productName: "منتج 2", quantity: 1 },
          { productName: "منتج 3", quantity: 1 },
        ],
      },
      source: "TEST",
    });
    const result = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id });
    expect(result.orders).toHaveLength(3);
    expect(jobs()).toHaveLength(3);
    expect(calls).toHaveLength(0); // no network inside the transaction

    const run = await runJobs(db as never);
    expect(run.failed).toBe(0);
    expect(calls).toHaveLength(3);
    expect(jobs().every((j) => j.status === "DONE")).toBe(true);

    // Re-running the worker never duplicates.
    await runJobs(db as never);
    expect(calls).toHaveLength(3);

    // Idempotent confirmation.
    const again = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id });
    expect(again.created).toBe(false);
    expect(jobs()).toHaveLength(3);
  });

  it("Telegram failure keeps the order; retry sends only the failed one", async () => {
    const { customer } = await seed();
    let n = 0;
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async () => {
            n += 1;
            calls.push(String(n));
            if (n === 1) return Response.json({ ok: false, error_code: 500, description: "boom" });
            return Response.json({ ok: true, result: { message_id: n } });
          }) as typeof fetch,
        })
    );
    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: {
        items: [
          { productName: "منتج 1", quantity: 1 },
          { productName: "منتج 2", quantity: 1 },
          { productName: "منتج 3", quantity: 1 },
        ],
      },
      source: "TEST",
    });
    const result = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id });
    const firstRun = await runJobs(db as never);
    expect(firstRun.failed).toBe(1);
    expect(db._stores.order as any[]).toHaveLength(3); // orders survive
    const pending = jobs().filter((j) => j.status === "PENDING");
    expect(pending).toHaveLength(1);
    for (const job of pending) job.runAfter = new Date(0);

    const secondRun = await runJobs(db as never);
    expect(secondRun.failed).toBe(0);
    expect(jobs().every((j) => j.status === "DONE")).toBe(true);
    expect(result.orders).toHaveLength(3);
  });

  it("Timeout/network غير مؤكد: الطلب يبقى، ويُسجّل إشعار ملتبس", async () => {
    const { customer } = await seed();
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async () => {
            throw new Error("network reset");
          }) as typeof fetch,
        })
    );
    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: { items: [{ productName: "منتج 1", quantity: 1 }] },
      source: "TEST",
    });
    const result = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id });
    const run = await runJobs(db as never);
    expect(run.failed).toBe(1);
    expect((db._stores.order as any[]).find((o) => o.id === result.orderId)).toBeTruthy();
    const ambiguous = (db._stores.auditLog as any[]).filter((a) => a.action === "order.telegram_ambiguous");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].metadata.reason).toBe("TIMEOUT_OR_NETWORK");
    expect(jobs()[0]!.status).toBe("PENDING");
  });
});
