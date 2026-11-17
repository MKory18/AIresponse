/**
 * الحزمة 3.3 — «اليوم»: فترات بتوقيت المساحة · الأرقام الأربعة بقاعدة احتسابها · «بتتثبّت هلأ» · «آخر الطلبات».
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createFakeDb } from "./helpers/inmemory-db";
import { parseRange, resolveRange, startOfDayInZone, tzOffsetMs } from "@/modules/today/range";
import { DEFINITIONS, getToday } from "@/modules/today/service";

const WS = "ws-today";
const NOW = new Date("2026-11-17T12:00:00.000Z"); // عمّان UTC+3 = 15:00
let db: ReturnType<typeof createFakeDb>;
const H = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeEach(async () => {
  db = createFakeDb();
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w", timezone: "Asia/Amman" } } as never);
});

describe("الفترات بتوقيت المساحة", () => {
  it("بداية اليوم بعمّان = 21:00 UTC اليوم اللي قبله (مش منتصف الليل UTC)", () => {
    expect(startOfDayInZone(NOW, "Asia/Amman").toISOString()).toBe("2026-11-16T21:00:00.000Z");
    expect(startOfDayInZone(NOW, "UTC").toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(tzOffsetMs(NOW, "Asia/Amman")).toBe(3 * H);
  });

  it("بعد منتصف الليل المحلي = يوم جديد حتى لو UTC لسا بنفس اليوم", () => {
    const at = new Date("2026-11-17T21:30:00.000Z"); // 00:30 عمّان يوم 18
    expect(startOfDayInZone(at, "Asia/Amman").toISOString()).toBe("2026-11-17T21:00:00.000Z");
  });

  it("منطقة مجهولة = UTC (ما بترمي)", () => {
    expect(startOfDayInZone(NOW, "Not/AZone").toISOString()).toBe("2026-11-17T00:00:00.000Z");
  });

  it("اليوم: من بداية اليوم لهلأ، ويقارن بنفس المدة من أمس", () => {
    const r = resolveRange("today", NOW, "Asia/Amman");
    expect(r.start.toISOString()).toBe("2026-11-16T21:00:00.000Z");
    expect(r.end).toEqual(NOW);
    expect(r.prevStart.toISOString()).toBe("2026-11-15T21:00:00.000Z");
    expect(r.prevEnd.getTime() - r.prevStart.getTime()).toBe(NOW.getTime() - r.start.getTime());
    expect(r.prevLabel).toBe("عن أمس");
  });

  it("أمس: يوم كامل، ويقارن باللي قبله", () => {
    const r = resolveRange("yesterday", NOW, "Asia/Amman");
    expect(r.start.toISOString()).toBe("2026-11-15T21:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-11-16T21:00:00.000Z");
    expect(r.prevEnd).toEqual(r.start);
  });

  it("7 أيام: ٦ أيام كاملة + اليوم، والفترة السابقة بنفس الطول متصلة فيها", () => {
    const r = resolveRange("7d", NOW, "UTC");
    expect(r.start.toISOString()).toBe("2026-11-11T00:00:00.000Z");
    expect(r.prevEnd).toEqual(r.start);
    expect(r.prevEnd.getTime() - r.prevStart.getTime()).toBe(r.end.getTime() - r.start.getTime());
  });

  it("parseRange: قيمة تالفة = اليوم", () => {
    expect(parseRange("30d")).toBe("30d");
    expect(parseRange("garbage")).toBe("today");
    expect(parseRange(null)).toBe("today");
  });
});

describe("الأرقام الأربعة", () => {
  const order = (id: string, status: string, total: number, at: Date, extra: object = {}) =>
    db.order.create({ data: { id, workspaceId: WS, orderNumber: id.toUpperCase(), status, total, currency: "JOD", customerId: "c", createdAt: at, ...extra } } as never);
  const conv = (id: string, at: Date) => db.conversation.create({ data: { id, workspaceId: WS, customerId: "x", channelId: "ch", channelConversationId: id, createdAt: at } } as never);

  it("مساحة فاضية: أصفار، والنسبة بلا عيّنة = null (مش 0%)", async () => {
    const t = await getToday(db, WS, "today", NOW);
    expect(t.metrics.map((m) => m.value)).toEqual([0, 0, 0, null]);
    expect(t.metrics[3]!.delta).toBeNull();
    expect(t.timezone).toBe("Asia/Amman");
  });

  it("كل رقم معه قاعدة احتسابه", async () => {
    const t = await getToday(db, WS, "today", NOW);
    expect(t.metrics.map((m) => m.definition)).toEqual([DEFINITIONS.newConversations, DEFINITIONS.sealedOrders, DEFINITIONS.ordersValue, DEFINITIONS.conversionRate]);
    for (const m of t.metrics) expect(m.definition.length).toBeGreaterThan(10);
  });

  it("المثبّتة بس تنحسب (مش قيد التجميع ولا ملغاة)، والقيمة بعملة الأكثر", async () => {
    await order("a", "CONFIRMED", 20, ago(1 * H));
    await order("b", "DELIVERED", 30, ago(2 * H));
    await order("c", "NEW", 99, ago(1 * H));
    await order("d", "CANCELLED", 99, ago(1 * H));
    await order("e", "CONFIRMATION_PENDING", 99, ago(1 * H));
    const t = await getToday(db, WS, "today", NOW);
    expect(t.metrics[1]!.value).toBe(2);
    expect(t.metrics[2]).toMatchObject({ value: 50, currency: "JOD", unit: "money" });
  });

  it("الفرق عن الفترة السابقة (▲ ▼) ونسبة التحويل بالنقاط", async () => {
    // اليوم: 6 محادثات و3 طلبات (50%) — أمس بنفس الساعات: 5 محادثات وطلب (20%)
    for (let i = 0; i < 6; i++) await conv(`t${i}`, ago(1 * H));
    for (let i = 0; i < 3; i++) await order(`o${i}`, "CONFIRMED", 10, ago(1 * H));
    for (let i = 0; i < 5; i++) await conv(`y${i}`, ago(26 * H));
    await order("oy", "CONFIRMED", 10, ago(26 * H));
    const t = await getToday(db, WS, "today", NOW);
    expect(t.metrics[0]).toMatchObject({ value: 6, delta: 1 });
    expect(t.metrics[1]).toMatchObject({ value: 3, delta: 2 });
    expect(t.metrics[3]).toMatchObject({ value: 50, delta: 30, unit: "percent" });
  });

  it("المحادثات المحذوفة ومساحات تانية ما بتنحسب", async () => {
    await conv("keep", ago(1 * H));
    await db.conversation.create({ data: { id: "del", workspaceId: WS, customerId: "x", channelId: "ch", channelConversationId: "del", createdAt: ago(1 * H), deletedAt: ago(30 * 60_000) } } as never);
    await db.conversation.create({ data: { id: "oth", workspaceId: "other", customerId: "x", channelId: "ch", channelConversationId: "oth", createdAt: ago(1 * H) } } as never);
    expect((await getToday(db, WS, "today", NOW)).metrics[0]!.value).toBe(1);
  });
});

describe("بتتثبّت هلأ · آخر الطلبات", () => {
  it("طلبات NEW إلها مهلة جاية، الأقرب أول، بلا الموقوفة والمنتهية مهلتها", async () => {
    const mk = (id: string, extra: object) => db.order.create({ data: { id, workspaceId: WS, orderNumber: id, status: "NEW", customerId: "c", total: 5, currency: "JOD", recipientName: "أبو أحمد", ...extra } } as never);
    await mk("late", { settleAt: new Date(NOW.getTime() + 8 * 60_000) });
    await mk("soon", { settleAt: new Date(NOW.getTime() + 2 * 60_000) });
    await mk("held", { settleAt: new Date(NOW.getTime() + 5 * 60_000), heldBy: "u1" });
    await mk("past", { settleAt: new Date(NOW.getTime() - 60_000) });
    await db.orderItem.create({ data: { orderId: "soon", productId: "p", productNameSnapshot: "كريم حرير", quantity: 2, unitPrice: 5, subtotal: 10, skuSnapshot: "s" } } as never);
    const t = await getToday(db, WS, "today", NOW);
    expect(t.settling.map((s) => s.id)).toEqual(["soon", "late"]);
    expect(t.settling[0]).toMatchObject({ recipientName: "أبو أحمد", items: "كريم حرير ×2" });
  });

  it("آخر 5 طلبات بتسمية حالة واحدة (من orderStatusLabel)، والأحدث أول", async () => {
    for (let i = 0; i < 7; i++) {
      await db.order.create({ data: { id: `r${i}`, workspaceId: WS, orderNumber: `R${i}`, status: i === 0 ? "CONFIRMATION_PENDING" : "CONFIRMED", customerId: "c", total: 10 + i, currency: "USD", createdAt: ago((7 - i) * 60_000) } } as never);
    }
    const t = await getToday(db, WS, "today", NOW);
    expect(t.recent).toHaveLength(5);
    expect(t.recent[0]!.orderNumber).toBe("R6");
    expect(t.recent.every((r) => typeof r.status === "string" && r.status.length > 0)).toBe(true);
  });
});

describe("المسار", () => {
  it("/api/today بصلاحية analytics.read وبحد سرعة", () => {
    const r = readFileSync("src/app/api/today/route.ts", "utf8");
    expect(r).toContain('permission: "analytics.read"');
    expect(r).toContain("rateLimit");
  });
});
