/**
 * الحزمة 3.2أ — فلاتر قائمة الطلبات من الخادم: التبويبات + عدّاداتها الكاملة + البحث + العدد الكلي.
 * ⚠️ قبل: عدّادات صفحة الطلبات كانت محسوبة من أول 25 صف محمّلين. 🔧 هلأ: من الخادم، وبنفس تعريف `orderMatchesTab`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { listOrders } from "@/modules/orders/order-service";
import { ORDER_TAB_KEYS, ordersCounts, searchWhere, tabWhere } from "@/modules/orders/list-filters";
import { ORDER_TABS, orderMatchesTab } from "@/lib/order-status";

type Db = Prisma.TransactionClient;
const WS = "ws-list";
let db: ReturnType<typeof createFakeDb>;

const mk = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  db.order.create({
    data: { id, workspaceId: WS, orderNumber: `SY-${id}`, status, customerId: "c1", total: 10, currency: "USD", recipientName: "عميل", ...extra },
  } as never);

beforeEach(async () => {
  db = createFakeDb();
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
  await db.customer.create({ data: { id: "c1", workspaceId: WS, name: "أحمد خالد", phone: "0964123348" } } as never);
  await mk("a", "NEW");
  await mk("b", "NEW", { heldBy: "u1" });
  await mk("c", "CONFIRMATION_PENDING");
  await mk("d", "CONFIRMED");
  await mk("e", "DELIVERED");
  await mk("f", "RETURNED");
  await mk("g", "CANCELLED");
  await mk("h", "FAILED");
  await mk("i", "NEW", { sealedAt: new Date() }); // مثبّت بالقارئ (sealedAt) حتى لو الحالة NEW
  await mk("o", "CONFIRMED", { workspaceId: "other" });
});

describe("التبويبات = orderMatchesTab (نفس التعريف بالحرف)", () => {
  it("كل تبويب بيرجّع نفس الصفوف اللي بيرجّعها تعريف العميل", async () => {
    const all = (db as unknown as { _stores: { order: Array<Record<string, unknown>> } })._stores.order.filter((o) => o.workspaceId === WS);
    for (const tab of ORDER_TAB_KEYS) {
      const res = await listOrders(db as unknown as Db, { workspaceId: WS, tab, limit: 100 });
      const expected = all.filter((o) => orderMatchesTab({ status: String(o.status), sealedAt: (o.sealedAt as Date | null) ?? null }, tab)).map((o) => o.id).sort();
      expect(res.items.map((o) => o.id).sort(), tab).toEqual(expected);
      expect(res.total, `total/${tab}`).toBe(expected.length);
    }
  });

  it("العدّادات كاملة ومن الخادم ومعزولة بالمساحة", async () => {
    const c = await ordersCounts(db, WS);
    expect(c).toEqual({ all: 9, review: 1, awaiting: 3, sealed: 4, cancelled: 2 });
  });

  it("كل مفاتيح التبويبات بالواجهة موجودة بالخادم", () => {
    expect(ORDER_TAB_KEYS).toEqual(ORDER_TABS.map((t) => t.key));
    expect(tabWhere("all")).toEqual({});
    expect(tabWhere(undefined)).toEqual({});
  });
});

describe("البحث", () => {
  it("برقم الطلب أو المستلم أو العميل (اسم/رقم)", async () => {
    await mk("z", "NEW", { orderNumber: "SY-2026-0148", recipientName: "سامي", recipientPhone: "0999111222" });
    const find = async (q: string) => (await listOrders(db as unknown as Db, { workspaceId: WS, q })).items.map((o) => o.id);
    expect(await find("0148")).toEqual(["z"]);
    expect(await find("سامي")).toEqual(["z"]);
    expect(await find("0999111")).toEqual(["z"]);
  });

  it("البحث بالعميل (اسم/رقم) بيدخل بالشرط — العلاقة نفسها بتنفّذها Prisma", () => {
    const w = JSON.stringify(searchWhere("أحمد"));
    expect(w).toContain('"customer":{"name"');
    expect(JSON.stringify(searchWhere("0964123"))).toContain('"customer":{"phone"');
  });

  it("حرف واحد أو فاضي = ما بيفلتر، والأرقام الهندية بتتحوّل", () => {
    expect(searchWhere("أ")).toEqual({});
    expect(searchWhere("   ")).toEqual({});
    expect(searchWhere(undefined)).toEqual({});
    expect(JSON.stringify(searchWhere("٠٩٦٤"))).toContain("0964");
  });

  it("التبويب والبحث معًا (AND)", async () => {
    await mk("y", "CONFIRMATION_PENDING", { recipientName: "ليلى" });
    const r = await listOrders(db as unknown as Db, { workspaceId: WS, tab: "review", q: "ليلى" });
    expect(r.items.map((o) => o.id)).toEqual(["y"]);
    expect(r.total).toBe(1);
    expect((await listOrders(db as unknown as Db, { workspaceId: WS, tab: "sealed", q: "ليلى" })).total).toBe(0);
  });
});

describe("العدد الكلي والتحميل بالدفعات", () => {
  it("total بيبقى الكلي حتى لو الصفحة أصغر («عرض 3 من 9»)", async () => {
    const r = await listOrders(db as unknown as Db, { workspaceId: WS, limit: 3 });
    expect(r.items).toHaveLength(3);
    expect(r.nextCursor).not.toBeNull();
    expect(r.total).toBe(9);
  });
});

describe("المسارات", () => {
  const src = (p: string) => readFileSync(p, "utf8");
  it("الفلاتر مفعّلة بمسار القائمة، و/counts بصلاحية orders.read", () => {
    const list = src("src/app/api/orders/route.ts");
    expect(list).toContain("tab: z.enum");
    expect(list).toContain("q: z.string()");
    const counts = src("src/app/api/orders/counts/route.ts");
    expect(counts).toContain('permission: "orders.read"');
    expect(counts).toContain("rateLimit");
  });
});
