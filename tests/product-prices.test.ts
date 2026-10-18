import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct, getOwnedProduct, updateProduct } from "@/modules/products/service";

/**
 * أسعار متعددة للمنتج: (تسمية + سعر) محفوظة على نفس المنتج — استبدال كامل
 * بالتحديث، قراءة في التفاصيل، وبثقت حد 10 أسعار مع تسمية وسعر إلزاميين.
 */
const WS = "ws-pricing";
const ctx = { userId: "agent-px", workspaceId: WS };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
const stores = () => (db as unknown as { _stores: Record<string, unknown[]> })._stores;

beforeEach(() => {
  db = createFakeDb();
});

async function aProduct(tiers?: { label: string; price: string }[]) {
  return (await createProduct(db, ctx, {
    name: "شاي التمر",
    sku: `TEA-${Math.random().toString(36).slice(2, 6)}`,
    price: "10",
    priceTiers: tiers,
  })) as unknown as { id: string };
}

describe("createProduct مع priceTiers", () => {
  it("ينحفظ كل تسمية بسعرها على المنتج", async () => {
    const p = await aProduct([
      { label: "سعر الجملة", price: "8" },
      { label: "سعر الموزع", price: "6.5" },
    ]);
    expect(stores().productPrice).toHaveLength(2);
    const stored = (stores().productPrice as Array<Record<string, unknown>>).filter((t) => t.productId === p.id);
    expect(
      stored.map((t) => `${t.label}:${t.price}`).sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]))
    ).toEqual(["سعر الموزع:6.5", "سعر الجملة:8"]);
  });

  it("تسمية مكررة = صف واحد (التسمية فريدة بالمنتج)", async () => {
    await aProduct([
      { label: "سعر الجملة", price: "8" },
      { label: "سعر الجملة", price: "7" },
      { label: "سعر الموزع", price: "5" },
    ]);
    expect(stores().productPrice).toHaveLength(2);
  });

  it("بلا تسمية أو بلا سعر = رفض صريح (ما في صف عشوائي)", async () => {
    await expect(aProduct([{ label: "  ", price: "5" }])).rejects.toMatchObject({ code: "INVALID_PRICE_TIER" });
    await expect(aProduct([{ label: "سعر الجملة", price: "لاحظ" }])).rejects.toMatchObject({ code: "INVALID_PRICE_TIER" });
    await expect(aProduct([{ label: "سعر الجملة", price: "-2" }])).rejects.toMatchObject({ code: "INVALID_PRICE_TIER" });
    await expect(aProduct(Array.from({ length: 11 }, (_, i) => ({ label: `س${i}`, price: "1" })))).rejects.toMatchObject({ code: "TOO_MANY_PRICE_TIERS" });
    expect(stores().productPrice).toHaveLength(0);
  });
});

describe("updateProduct — استبدال كامل بسلوك «آخر حالة مرسلة هي الحقيقة»", () => {
  it("إرسال قائمة جديدة = تغيير كامل؛ إرسال قائمة فاضية = حذف الكل؛ غياب المفتاح = ما في تغيير", async () => {
    const p = await aProduct([{ label: "سعر الجملة", price: "8" }, { label: "عرض الأربعاء", price: "7" }]);
    expect((stores().productPrice as Array<Record<string, unknown>>).filter((t) => t.productId === p.id)).toHaveLength(2);

    await updateProduct(db, ctx, p.id, { priceTiers: [{ label: "سعر الموزع", price: "5" }] });
    expect((stores().productPrice as unknown[]).filter((t) => (t as Record<string, unknown>).productId === p.id)).toHaveLength(1);

    await updateProduct(db, ctx, p.id, { priceTiers: [] });
    expect((stores().productPrice as unknown[]).filter((t) => (t as Record<string, unknown>).productId === p.id)).toHaveLength(0);

    // بدون المفتاح: ما في مساس (بانتظار انزلاق غير محسوم).
    await updateProduct(db, ctx, p.id, { name: "شاي التمر الملكي" });
    expect((stores().productPrice as unknown[]).filter((t) => (t as Record<string, unknown>).productId === p.id)).toHaveLength(0);
  });
});

describe("قراءة الأسعار مع التفاصيل", () => {
  it("getOwnedProduct يدخل priceTiers دائمًا", async () => {
    const p = await aProduct([{ label: "سعر الجملة", price: "8" }]);
    const full = (await getOwnedProduct(db, WS, p.id)) as unknown as { priceTiers: Record<string, unknown>[] };
    expect(full.priceTiers).toHaveLength(1);
    expect(full.priceTiers[0].label).toBe("سعر الجملة");
  });
});
