/**
 * الحزمة 1.9 — القطع لقارئ الطلب (02-ORDER-FLOW §14): المالك بيقرر، والأدوات:
 * معيار القطع بالأرقام · التحويل لـ READER بتأكيدات + تسكير المسودات المفتوحة مع تدقيق ·
 * الرجوع بكبسة بلا حذف.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { changeOrderRules, retireOpenDrafts, shadowReadiness } from "@/modules/orders/reader/cutover";

type Db = Prisma.TransactionClient;
const WS = "ws-cut";
const OWNER = { userId: "owner-1", workspaceId: WS, role: "OWNER" };
const ADMIN = { userId: "admin-1", workspaceId: WS, role: "ADMIN" };
const NOW = new Date("2026-11-20T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600_000);

let db: ReturnType<typeof createFakeDb>;
const mode = async () => ((await db.workspace.findUnique({ where: { id: WS } })) as any).integrationSettings?.orderMode;
const drafts = () => db._stores.orderDraft as any[];
const audits = (action: string) => (db._stores.auditLog as any[]).filter((a) => a.action === action);
const src = (p: string) => readFileSync(p, "utf8");

async function reading(i: number, over: Record<string, unknown> = {}) {
  await db.conversationReading.create({
    data: { workspaceId: WS, conversationId: `c${i}`, stage: "COMPLETE", status: "DONE", flags: [], missing: [], data: {}, createdAt: daysAgo(4), ...over },
  } as never);
}
async function legacyOrder(i: number) {
  await db.order.create({ data: { workspaceId: WS, orderNumber: `ORD-${i}`, customerId: "cu", conversationId: `c${i}`, draftId: `d${i}`, status: "CONFIRMED", total: 1, currency: "USD" } } as never);
}
async function draft(state: string, over: Record<string, unknown> = {}) {
  return (await db.orderDraft.create({ data: { workspaceId: WS, conversationId: "cx", customerId: "cu", state, ...over } } as never)) as any;
}

beforeEach(async () => {
  db = createFakeDb();
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
});

describe("معيار القطع بالأرقام", () => {
  it("بلا بيانات: المعايير المحسوبة null (ما في شي ينحكم عليه) والتفعيل غير جاهز", async () => {
    const r = await shadowReadiness(db as Db, WS, NOW);
    expect(r.readings).toBe(0);
    expect(r.criteria.filter((c) => c.key !== "MANUAL_SAMPLE").every((c) => c.ok === null)).toBe(true);
    expect(r.computedOk).toBe(false);
    expect(r.criteria.find((c) => c.key === "MANUAL_SAMPLE")!.ok).toBeNull();
  });

  it("جاهز: 4 أيام ظل · القارئ لقط كل طلبات المسودة · مراجعة < 25% · فشل < 10%", async () => {
    for (let i = 1; i <= 8; i++) await reading(i, i === 1 ? { flags: ["PHONE_AMBIGUOUS"] } : {});
    for (let i = 1; i <= 4; i++) await legacyOrder(i);
    const r = await shadowReadiness(db as Db, WS, NOW);
    expect(r.shadowDays).toBe(4);
    expect(r.computedOk).toBe(true);
    expect(r.reviewRate).toBeCloseTo(1 / 8);
    expect(r.summary).toMatchObject({ agreed: 4, legacyOnly: 0, readerOnly: 4 });
  });

  it("أقل من 3 أيام ← ما اكتمل", async () => {
    await reading(1, { createdAt: daysAgo(1) });
    await legacyOrder(1);
    const r = await shadowReadiness(db as Db, WS, NOW);
    expect(r.criteria.find((c) => c.key === "SHADOW_DAYS")!.ok).toBe(false);
    expect(r.computedOk).toBe(false);
  });

  it("طلب سجّلته المسودة وفوّته القارئ ← فاشل بتفصيل ⚠️", async () => {
    await reading(1);
    await reading(2, { stage: "COLLECTING" });
    await legacyOrder(1);
    await legacyOrder(2);
    const r = await shadowReadiness(db as Db, WS, NOW);
    const c = r.criteria.find((x) => x.key === "NO_MISSED_ORDERS")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("1 طلب فوّته القارئ");
  });

  it("«تحتاج مراجعة» 25% أو أكتر ← فاشل · والقراءات الفاشلة 10% أو أكتر ← فاشل", async () => {
    for (let i = 1; i <= 4; i++) await reading(i, i <= 2 ? { flags: ["NO_AGREEMENT"] } : {});
    expect((await shadowReadiness(db as Db, WS, NOW)).criteria.find((x) => x.key === "REVIEW_RATE")!.ok).toBe(false);
    await reading(9, { status: "FAILED", stage: "NONE" });
    expect((await shadowReadiness(db as Db, WS, NOW)).criteria.find((x) => x.key === "FAILED_RATE")!.ok).toBe(false);
  });
});

describe("تسكير المسودات المفتوحة", () => {
  it("المفتوحة بتصير CANCELLED مع سطر تدقيق لكل وحدة، والمحوّلة/المسكّرة ما بتنلمس", async () => {
    const open = [await draft("EMPTY"), await draft("COLLECTING"), await draft("READY"), await draft("CONFIRMING")];
    const converted = await draft("CONVERTED", { orderId: "o1" });
    const cancelled = await draft("CANCELLED");
    const n = await retireOpenDrafts(db as Db, WS, "owner-1");
    expect(n).toBe(4);
    for (const d of open) expect(drafts().find((x) => x.id === d.id).state).toBe("CANCELLED");
    expect(drafts().find((x) => x.id === converted.id).state).toBe("CONVERTED");
    expect(drafts().find((x) => x.id === cancelled.id).state).toBe("CANCELLED");
    expect(audits("order_draft.retired")).toHaveLength(4);
    expect(audits("order_draft.retired")[0].metadata).toMatchObject({ reason: "READER_CUTOVER" });
  });
});

describe("تغيير الوضع والإعدادات", () => {
  it("الوضع للمالك فقط؛ الإعدادات الباقية لغيره مسموحة", async () => {
    await expect(changeOrderRules(db as Db, ADMIN, { orderMode: "READER_SHADOW" })).rejects.toMatchObject({ code: "OWNER_ONLY" });
    expect(await mode()).toBeUndefined();
    const r = await changeOrderRules(db as Db, ADMIN, { orderSettleMinutes: 15, orderAutoSeal: false });
    expect(r.settings).toMatchObject({ orderSettleMinutes: 15, orderAutoSeal: false, orderMode: "LEGACY_DRAFT" });
    expect(audits("order_reader.rules_updated")).toHaveLength(1);
  });

  it("الظل بتغيير وحدة من المالك، بلا تأكيدات وبلا تسكير مسودات", async () => {
    await draft("COLLECTING");
    const r = await changeOrderRules(db as Db, OWNER, { orderMode: "READER_SHADOW" });
    expect(r.retiredDrafts).toBe(0);
    expect(await mode()).toBe("READER_SHADOW");
    expect(drafts()[0].state).toBe("COLLECTING");
    expect(audits("order_reader.mode_changed")[0].metadata).toMatchObject({ from: "LEGACY_DRAFT", to: "READER_SHADOW" });
  });

  it("READER بدون تأكيد المراجعة ← مرفوض", async () => {
    await expect(changeOrderRules(db as Db, OWNER, { orderMode: "READER" })).rejects.toMatchObject({ code: "REVIEW_CONFIRMATION_REQUIRED" });
    expect(await mode()).toBeUndefined();
  });

  it("READER والمعيار ما اكتمل: بدون تأكيد المخاطر ← مرفوض · ومعه ← بيتفعّل وبيسكّر المسودات", async () => {
    await draft("COLLECTING");
    await draft("READY");
    await expect(changeOrderRules(db as Db, OWNER, { orderMode: "READER", confirmReviewed: true })).rejects.toMatchObject({ code: "READINESS_NOT_MET" });
    expect(drafts().every((d) => d.state !== "CANCELLED")).toBe(true);
    const r = await changeOrderRules(db as Db, OWNER, { orderMode: "READER", confirmReviewed: true, acknowledgeRisks: true });
    expect(r.retiredDrafts).toBe(2);
    expect(await mode()).toBe("READER");
    expect(drafts().every((d) => d.state === "CANCELLED")).toBe(true);
    expect(audits("order_reader.mode_changed")[0].metadata).toMatchObject({ to: "READER", retiredDrafts: 2, acknowledgedRisks: true });
  });

  it("READER والمعيار مكتمل: التأكيد وحده يكفي", async () => {
    for (let i = 1; i <= 8; i++) await reading(i);
    for (let i = 1; i <= 3; i++) await legacyOrder(i);
    // الوقت الحقيقي أبعد من NOW بالفحص: القراءات عمرها 4 أيام من NOW، فبنثبّت الساعة حقيقيًا:
    for (const r of db._stores.conversationReading as any[]) r.createdAt = new Date(Date.now() - 4 * 24 * 3600_000);
    const res = await changeOrderRules(db as Db, OWNER, { orderMode: "READER", confirmReviewed: true });
    expect(await mode()).toBe("READER");
    expect(res.settings.orderMode).toBe("READER");
  });

  it("الرجوع لـ LEGACY_DRAFT بكبسة: بلا تأكيدات ولا حذف، والطلبات اللي بتستنى بتنعدّ", async () => {
    await changeOrderRules(db as Db, OWNER, { orderMode: "READER", confirmReviewed: true, acknowledgeRisks: true });
    await db.order.create({ data: { workspaceId: WS, orderNumber: "ORD-W", customerId: "cu", conversationId: "cw", status: "NEW", total: 1, currency: "USD" } } as never);
    await db.order.create({ data: { workspaceId: WS, orderNumber: "ORD-S", customerId: "cu", conversationId: "cs", status: "CONFIRMED", sealedAt: new Date(), total: 1, currency: "USD" } } as never);
    const before = { orders: db._stores.order.length, readings: db._stores.conversationReading.length };
    const r = await changeOrderRules(db as Db, OWNER, { orderMode: "LEGACY_DRAFT" });
    expect(await mode()).toBe("LEGACY_DRAFT");
    expect(r.awaitingOrders).toBe(1);
    expect(r.retiredDrafts).toBe(0);
    expect(db._stores.order.length).toBe(before.orders);
    expect(db._stores.conversationReading.length).toBe(before.readings);
  });

  it("قيم غلط (مهلة 1 دقيقة · وضع مجهول) ← رفض", async () => {
    await expect(changeOrderRules(db as Db, OWNER, { orderSettleMinutes: 1 })).rejects.toBeTruthy();
    await expect(changeOrderRules(db as Db, OWNER, { orderMode: "WEIRD" as never })).rejects.toBeTruthy();
  });
});

describe("المسار والواجهة", () => {
  it("المسار بصلاحية ai.configure ومخطط صارم، والوضع للمالك بالخدمة", () => {
    const r = src("src/app/api/settings/order-rules/route.ts");
    expect(r.match(/permission: "ai\.configure"/g)).toHaveLength(2);
    expect(r).toContain(".strict()");
    expect(r).toContain("canChangeMode: auth!.role === \"OWNER\"");
    expect(src("src/modules/orders/reader/cutover.ts")).toContain('"OWNER_ONLY"');
  });

  it("البطاقة بصفحة «التشغيل»: أوضاع ثلاثة + معيار القطع + تأكيدات + خطر/تصحيح + رجوع", () => {
    expect(src("src/app/(dashboard)/settings/ai/page.tsx")).toContain("<OrderRulesCard />");
    const c = src("src/app/(dashboard)/settings/ai/order-rules-card.tsx");
    for (const s of ["المسودة (الحالي)", "الظل", "القارئ شغّال", "معيار القطع", "راجعت عيّنة 30 محادثة", "فاهم إن معيار القطع", "فعّل القارئ", "RiskWithFix", "للرجوع: اختار «المسودة»", "التثبيت التلقائي", "مهلة التثبيت"]) {
      expect(c, s).toContain(s);
    }
    expect(c).not.toMatch(/Hermes/);
    expect(c).not.toMatch(/type="password"/);
  });
});
