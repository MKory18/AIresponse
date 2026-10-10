import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import {
  OmsClient,
  setOmsClientFactory,
  createOmsClient,
  verifyOmsWebhookSignature,
} from "@/modules/oms/client";
import { syncProductsFromOms } from "@/modules/oms/sync";
import { handoffOrderToOms } from "@/modules/oms/handoff";
import { handleOmsStatusChanged } from "@/modules/oms/webhook";
import { maskCustomerPII, unmaskPII, containsPhoneLike } from "@/modules/ai/masking";
import { AppError } from "@/core/errors";

const WS = "ws-oms";
const AGENT = { userId: "agent-1", workspaceId: WS };
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let omsCalls: Array<{ path: string; body: unknown }>;

function installFakeOms(responseFactory: (path: string, body: unknown) => unknown) {
  setOmsClientFactory(
    (deps) =>
      new OmsClient({
        ...deps,
        fetchImpl: (async (url: string, init?: { method?: string; body?: string }) => {
          const u = new URL(String(url));
          const path = `${u.pathname}${u.search}`;
          let body: unknown = null;
          try {
            body = JSON.parse(String(init?.body ?? "null"));
          } catch {
            body = null;
          }
          omsCalls.push({ path, body });
          const payload = responseFactory(path, body);
          return Response.json(payload);
        }) as typeof fetch,
      })
  );
}

beforeEach(() => {
  db = createFakeDb();
  omsCalls = [];
  setOmsClientFactory(null);
});

describe("OMS integration (سيستم 7 — B2)", () => {
  it("syncs products from OMS keeping local sales fields", async () => {
    await db.product.create({
      data: { workspaceId: WS, sku: "TW-500", name: "محلي", price: 1, objections: ["غلاء"], salesNotes: "ملاحظة" },
    } as never);
    (db as any).omsConnection = {
      findUnique: async () => ({
        id: "c1",
        baseUrl: "https://oms.example",
        tokenEncrypted: encryptSecret("tok"),
        isActive: true,
      }),
    };
    installFakeOms((path) => {
      if (path === "/oms/products") {
        return {
          products: [
            {
              sku: "TW-500",
              name: "من الـ OMS",
              price: 150000,
              currency: "SYP",
              wholesalePrice: 90000,
              discountCap: 20000,
              offers: [{ title: "قطعتين", quantity: 2, price: 250000, saving: 50000 }],
              complementarySkus: ["CRM-250"],
            },
          ],
        };
      }
      return {};
    });

    const count = await syncProductsFromOms(db as Db, AGENT);
    expect(count.synced).toBe(1);
    expect(count.failed).toBe(0);
    const row = await db.product.findUnique({
      where: { workspaceId_sku: { workspaceId: WS, sku: "TW-500" } },
    });
    expect(row!.syncedFromOms).toBe(true);
    expect(Number(row!.price)).toBe(150000);
    // Local sales fields survive the sync:
    expect(row!.objections).toEqual(["غلاء"]);
    expect(row!.salesNotes).toBe("ملاحظة");
  });

  it("hands off a confirmed order once — retries never duplicate in the OMS", async () => {
    const customer = await db.customer.create({
      data: { workspaceId: WS, phone: "0930000000", name: "محمد" },
    } as never);
    const order = await db.order.create({
      data: {
        workspaceId: WS,
        orderNumber: "ORD-1",
        customerId: customer.id,
        status: "CONFIRMED",
        confirmationStatus: "CONFIRMED_BY_CUSTOMER",
        idempotencyKey: "draft:d1",
        subtotal: 150000,
        total: 160000,
        currency: "SYP",
      },
    } as never);
    (db as any).omsConnection = {
      findUnique: async () => ({ id: "c1", baseUrl: "https://oms.example", tokenEncrypted: encryptSecret("tok"), isActive: true }),
    };
    let createCount = 0;
    installFakeOms((path, body) => {
      if (path === "/oms/orders") {
        createCount += 1;
        expect((body as { idempotencyKey: string }).idempotencyKey).toBe("draft:d1");
        return { id: "OMS-77", status: "PROCESSING" };
      }
      return {};
    });

    const first = await handoffOrderToOms(db as Db, AGENT, order.id);
    expect(first.handedOff).toBe(true);
    expect(first.omsOrderId).toBe("OMS-77");

    const second = await handoffOrderToOms(db as Db, AGENT, order.id);
    expect(second.handedOff).toBe(false);
    expect(createCount).toBe(1);
  });

  it("refuses to hand off an unconfirmed order", async () => {
    const customer = await db.customer.create({
      data: { workspaceId: WS, phone: "0930000000" },
    } as never);
    const order = await db.order.create({
      data: { workspaceId: WS, orderNumber: "ORD-2", customerId: customer.id },
    } as never);
    (db as any).omsConnection = {
      findUnique: async () => ({ id: "c1", baseUrl: "https://oms.example", tokenEncrypted: encryptSecret("tok"), isActive: true }),
    };
    installFakeOms(() => ({}));
    await expect(handoffOrderToOms(db as Db, AGENT, order.id)).rejects.toThrow(AppError);
    expect(omsCalls.length).toBe(0);
  });

  it("mirrors OMS status changes and respects the local state machine", async () => {
    const customer = await db.customer.create({
      data: { workspaceId: WS, phone: "0930000000" },
    } as never);
    const order = await db.order.create({
      data: {
        workspaceId: WS,
        orderNumber: "ORD-3",
        customerId: customer.id,
        status: "CONFIRMED",
        omsOrderId: "OMS-99",
        omsStatus: "PROCESSING",
      },
    } as never);

    // OMS reports step-by-step; the local machine mirrors only valid paths.
    await handleOmsStatusChanged(db as Db, {
      event: "order-status-changed",
      workspaceId: WS,
      omsOrderId: "OMS-99",
      status: "PROCESSING",
    });
    const r1 = await handleOmsStatusChanged(db as Db, {
      event: "order-status-changed",
      workspaceId: WS,
      omsOrderId: "OMS-99",
      status: "SHIPPED",
    });
    expect(r1.appliedLocalStatus).toBe("OUT_FOR_DELIVERY");
    const updated = await db.order.findUnique({ where: { id: order.id } });
    expect(updated!.omsStatus).toBe("SHIPPED");
    expect(updated!.status).toBe("OUT_FOR_DELIVERY");

    // Invalid local jump (OUT_FOR_DELIVERY → PROCESSING) stores OMS status only.
    const r2 = await handleOmsStatusChanged(db as Db, {
      event: "order-status-changed",
      workspaceId: WS,
      omsOrderId: "OMS-99",
      status: "PROCESSING",
    });
    expect(r2.appliedLocalStatus).toBe(null);
  });
});

describe("OMS webhook signature", () => {
  it("accepts a correct HMAC and rejects a wrong one", () => {
    const body = JSON.stringify({ event: "order-status-changed", omsOrderId: "x" });
    const crypto = require("node:crypto");
    const sig = crypto.createHmac("sha256", "tok").update(Buffer.from(body, "utf8")).digest("hex");
    expect(verifyOmsWebhookSignature(body, `sha256=${sig}`, "tok")).toBe(true);
    expect(verifyOmsWebhookSignature(body, `sha256=${"0".repeat(64)}`, "tok")).toBe(false);
    expect(verifyOmsWebhookSignature(body, null, "tok")).toBe(false);
  });
});

describe("Customer PII masking (سيستم 7 — قبل الموديل الخارجي)", () => {
  it("masks phone, name and address, and unmasks the reply", () => {
    const { masked, map } = maskCustomerPII({
      text: "محمد من دمشق، رقمه 0930000000 والعنوان: شارع الحمراء 12",
      customerName: "محمد",
      customerPhone: "0930000000",
      customerAddress: "شارع الحمراء 12",
    });
    expect(masked).not.toContain("0930000000");
    expect(masked).not.toContain("شارع الحمراء 12");
    expect(containsPhoneLike(masked)).toBe(false);
    const restored = unmaskPII(masked, map);
    expect(restored).toContain("0930000000");
    expect(restored).toContain("شارع الحمراء 12");
  });

  it("catches phone-like numbers even without a known customer", () => {
    const { masked } = maskCustomerPII({ text: "اتصلوا على 00963930000000 اليوم" });
    expect(masked).not.toContain("00963930000000");
  });

  it("OmsClient factory returns the injected client", () => {
    setOmsClientFactory(() => ({ getProducts: async () => ({ products: [] }) } as unknown as OmsClient));
    const client = createOmsClient({ baseUrl: "https://x", token: "t" });
    expect(typeof client.getProducts).toBe("function");
  });
});
