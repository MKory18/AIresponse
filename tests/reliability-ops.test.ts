/**
 * المرحلة ٣ (تشغيلي) — قبول: صحة العامل · تقارير حسب العملة · خصوصية تيليجرام.
 */
import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { evaluateWorkerHealth, DEFAULT_WORKER_STALE_MS } from "@/modules/jobs/worker-health";
import { buildOrderTelegramMessage, formatOrderDate } from "@/modules/orders/notify";
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

describe("Phase 3 — تنسيق إشعار تيليجرام المستقل", () => {
  it("الرسالة تحتوي طلبًا واحدًا ومنتجًا واحدًا وبكل الحقول", () => {
    const text = buildOrderTelegramMessage({
      orderNumber: "ORD-28262",
      createdAt: new Date("2026-11-01T13:55:43Z"),
      timeZone: "Asia/Amman",
      customerName: "بلال عربش",
      phone: "0993958355",
      address: "حلب مدينة الباب",
      productName: "ماء الكمأ الأصلي",
      offerName: "قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني",
      price: 25,
      quantity: 1,
    });
    expect(text).toBe([
      "رقم الطلب: ORD-28262",
      "تاريخ الطلب: 2026-11-01 16:55:43",
      "إسم العميل: بلال عربش",
      "رقم الهاتف: 0993958355",
      "عنوان العميل: حلب مدينة الباب",
      "إسم المنتج: ماء الكمأ الأصلي",
      "إسم العرض: قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني",
      "السعر: 25",
      "الكمية: 1",
    ].join("\n"));
  });
  it("التاريخ 24 ساعة بمنطقة المساحة", () => {
    expect(formatOrderDate(new Date("2026-11-01T21:05:09Z"), "Asia/Amman")).toBe("2026-11-02 00:05:09");
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
