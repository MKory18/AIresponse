/**
 * الحزمة 1.8 — بطاقة الطلب بالواجهة الحالية (02-ORDER-FLOW §11 · 03-UI-STRUCTURE §5.2–5.3).
 * القيم كاملة للموظف (والهاتف معتّم للموديل بس) · سطر حالة واحد · أسباب المراجعة بالأحمر مع تصحيح
 * · عمود حالة واحد بقائمة الطلبات + تبويب «تحتاج مراجعة».
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { getOrderCard } from "@/modules/orders/reader/card";
import { ORDER_TABS, REVIEW_REASONS, isSealed, orderMatchesTab, orderStatusLabel, reviewReason, settleCountdown } from "@/lib/order-status";
import { omsStatusLabel } from "@/lib/oms-labels";

type Db = Prisma.TransactionClient;
const WS = "ws-card";
let db: ReturnType<typeof createFakeDb>;

const setMode = (m: string) => db.workspace.update({ where: { id: WS }, data: { integrationSettings: { orderMode: m } } } as never);
const src = (p: string) => readFileSync(p, "utf8");

beforeEach(async () => {
  db = createFakeDb();
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
});

describe("getOrderCard", () => {
  it("LEGACY_DRAFT ← mode بس (الواجهة بتبقى على بطاقة المسودة)", async () => {
    const card = await getOrderCard(db as Db, { workspaceId: WS, conversationId: "c1" });
    expect(card).toMatchObject({ mode: "LEGACY_DRAFT", reading: null, order: null, pendingChange: null, timeline: [] });
  });

  it("قراءة بلا طلب ← قيم كاملة (الهاتف والعنوان ظاهرين للموظف) + الناقص", async () => {
    await setMode("READER");
    await db.conversationReading.create({
      data: {
        workspaceId: WS,
        conversationId: "c1",
        stage: "COLLECTING",
        status: "DONE",
        version: 2,
        missing: ["address"],
        data: { items: [{ productId: "p", name: "ماء الكمأ", quantity: 2, unitPrice: 15 }], recipient: { phone: "0964123348", name: "أحمد", address: null, province: "درعا" }, totals: { currency: "USD" } },
      },
    } as never);
    const card = await getOrderCard(db as Db, { workspaceId: WS, conversationId: "c1" });
    expect(card.mode).toBe("READER");
    expect(card.order).toBeNull();
    expect(card.reading).toMatchObject({ stage: "COLLECTING", missing: ["address"], currency: "USD" });
    expect(card.reading!.recipient.phone).toBe("0964123348");
    expect(card.reading!.items[0]).toEqual({ name: "ماء الكمأ", quantity: 2, unitPrice: 15 });
  });

  it("قراءة مساحة تانية ما بتظهر (عزل)", async () => {
    await setMode("READER");
    await db.conversationReading.create({ data: { workspaceId: "other", conversationId: "c1", stage: "COMPLETE", status: "DONE", data: {} } } as never);
    expect((await getOrderCard(db as Db, { workspaceId: WS, conversationId: "c1" })).reading).toBeNull();
  });

  it("طلب مفتوح + سجل + طلب تعديل معلّق", async () => {
    await setMode("READER");
    const o = (await db.order.create({
      data: { workspaceId: WS, orderNumber: "ORD-1", customerId: "cu", conversationId: "c1", status: "CONFIRMED", sealedAt: new Date(), recipientPhone: "0964123348", deliveryAddress: "شارع (أ)", province: "درعا", total: 30, currency: "USD", reviewReasons: [] },
    } as never)) as any;
    await db.orderItem.create({ data: { orderId: o.id, productId: "p", productNameSnapshot: "ماء الكمأ", skuSnapshot: "S", unitPrice: 15, quantity: 2, subtotal: 30 } } as never);
    await db.orderRevision.create({ data: { workspaceId: WS, orderId: o.id, version: 1, kind: "READ", snapshot: {}, diff: [], evidence: [], actor: "reader" } } as never);
    await db.orderRevision.create({
      data: { workspaceId: WS, orderId: o.id, version: 2, kind: "AMEND_REQUEST", snapshot: {}, diff: [{ field: "recipientPhone", from: "0964123348", to: "0954321098" }], evidence: [], actor: "reader", omsState: "NOTE_SENT" },
    } as never);
    const card = await getOrderCard(db as Db, { workspaceId: WS, conversationId: "c1" });
    expect(card.order).toMatchObject({ orderNumber: "ORD-1", status: "CONFIRMED", total: 30, recipientPhone: "0964123348" });
    expect(card.order!.items).toEqual([{ name: "ماء الكمأ", quantity: 2, unitPrice: 15 }]);
    expect(card.timeline.map((t) => t.kind)).toEqual(["AMEND_REQUEST", "READ"]);
    expect(card.pendingChange).toMatchObject({ version: 2, kind: "AMEND_REQUEST", omsState: "NOTE_SENT" });
  });

  it("الطلب الملغى ما بيظهر ببطاقة المحادثة", async () => {
    await setMode("READER_SHADOW");
    await db.order.create({ data: { workspaceId: WS, orderNumber: "ORD-X", customerId: "cu", conversationId: "c1", status: "CANCELLED", total: 1, currency: "USD" } } as never);
    expect((await getOrderCard(db as Db, { workspaceId: WS, conversationId: "c1" })).order).toBeNull();
  });
});

describe("حالة الطلب للعرض", () => {
  it("سطر حالة واحد لكل حالة", () => {
    expect(orderStatusLabel({ status: "NEW" })).toEqual({ text: "بانتظار التثبيت", tone: "info" });
    expect(orderStatusLabel({ status: "NEW", heldBy: "u1" }).text).toContain("موقوف");
    expect(orderStatusLabel({ status: "CONFIRMATION_PENDING" })).toEqual({ text: "تحتاج مراجعة", tone: "warn" });
    expect(orderStatusLabel({ status: "CONFIRMED", sealedAt: "2026-11-17T10:00:00Z" })).toEqual({ text: "مثبّت", tone: "ok" });
    expect(orderStatusLabel({ status: "CONFIRMED", omsStatus: "CONFIRMED", omsShippingStatus: "SHIPPED" }).text).toBe("مثبّت · عند الـ OMS: مؤكد · مشحون");
    expect(orderStatusLabel({ status: "CANCELLED" }).tone).toBe("muted");
  });

  it("التبويبات: تحتاج مراجعة · بانتظار التثبيت · مثبّتة (حتى طلبات المسودة القديمة) · ملغاة", () => {
    const rows = [
      { status: "NEW" },
      { status: "CONFIRMATION_PENDING" },
      { status: "CONFIRMED", sealedAt: "2026-11-17T10:00:00Z" },
      { status: "CONFIRMED" }, // طلب مسودة قديم: مثبّت بلا sealedAt
      { status: "OUT_FOR_DELIVERY" },
      { status: "CANCELLED" },
      { status: "FAILED" },
    ];
    const count = (tab: Parameters<typeof orderMatchesTab>[1]) => rows.filter((r) => orderMatchesTab(r, tab)).length;
    expect(count("all")).toBe(7);
    expect(count("review")).toBe(1);
    expect(count("awaiting")).toBe(1);
    expect(count("sealed")).toBe(3);
    expect(count("cancelled")).toBe(2);
    expect(ORDER_TABS.map((t) => t.key)).toEqual(["all", "review", "awaiting", "sealed", "cancelled"]);
    expect(isSealed({ status: "CONFIRMED" })).toBe(true);
    expect(isSealed({ status: "NEW" })).toBe(false);
  });

  it("عدّاد التثبيت mm:ss", () => {
    const t0 = new Date("2026-11-17T10:00:00Z").getTime();
    expect(settleCountdown(new Date(t0 + 492_000), t0)).toBe("08:12");
    expect(settleCountdown(new Date(t0 - 5000), t0)).toBe("00:00");
    expect(settleCountdown(null, t0)).toBeNull();
  });

  it("كل سبب مراجعة إله خطر بالأحمر وتصحيح بالبرتقالي (قاعدة المالك) — وما في سبب بلا تسمية", () => {
    const verify = src("src/modules/orders/reader/verify.ts");
    const block = verify.slice(verify.indexOf("export type ReviewFlag"), verify.indexOf("export type MissingField"));
    const flags = [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(flags.length).toBeGreaterThanOrEqual(14);
    const extra = ["MISSING_FIELDS", "PRODUCT_UNRESOLVED", "STAFF_HOLD", "CUSTOMER_BLACKLISTED", "CHANGED_AFTER_STAFF_EDIT"];
    for (const code of [...flags, ...extra]) {
      const r = REVIEW_REASONS[code];
      expect(r, code).toBeTruthy();
      expect(r.risk.length).toBeGreaterThan(5);
      expect(r.fix.length).toBeGreaterThan(5);
    }
    expect(reviewReason("SOMETHING_NEW").risk).toContain("SOMETHING_NEW");
  });

  it("oms-labels (الملف النقي) بيشتغل من الواجهة", () => {
    expect(omsStatusLabel("CONFIRMED", "SHIPPED")).toBe("مؤكد · مشحون");
  });
});

describe("الواجهة", () => {
  it("لوحة العميل: بطاقة الطلب بدل المسودة لما في orderCard، وبأول اللوحة", () => {
    const cp = src("src/components/inbox/customer-panel.tsx");
    expect(cp).toContain("<OrderCard card={orderCard.card}");
    expect(cp).toContain("!orderCard && orderDrafts.length > 0");
    expect(cp.indexOf("<OrderCard")).toBeLessThan(cp.indexOf("{/* Identity"));
  });

  it("الوارد بيجيب البطاقة ويتحدّث لحظيًا (reading.updated · order.updated)", () => {
    const panel = src("src/app/(dashboard)/conversations/v2/side-panel.tsx");
    expect(panel).toContain("/order-card");
    expect(panel).toContain('"reading.updated"');
    expect(panel).toContain('"order.updated"');
    expect(panel).toContain('c.mode === "LEGACY_DRAFT" ? null');
  });

  it("المسار بصلاحية orders.read والأزرار بصلاحياتها من الخادم", () => {
    const route = src("src/app/api/conversations/[id]/order-card/route.ts");
    expect(route).toContain('permission: "orders.read"');
    for (const p of ["orders.seal", "orders.write", "orders.cancel", "orders.amend", "conversations.reply"]) expect(route).toContain(`"${p}"`);
  });

  it("البطاقة: الأزرار الثلاثة + قائمة ⋯ (إلغاء · أعد القراءة) + السجل + خطر/تصحيح", () => {
    const card = src("src/components/orders/order-card.tsx");
    for (const s of ["ثبّت الآن", "أوقف", "أطلق", "عدّل", "ألغِ الطلب", "أعد القراءة", "السجل", "RiskWithFix", "تم بالـ OMS", "مرفوض"]) expect(card, s).toContain(s);
    // القيم كاملة: الهاتف والعنوان بيتعرضوا (مش «✓»)
    expect(card).toContain('label="الهاتف" value={phone}');
    expect(card).not.toMatch(/type="password"/);
    expect(card).not.toMatch(/Hermes/);
  });

  it("قائمة الطلبات: عمود حالة واحد + تبويب «تحتاج مراجعة» (بلا عمود تلجرام ولا فلتر حالة التأكيد)", () => {
    const page = src("src/app/(dashboard)/orders/v2/orders-view.tsx");
    expect(page).toContain("orderStatusLabel");
    expect(page).toContain("ORDER_TABS");
    expect(page).not.toContain("<th>تلجرام</th>");
    expect(page).not.toContain("aria-label=\"حالة التأكيد\"");
  });
});
