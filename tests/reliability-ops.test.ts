/**
 * المرحلة ٣ (تشغيلي) — قبول: صحة العامل · تقارير حسب العملة · خصوصية تيليجرام.
 */
import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { evaluateWorkerHealth, DEFAULT_WORKER_STALE_MS } from "@/modules/jobs/worker-health";
import { orderNotificationText, telegramOrderPiiEnabled } from "@/modules/orders/notify";
import { getOrderAnalytics } from "@/modules/analytics/service";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;
const WS = "ws-ops";

describe("Phase 3 — صحة العامل", () => {
  const now = Date.UTC(2026, 9, 30, 12, 0, 0);
  it("نبضة حديثة = سليم", () => {
    const h = evaluateWorkerHealth(new Date(now - 5_000), now);
    expect(h.status).toBe("APP_HEALTHY");
    expect(h.ageMs).toBe(5_000);
  });
  it("نبضة قديمة = العامل متوقف", () => {
    const h = evaluateWorkerHealth(new Date(now - DEFAULT_WORKER_STALE_MS - 1), now);
    expect(h.status).toBe("WORKER_STALE");
  });
  it("بلا نبضة = غير معروف (ما منأكّد ولا مننفي)", () => {
    const h = evaluateWorkerHealth(null, now);
    expect(h.status).toBe("WORKER_UNKNOWN");
    expect(h.ageMs).toBeNull();
  });
});

describe("Phase 3 — خصوصية إشعار تيليجرام", () => {
  const base = {
    orderNumber: "SY-2026-0148",
    productName: "ماء الكمأة",
    quantity: 3,
    total: 450000,
    currency: "SYP",
    status: "CONFIRMED",
  };
  it("لا يرسل اسم/رقم الزبون افتراضيًا", () => {
    const text = orderNotificationText({
      ...base,
      customerName: "أحمد",
      customerPhone: "0930000000",
      includePii: false,
    });
    expect(text).toContain("SY-2026-0148");
    expect(text).not.toContain("أحمد");
    expect(text).not.toContain("0930000000");
  });
  it("يرسلها فقط عند التفعيل الصريح", () => {
    const text = orderNotificationText({
      ...base,
      customerName: "أحمد",
      customerPhone: "0930000000",
      includePii: true,
    });
    expect(text).toContain("أحمد");
  });
  it("المفتاح الافتراضي مطفأ", () => {
    expect(telegramOrderPiiEnabled({})).toBe(false);
    expect(telegramOrderPiiEnabled({ TELEGRAM_ORDER_PII: "1" })).toBe(true);
    expect(telegramOrderPiiEnabled({ TELEGRAM_ORDER_PII: "true" })).toBe(true);
    expect(telegramOrderPiiEnabled({ TELEGRAM_ORDER_PII: "0" })).toBe(false);
  });
});

describe("Phase 3 — تقارير الطلبات حسب العملة", () => {
  it("لا يجمع عملتين مختلفتين برقم واحد", async () => {
    const db = createFakeDb() as FakeDb;
    await db.order.create({ data: { workspaceId: WS, orderNumber: "o-usd", status: "CONFIRMED", total: "20.00", currency: "USD" } } as never);
    await db.order.create({ data: { workspaceId: WS, orderNumber: "o-syp", status: "CONFIRMED", total: "150000.00", currency: "SYP" } } as never);

    const r = await getOrderAnalytics(db as unknown as Db, WS, { range: "last_7_days" });
    const usd = r.byCurrency.find((c) => c.currency === "USD");
    const syp = r.byCurrency.find((c) => c.currency === "SYP");
    expect(usd?.confirmedGmv).toBe(20);
    expect(syp?.confirmedGmv).toBe(150000);
    expect(r.byCurrency).toHaveLength(2);
  });
});
