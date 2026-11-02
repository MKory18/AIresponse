import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { calculateIndependentOrdersPricing } from "@/modules/orders/pricing";

type Db = Prisma.TransactionClient;
const WS = "ws-shipping";
let db: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  db = createFakeDb();
});

describe("P24 — delivery allocation across independent orders", () => {
  it("25 + 15 with a 5 fee → 3.13 / 1.87 (sum exactly 5)", async () => {
    await db.deliveryRule.create({ data: { workspaceId: WS, province: "عمان", fee: 5, isAvailable: true } } as never);
    const r = await calculateIndependentOrdersPricing(db as unknown as Db, {
      workspaceId: WS,
      province: "عمان",
      items: [
        { price: 25, quantity: 1, currency: "USD" },
        { price: 15, quantity: 1, currency: "USD" },
      ],
    });
    expect(r.lines.map((l) => l.deliveryFee)).toEqual([3.13, 1.87]);
    expect(r.lines.reduce((s, l) => s + l.deliveryFee, 0)).toBeCloseTo(5, 2);
    expect(r.lines.map((l) => l.total)).toEqual([28.13, 16.87]);
  });

  it("free delivery → zero share, no duplicated fee", async () => {
    await db.deliveryRule.create({ data: { workspaceId: WS, province: "عمان", fee: 0, isAvailable: true } } as never);
    const r = await calculateIndependentOrdersPricing(db as unknown as Db, {
      workspaceId: WS,
      province: "عمان",
      items: [
        { price: 25, quantity: 2, currency: "USD" },
        { price: 15, quantity: 1, currency: "USD" },
      ],
    });
    expect(r.lines.map((l) => l.deliveryFee)).toEqual([0, 0]);
    expect(r.lines.map((l) => l.total)).toEqual([50, 15]);
  });

  it("three items split with no lost cent", async () => {
    await db.deliveryRule.create({ data: { workspaceId: WS, province: "عمان", fee: 10, isAvailable: true } } as never);
    const r = await calculateIndependentOrdersPricing(db as unknown as Db, {
      workspaceId: WS,
      province: "عمان",
      items: [
        { price: 10, quantity: 1, currency: "USD" },
        { price: 10, quantity: 1, currency: "USD" },
        { price: 10, quantity: 1, currency: "USD" },
      ],
    });
    expect(r.lines.reduce((s, l) => s + Math.round(l.deliveryFee * 100), 0)).toBe(1000);
  });
});
