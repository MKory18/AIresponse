/**
 * P18 — مسودة الطلب (COLLECTING) وبيانات العميل.
 *
 * يثبت:
 *  - الزبون القديم: الهاتف/العنوان/الاسم تُكمَّل من ملفه بدل سؤاله من جديد،
 *    والمسودة تصير READY لما يكتمل (منتج + كمية + اتصال).
 *  - الزبون الجديد بلا ملف: الحقول الناقصة تبقى ناقصة (لا اختراع).
 *  - اسم المنتج يظهر ببطاقة المسودة (من قاعدة البيانات).
 *  - معرّف منتج من مساحة أخرى/غير نشط ما بينقبل بالمسودة.
 *
 * ⚠️ قاعدة بالذاكرة — سلوك لا زمن إنتاج.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";

type Db = Prisma.TransactionClient;
const WS = "ws-draft-prefill";
const OTHER = "ws-draft-other";
const AGENT = { userId: "agent-draft", workspaceId: WS };

let db: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  db = createFakeDb();
});

async function product(name: string, sku: string, workspaceId = WS) {
  return createProduct(db as unknown as Db, { userId: "agent-draft", workspaceId }, {
    name,
    sku,
    price: 100,
    currency: "USD",
  });
}

async function customerWithProfile() {
  return (await db.customer.create({
    data: {
      workspaceId: WS,
      name: "سامر",
      phone: "0791234567",
      address: "عمان - الدوار السابع",
      province: "عمان",
    },
  } as never)) as { id: string };
}

describe("P18 — مسودة طلب COLLECTING", () => {
  it("زبون قديم: الاتصال يُكمَّل من ملفه والمسودة تصير READY", async () => {
    await product("ماء الكمأة", "TW-500");
    const customer = await customerWithProfile();

    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: "conv-prefill-1",
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة", quantity: 2 },
      source: "TEST",
    });

    expect(r.draft.phone).toBe("0791234567");
    expect(r.draft.rawAddress).toContain("عمان");
    expect(r.draft.province).toBe("عمان");
    expect(r.draft.customerName).toBe("سامر");
    // اسم المنتج للعرض — من قاعدة البيانات.
    expect(r.draft.productName).toBe("ماء الكمأة");
    expect(r.missingFields).toEqual([]);
    expect(r.becameReady).toBe(true);
    expect(r.draft.state).toBe("READY");
  });

  it("زبون جديد بلا ملف: الهاتف والعنوان يضلوا ناقصين (لا اختراع)", async () => {
    await product("ماء الكمأة", "TW-501");
    const customer = (await db.customer.create({
      data: { workspaceId: WS, name: null, phone: null, address: null },
    } as never)) as { id: string };

    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: "conv-prefill-2",
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة", quantity: 1 },
      source: "TEST",
    });

    expect(r.draft.phone).toBeNull();
    expect(r.draft.rawAddress).toBeNull();
    expect(r.missingFields).toContain("phone");
    expect(r.missingFields).toContain("address");
    expect(r.becameReady).toBeFalsy();
    expect(r.draft.state).toBe("COLLECTING");
  });

  it("هاتف ملف غير صالح ما بينحفظ بالمسودة", async () => {
    await product("ماء الكمأة", "TW-503");
    const customer = (await db.customer.create({
      data: { workspaceId: WS, name: "زبون", phone: "123", address: null },
    } as never)) as { id: string };

    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: "conv-prefill-6",
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة", quantity: 1 },
      source: "TEST",
    });

    expect(r.draft.phone ?? null).toBeNull();
    expect(r.missingFields).toContain("phone");
  });

  it("قيمة موجودة بالمسودة ما بتنستبدل بملف العميل", async () => {
    await product("ماء الكمأة", "TW-502");
    const customer = await customerWithProfile();
    await db.customer.update({ where: { id: customer.id }, data: { phone: "0799999999" } } as never);
    const draft = (await db.orderDraft.create({
      data: { workspaceId: WS, conversationId: "conv-prefill-3", customerId: customer.id, state: "COLLECTING", phone: "0788888888" },
    } as never)) as { id: string };

    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: "conv-prefill-3",
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة", quantity: 1 },
      source: "TEST",
    });

    expect(r.draft.id).toBe(draft.id);
    expect(r.draft.phone).toBe("0788888888");
  });

  it("معرّف منتج من مساحة أخرى ما بينقبل بالمسودة", async () => {
    const foreign = await product("منتج مساحة تانية", "FOR-1", OTHER);
    const customer = await customerWithProfile();

    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: "conv-prefill-4",
      customerId: customer.id,
      extraction: { productId: foreign.id, quantity: 1 },
      source: "TEST",
    });

    expect(r.draft.productId ?? null).toBeNull();
    expect(r.draft.productName ?? null).toBeNull();
    expect(r.missingFields).toContain("product");
  });

  it("معرّف منتج داخل كتالوج الصفحة بينقبل وبينحفظ اسمه", async () => {
    const inside = await product("عسل الكمأة", "HON-1");
    const customer = await customerWithProfile();

    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: "conv-prefill-5",
      customerId: customer.id,
      extraction: { productId: inside.id, quantity: 3 },
      allowedProductIds: [inside.id],
      source: "TEST",
    });

    expect(r.draft.productId).toBe(inside.id);
    expect(r.draft.productName).toBe("عسل الكمأة");
    expect(r.draft.quantity).toBe(3);
  });
});
