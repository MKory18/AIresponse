/**
 * «طلب يدوي» (3.2): موظف بيدخل طلب باليد. نفس القواعد والتسعير من القاعدة، تثبيت فوري، بلا محادثة.
 * ⚠️ قاعدة بالذاكرة — سلوك لا PostgreSQL حقيقي.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { createManualOrder, manualOrderSchema, type ManualOrderInput } from "@/modules/orders/manual-order";
import { tabWhere } from "@/modules/orders/list-filters";
import { hasPermission } from "@/modules/rbac/permissions";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;
type Row = Record<string, any>;
// أول طلب بيحمّل وحدات التنبيه (تلجرام/الـ OMS) ديناميكيًا — على جهاز مشغول بيتجاوز 5 ثواني.
vi.setConfig({ testTimeout: 30_000 });

const WS = "ws-manual-order";
const WS_B = "ws-manual-other";
const AGENT = { userId: "agent-1", workspaceId: WS };

let db: FakeDb;
let tea: { id: string };
let honey: { id: string };

const input = (over: Partial<ManualOrderInput> = {}): ManualOrderInput => ({
  customer: { phone: "0791234567", name: "سامر", province: "عمان", address: "عمان - الدوار السابع" },
  items: [{ productId: tea.id, quantity: 2 }],
  ...over,
});
const stores = () => db._stores as Record<string, Row[]>;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return `${(e as { statusCode?: number }).statusCode}:${(e as { code?: string }).code}`;
  }
};

beforeEach(async () => {
  db = createFakeDb() as FakeDb;
  tea = await createProduct(db as unknown as Db, AGENT, { name: "شاي", sku: "MAN-TEA", price: 10, currency: "USD" });
  honey = await createProduct(db as unknown as Db, AGENT, { name: "عسل", sku: "MAN-HONEY", price: 25.5, currency: "USD" });
});

describe("إنشاء الطلب اليدوي", () => {
  it("بيثبّت فورًا: CONFIRMED + CONFIRMED_BY_AGENT + sealedAt + مصدر MANUAL، بلا محادثة ولا مسودة، والسعر من القاعدة", async () => {
    const r = await createManualOrder(db as unknown as Db, AGENT, input({ items: [{ productId: tea.id, quantity: 2 }, { productId: honey.id, quantity: 1 }] }));
    expect(r).toMatchObject({ created: true, status: "CONFIRMED", currency: "USD" });
    expect(r.total).toBe(45.5); // 2×10 + 25.5 (بلا رسوم توصيل معرّفة)
    const o = stores().order[0];
    expect(o).toMatchObject({
      workspaceId: WS, status: "CONFIRMED", confirmationStatus: "CONFIRMED_BY_AGENT", source: "MANUAL", agreement: "STAFF",
      conversationId: null, draftId: null, province: "عمان", recipientName: "سامر", recipientPhone: "0791234567",
    });
    expect(o.sealedAt).toBeTruthy();
    expect(stores().orderDraft.length).toBe(0);
    expect(stores().conversation.length).toBe(0);
    expect(stores().orderItem.map((i) => [i.productNameSnapshot, i.quantity, Number(i.unitPrice)])).toEqual([["شاي", 2, 10], ["عسل", 1, 25.5]]);
    // تبويب «مثبّتة» بيشملها
    expect(JSON.stringify(tabWhere("sealed"))).toContain("sealedAt");
    expect(stores().auditLog.some((a) => a.action === "order.created" && a.metadata?.source === "MANUAL")).toBe(true);
  });

  it("زبون جديد بينشأ برقمه المطبّع، وزبون موجود بنفس الرقم ما بيتكرر", async () => {
    await createManualOrder(db as unknown as Db, AGENT, input({ customer: { phone: "+963 944 000 111", name: "ليلى", province: "دمشق", address: "المزة" } }));
    expect(stores().customer.map((c) => c.phone)).toEqual(["0944000111"]);
    await createManualOrder(db as unknown as Db, AGENT, input({ customer: { phone: "0944000111", name: "ليلى", province: "دمشق", address: "المزة" }, items: [{ productId: honey.id, quantity: 1 }] }));
    expect(stores().customer.length).toBe(1);
    expect(stores().order.length).toBe(2);
  });

  it("إعادة الإرسال بنفس idempotencyKey بترجّع نفس الطلب (طلب واحد)", async () => {
    const a = await createManualOrder(db as unknown as Db, AGENT, input({ idempotencyKey: "form-open-0001" }));
    const b = await createManualOrder(db as unknown as Db, AGENT, input({ idempotencyKey: "form-open-0001" }));
    expect(b).toMatchObject({ orderId: a.orderId, created: false });
    expect(stores().order.length).toBe(1);
  });

  it("مفاتيح idempotency بمساحتين مختلفتين ما بتتصادم", async () => {
    const other = { userId: "agent-b", workspaceId: WS_B };
    const pB = await createProduct(db as unknown as Db, other, { name: "شاي", sku: "MAN-TEA-B", price: 10, currency: "USD" });
    await createManualOrder(db as unknown as Db, AGENT, input({ idempotencyKey: "same-key-0001" }));
    const r = await createManualOrder(db as unknown as Db, other, input({ idempotencyKey: "same-key-0001", items: [{ productId: pB.id, quantity: 1 }] }));
    expect(r.created).toBe(true);
    expect(stores().order.length).toBe(2);
  });
});

describe("الرفض: نفس قواعد الطلب العادي", () => {
  it("رقم غير صالح = 422 INVALID_PHONE", async () => {
    expect(await code(createManualOrder(db as unknown as Db, AGENT, input({ customer: { phone: "12ab", name: "س", province: "عمان", address: "عمان" } })))).toBe("422:INVALID_PHONE");
  });

  it("منتج مش بمساحتك = 404 · منتج موقوف أو خالص = 422 ORDER_RULES_DENIED", async () => {
    const other = { userId: "agent-b", workspaceId: WS_B };
    const foreign = await createProduct(db as unknown as Db, other, { name: "غريب", sku: "MAN-X", price: 5, currency: "USD" });
    expect(await code(createManualOrder(db as unknown as Db, AGENT, input({ items: [{ productId: foreign.id, quantity: 1 }] })))).toBe("404:NOT_FOUND");
    stores().product.find((p) => p.id === honey.id)!.stockStatus = "OUT_OF_STOCK";
    expect(await code(createManualOrder(db as unknown as Db, AGENT, input({ items: [{ productId: honey.id, quantity: 1 }] })))).toBe("422:ORDER_RULES_DENIED");
    stores().product.find((p) => p.id === tea.id)!.isActive = false;
    expect(await code(createManualOrder(db as unknown as Db, AGENT, input()))).toBe("422:ORDER_RULES_DENIED");
    expect(stores().order.length).toBe(0);
  });

  it("كمية فوق الحد = 422، والمحافظة غير المخدّمة = 422", async () => {
    expect(await code(createManualOrder(db as unknown as Db, AGENT, input({ items: [{ productId: tea.id, quantity: 101 }] })))).toBe("422:ORDER_RULES_DENIED");
    stores().deliveryRule.push({ id: "dr1", workspaceId: WS, province: "الرقة", isAvailable: false, fee: 0 });
    expect(await code(createManualOrder(db as unknown as Db, AGENT, input({ customer: { phone: "0791234567", name: "س", province: "الرقة", address: "حي" } })))).toBe("422:ORDER_RULES_DENIED");
    expect(stores().order.length).toBe(0);
  });

  it("زبون بالقائمة السوداء = 422 ولا طلب ولا زبون جديد", async () => {
    stores().customer.push({ id: "cu-bl", workspaceId: WS, name: "محظور", phone: "0791234567", isBlacklisted: true });
    expect(await code(createManualOrder(db as unknown as Db, AGENT, input()))).toBe("422:ORDER_CUSTOMER_BLACKLISTED");
    expect(stores().order.length).toBe(0);
    expect(stores().customer.length).toBe(1);
  });

  it("تكرار (نفس الزبون والمنتج خلال 24 ساعة) = 409 DUPLICATE_ORDER، وبيكمل بـ allowDuplicate", async () => {
    await createManualOrder(db as unknown as Db, AGENT, input());
    expect(await code(createManualOrder(db as unknown as Db, AGENT, input()))).toBe("409:DUPLICATE_ORDER");
    expect(stores().order.length).toBe(1);
    const r = await createManualOrder(db as unknown as Db, AGENT, input({ allowDuplicate: true }));
    expect(r.created).toBe(true);
    expect(stores().order.length).toBe(2);
    expect(stores().auditLog.some((a) => a.action === "order.created" && a.metadata?.duplicateAllowed === true)).toBe(true);
  });

  it("نفس المنتج مرتين بالسلة = سطر واحد بكمية مجمّعة", async () => {
    await createManualOrder(db as unknown as Db, AGENT, input({ items: [{ productId: tea.id, quantity: 1 }, { productId: tea.id, quantity: 2 }] }));
    expect(stores().orderItem.map((i) => i.quantity)).toEqual([3]);
  });
});

describe("المدخلات والصلاحية", () => {
  it("الـschema صارمة: حقل زيادة (مثل السعر) مرفوض، والكمية صحيحة موجبة، وسلة غير فاضية", () => {
    const base = input();
    expect(manualOrderSchema.safeParse(base).success).toBe(true);
    expect(manualOrderSchema.safeParse({ ...base, items: [{ productId: tea.id, quantity: 1, price: 0.01 }] }).success).toBe(false);
    expect(manualOrderSchema.safeParse({ ...base, total: 1 }).success).toBe(false);
    expect(manualOrderSchema.safeParse({ ...base, items: [] }).success).toBe(false);
    expect(manualOrderSchema.safeParse({ ...base, items: [{ productId: tea.id, quantity: 1.5 }] }).success).toBe(false);
    expect(manualOrderSchema.safeParse({ ...base, items: [{ productId: tea.id, quantity: 0 }] }).success).toBe(false);
  });

  it("`orders.write` شرط المسار: الأدوار اللي بتكتب بس", () => {
    expect(hasPermission("MANAGER", [], "orders.write")).toBe(true);
    expect(hasPermission("MANAGER", [], "orders.delete")).toBe(false);
  });
});
