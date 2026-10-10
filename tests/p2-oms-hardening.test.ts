import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import { AppError } from "@/core/errors";
import {
  OmsClient,
  setOmsClientFactory,
  createOmsClient,
} from "@/modules/oms/client";
import { syncProductsFromOms, syncCustomersFromOms } from "@/modules/oms/sync";
import { handoffOrderToOms } from "@/modules/oms/handoff";
import { handleOmsStatusChanged } from "@/modules/oms/webhook";
import { createOrderFromDraft } from "@/modules/orders/order-service";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createProduct } from "@/modules/products/service";

const WS = "ws-p2";
const OTHER_WS = "ws-p2-other";
const AGENT = { userId: "agent-1", workspaceId: WS };
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let omsCalls: Array<{ method: string; path: string; body: unknown }>;

function installFakeOms(responseFactory: (method: string, path: string, body: unknown) => unknown) {
  setOmsClientFactory(
    (deps) =>
      new OmsClient({
        ...deps,
        fetchImpl: (async (url: string, init?: { method?: string; body?: string }) => {
          const u = new URL(String(url));
          const path = `${u.pathname}${u.search}`;
          const method = init?.method ?? "GET";
          let body: unknown = null;
          try {
            body = JSON.parse(String(init?.body ?? "null"));
          } catch {
            body = null;
          }
          omsCalls.push({ method, path, body });
          const payload = responseFactory(method, path, body);
          if (payload instanceof Response) return payload;
          return Response.json(payload);
        }) as typeof fetch,
      })
  );
}

function seedConnection() {
  (db as any).omsConnection = {
    findUnique: async () => ({
      id: "c1",
      baseUrl: "https://oms.example",
      tokenEncrypted: encryptSecret("tok"),
      isActive: true,
    }),
  };
}

beforeEach(() => {
  db = createFakeDb();
  omsCalls = [];
  setOmsClientFactory(null);
});

describe("P2 product sync — validation, isolation, deactivation", () => {
  const good = (sku: string) => ({
    sku, name: `صنف ${sku}`, price: 1000, currency: "SYP",
    wholesalePrice: 600, discountCap: 100,
    offers: [{ title: "عرض", quantity: 2, price: 1800, saving: 200 }],
    complementarySkus: ["X-1"],
  });

  it("syncs valid rows, skips corrupt rows, never writes them", async () => {
    seedConnection();
    installFakeOms((_, path) => {
      if (path === "/oms/products") {
        return { products: [good("OK-1"), { sku: "", price: -5 }, { sku: "BAD", price: NaN }] };
      }
      return {};
    });
    const res = await syncProductsFromOms(db as Db, AGENT);
    expect(res.synced).toBe(1);
    expect(res.failed).toBe(2);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(await db.product.findUnique({ where: { workspaceId_sku: { workspaceId: WS, sku: "OK-1" } } })).not.toBeNull();
    expect(await db.product.findUnique({ where: { workspaceId_sku: { workspaceId: WS, sku: "" } } })).toBeNull();
  });

  it("deactivates stale OMS products but never local-only ones or on empty feed", async () => {
    await db.product.create({ data: { workspaceId: WS, sku: "OLD-1", name: "قديم", price: 5, syncedFromOms: true, isActive: true } } as never);
    await db.product.create({ data: { workspaceId: WS, sku: "LOCAL-1", name: "محلي", price: 5, syncedFromOms: false, isActive: true } } as never);
    seedConnection();
    installFakeOms((_, path) => (path === "/oms/products" ? { products: [good("NEW-1")] } : {}));
    const res = await syncProductsFromOms(db as Db, AGENT);
    expect(res.deactivated).toBe(1);
    const old = await db.product.findUnique({ where: { workspaceId_sku: { workspaceId: WS, sku: "OLD-1" } } }) as any;
    const local = await db.product.findUnique({ where: { workspaceId_sku: { workspaceId: WS, sku: "LOCAL-1" } } }) as any;
    expect(old.isActive).toBe(false);
    expect(local.isActive).toBe(true);

    // Empty feed is inconclusive: no deactivation.
    installFakeOms((_, path) => (path === "/oms/products" ? { products: [] } : {}));
    const res2 = await syncProductsFromOms(db as Db, AGENT);
    expect(res2.synced).toBe(0);
    expect(res2.deactivated).toBe(0);
  });

  it("refuses oversized payloads before writing anything", async () => {
    seedConnection();
    installFakeOms((_, path) => {
      if (path === "/oms/products") {
        return { products: Array.from({ length: 5001 }, (_, i) => good(`S-${i}`)) };
      }
      return {};
    });
    await expect(syncProductsFromOms(db as Db, AGENT)).rejects.toMatchObject({ code: "OMS_SYNC_TOO_LARGE" });
    expect((db._stores.product as any[])).toHaveLength(0);
  });

  it("keeps local sales fields across syncs", async () => {
    await db.product.create({
      data: { workspaceId: WS, sku: "TW-500", name: "محلي", price: 1, objections: ["غلاء"], salesNotes: "ملاحظة" },
    } as never);
    seedConnection();
    installFakeOms((_, path) => (path === "/oms/products" ? { products: [good("TW-500")] } : {}));
    await syncProductsFromOms(db as Db, AGENT);
    const row = (await db.product.findUnique({ where: { workspaceId_sku: { workspaceId: WS, sku: "TW-500" } } })) as any;
    expect(row.objections).toEqual(["غلاء"]);
    expect(Number(row.price)).toBe(1000);
  });
});

describe("P2 OmsClient — timeouts and classified retries", () => {
  it("retries transient GETs and succeeds (3 calls), never retries 400", async () => {
    let calls = 0;
    const client = new OmsClient({
      baseUrl: "https://oms.example",
      token: "t",
      timeoutMs: 1000,
      fetchImpl: (async () => {
        calls += 1;
        if (calls < 3) return new Response(JSON.stringify({ e: 1 }), { status: 500 });
        return Response.json({ products: [] });
      }) as typeof fetch,
    });
    const res = await client.getProducts();
    expect(res.products).toEqual([]);
    expect(calls).toBe(3);

    let bad = 0;
    const client2 = new OmsClient({
      baseUrl: "https://oms.example",
      token: "t",
      fetchImpl: (async () => {
        bad += 1;
        return new Response("nope", { status: 400 });
      }) as typeof fetch,
    });
    await expect(client2.getProducts()).rejects.toMatchObject({ code: "OMS_ERROR" });
    expect(bad).toBe(1);
  });

  it("aborts hung requests (OMS_TIMEOUT) and exposes only read/create/note surface", async () => {
    const hanging = new OmsClient({
      baseUrl: "https://oms.example",
      token: "t",
      timeoutMs: 30,
      fetchImpl: ((() => new Promise(() => {})) as unknown) as typeof fetch,
    });
    await expect(hanging.getProducts()).rejects.toMatchObject({ code: "OMS_TIMEOUT" });
    // Token scope: reads + confirmed-order create + note. No update/delete.
    for (const m of ["updateOrder", "deleteOrder", "setPrice", "setStatus", "updateProduct"] as const) {
      expect((hanging as unknown as Record<string, unknown>)[m]).toBeUndefined();
    }
    for (const m of ["getProducts", "getCustomer", "getOrder", "createOrder", "postNote"] as const) {
      expect(typeof (hanging as unknown as Record<string, unknown>)[m]).toBe("function");
    }
  });
});

describe("P2 customers + blacklist", () => {
  it("blacklists on OMS true, lifts OMS-owned blocks, preserves manual blocks", async () => {
    const a = await db.customer.create({ data: { workspaceId: WS, phone: "0911111111" } } as never) as any;
    const b = await db.customer.create({ data: { workspaceId: WS, phone: "0922222222", isBlacklisted: true, blacklistSource: "OMS" } } as never) as any;
    const c = await db.customer.create({ data: { workspaceId: WS, phone: "0933333333", isBlacklisted: true, blacklistSource: "MANUAL" } } as never) as any;
    seedConnection();
    installFakeOms((_, path) => {
      if (path.startsWith("/oms/customer")) {
        const phone = new URL(`https://x${path}`).searchParams.get("phone");
        if (phone === "0911111111") return { phone, isBlacklisted: true };
        return { phone, isBlacklisted: false };
      }
      return {};
    });
    const res = await syncCustomersFromOms(db as Db, AGENT, ["0911111111", "0922222222", "0933333333", "0999999999"]);
    expect(res.updated).toBe(2);
    expect(res.skipped).toBe(2);
    expect(((await db.customer.findUnique({ where: { id: a.id } })) as any).isBlacklisted).toBe(true);
    expect(((await db.customer.findUnique({ where: { id: b.id } })) as any).isBlacklisted).toBe(false);
    // Manual block survives an OMS "false".
    expect(((await db.customer.findUnique({ where: { id: c.id } })) as any).isBlacklisted).toBe(true);
  });

  it("refuses order creation for blacklisted customers (single choke point)", async () => {
    const product = await createProduct(db as Db, AGENT, { name: "ماء", sku: "W-1", price: 1000, currency: "SYP" });
    const customer = (await db.customer.create({
      data: { workspaceId: WS, phone: "0955555555", isBlacklisted: true, blacklistSource: "OMS" },
    } as never)) as any;
    const conv = (await db.conversation.create({ data: { workspaceId: WS, customerId: customer.id, channelId: "ch", channelConversationId: "c" } } as never)) as any;
    const draftRes = await updateDraftFromExtraction(db as Db, {
      workspaceId: WS, conversationId: conv.id, customerId: customer.id,
      extraction: { productId: product.id, quantity: 1, phone: "0955555555", rawAddress: "دمشق", province: "دمشق" },
      source: "TEST",
    });
    await expect(createOrderFromDraft(db as Db, AGENT, { draftId: (draftRes as any).draft.id })).rejects.toMatchObject({
      code: "ORDER_CUSTOMER_BLACKLISTED",
    });
    expect((db._stores.order as any[])).toHaveLength(0);
  });
});

describe("P2 handoff — idempotency ×100, timeout-then-retry, blacklist", () => {
  async function confirmedOrder(phone = "0966666666") {
    const customer = (await db.customer.create({ data: { workspaceId: WS, phone } } as never)) as any;
    return db.order.create({
      data: {
        workspaceId: WS, orderNumber: `ORD-${phone}`, customerId: customer.id,
        status: "CONFIRMED", confirmationStatus: "CONFIRMED_BY_CUSTOMER",
        idempotencyKey: `draft:${phone}`, subtotal: 1000, total: 1000, currency: "SYP",
      },
    } as never) as unknown as { id: string };
  }

  it("100 sequential handoffs post exactly once", async () => {
    const order = await confirmedOrder();
    seedConnection();
    let posts = 0;
    installFakeOms((method, path) => {
      if (method === "POST" && path === "/oms/orders") {
        posts += 1;
        return { id: "OMS-100", status: "PROCESSING" };
      }
      return {};
    });
    for (let i = 0; i < 100; i += 1) {
      const r = await handoffOrderToOms(db as Db, AGENT, order.id);
      expect(r.omsOrderId).toBe("OMS-100");
    }
    expect(posts).toBe(1);
  });

  it("20 concurrent handoffs reuse the same idempotencyKey (OMS-side dedupe contract)", async () => {
    const order = await confirmedOrder("0966666620");
    seedConnection();
    installFakeOms(() => ({ id: "OMS-20", status: "PROCESSING" }));
    const results = await Promise.all(Array.from({ length: 20 }, () => handoffOrderToOms(db as Db, AGENT, order.id)));
    const keys = omsCalls.filter((c) => c.path === "/oms/orders").map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("draft:0966666620");
    expect(results.every((r) => r.omsOrderId === "OMS-20")).toBe(true);
  });

  it("timeout after OMS accept retries once with the same key (no duplicate order)", async () => {
    const order = await confirmedOrder("0966666630");
    seedConnection();
    let attempt = 0;
    setOmsClientFactory(
      (deps) =>
        new OmsClient({
          ...deps,
          timeoutMs: 40,
          fetchImpl: ((url: string, init?: { signal?: AbortSignal }) =>
            new Promise((resolve, reject) => {
              attempt += 1;
              if (attempt === 1) {
                // Hang until the client aborts: ambiguous outcome.
                init?.signal?.addEventListener("abort", () => {
                  const e = new Error("aborted");
                  e.name = "AbortError";
                  reject(e);
                });
                return;
              }
              omsCalls.push({ method: "POST", path: "/oms/orders", body: JSON.parse(String((init as any)?.body ?? "{}")) });
              resolve(Response.json({ id: "OMS-T", status: "PROCESSING" }));
            })) as typeof fetch,
        })
    );
    const r = await handoffOrderToOms(db as Db, AGENT, order.id);
    expect(r).toMatchObject({ omsOrderId: "OMS-T", handedOff: true });
    expect(attempt).toBe(2);
    expect(omsCalls).toHaveLength(1);
    const stored = (await db.order.findUnique({ where: { id: order.id } })) as any;
    expect(stored.omsOrderId).toBe("OMS-T");
    expect(stored.omsStatus).toBe("PROCESSING");
    expect(stored.handedOffAt).not.toBeNull();
  });

  it("refuses handoff for blacklisted customers without calling the OMS", async () => {
    const customer = (await db.customer.create({
      data: { workspaceId: WS, phone: "0977777777", isBlacklisted: true, blacklistSource: "OMS" },
    } as never)) as any;
    const order = (await db.order.create({
      data: {
        workspaceId: WS, orderNumber: "ORD-BL", customerId: customer.id,
        status: "CONFIRMED", confirmationStatus: "CONFIRMED_BY_AGENT",
        idempotencyKey: "draft:bl", subtotal: 1, total: 1, currency: "SYP",
      },
    } as never)) as unknown as { id: string };
    seedConnection();
    installFakeOms(() => ({ id: "OMS-X", status: "X" }));
    await expect(handoffOrderToOms(db as Db, AGENT, order.id)).rejects.toMatchObject({
      code: "ORDER_CUSTOMER_BLACKLISTED",
    });
    expect(omsCalls).toHaveLength(0);
  });

  it("handoff in another workspace is invisible (isolation)", async () => {
    const customer = (await db.customer.create({ data: { workspaceId: OTHER_WS, phone: "0988888888" } } as never)) as any;
    const order = (await db.order.create({
      data: {
        workspaceId: OTHER_WS, orderNumber: "ORD-O", customerId: customer.id,
        status: "CONFIRMED", confirmationStatus: "CONFIRMED_BY_CUSTOMER",
        idempotencyKey: "draft:o", subtotal: 1, total: 1, currency: "SYP",
      },
    } as never)) as unknown as { id: string };
    seedConnection();
    installFakeOms(() => ({ id: "OMS-O", status: "X" }));
    await expect(handoffOrderToOms(db as Db, AGENT, order.id)).rejects.toThrow();
    expect(omsCalls).toHaveLength(0);
  });
});

describe("P2 webhook handler — dedupe, staleness, transitions", () => {
  async function handedOffOrder(omsOrderId: string, status = "CONFIRMED") {
    const customer = (await db.customer.create({ data: { workspaceId: WS, phone: `p-${omsOrderId}` } } as never)) as any;
    return db.order.create({
      data: {
        workspaceId: WS, orderNumber: `ORD-${omsOrderId}`, customerId: customer.id,
        status, omsOrderId, omsStatus: "PROCESSING",
      },
    } as never) as unknown as { id: string };
  }

  it("unknown orders fail closed with zero side effects", async () => {
    await expect(
      handleOmsStatusChanged(db as Db, { event: "order-status-changed", omsOrderId: "OMS-NOPE", status: "SHIPPED" })
    ).rejects.toThrow();
    expect((db._stores.webhookEvent as any[])).toHaveLength(0);
  });

  it("eventId replays are deduplicated (single apply)", async () => {
    const order = await handedOffOrder("OMS-R", "PROCESSING");
    const payload = { event: "order-status-changed", omsOrderId: "OMS-R", status: "SHIPPED", eventId: "evt-1" } as const;
    const r1 = await handleOmsStatusChanged(db as Db, { ...payload });
    expect(r1.duplicate).toBe(false);
    expect(r1.appliedLocalStatus).toBe("OUT_FOR_DELIVERY");
    const r2 = await handleOmsStatusChanged(db as Db, { ...payload });
    expect(r2.duplicate).toBe(true);
    expect(r2.appliedLocalStatus).toBe(null);
  });

  it("stale out-of-order events never regress state", async () => {
    const order = await handedOffOrder("OMS-S", "OUT_FOR_DELIVERY");
    const fresh = await handleOmsStatusChanged(db as Db, {
      event: "order-status-changed", omsOrderId: "OMS-S", status: "DELIVERED",
      eventId: "e-fresh", occurredAt: "2026-10-10T12:00:00.000Z",
    });
    expect(fresh.appliedLocalStatus).toBe("DELIVERED");
    const stale = await handleOmsStatusChanged(db as Db, {
      event: "order-status-changed", omsOrderId: "OMS-S", status: "SHIPPED",
      eventId: "e-stale", occurredAt: "2026-10-10T11:00:00.000Z",
    });
    expect(stale.stale).toBe(true);
    const row = (await db.order.findUnique({ where: { id: order.id } })) as any;
    expect(row.status).toBe("DELIVERED");
    expect(row.omsStatus).toBe("DELIVERED");
  });

  it("unknown statuses mirror without local transitions; illegal jumps keep OMS mirror only", async () => {
    const order = await handedOffOrder("OMS-U");
    const r = await handleOmsStatusChanged(db as Db, {
      event: "order-status-changed", omsOrderId: "OMS-U", status: "MYSTERIOUS",
    });
    expect(r.appliedLocalStatus).toBe(null);
    const row = (await db.order.findUnique({ where: { id: order.id } })) as any;
    expect(row.omsStatus).toBe("MYSTERIOUS");
    expect(row.status).toBe("CONFIRMED");
  });
});
