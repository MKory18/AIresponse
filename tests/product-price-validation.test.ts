import { describe, expect, it } from "vitest";
import { productInputSchema, productUpdateSchema } from "@/modules/products/schemas";

const base = { name: "منتج", sku: "S1" };

describe("تحقق سعر المنتج", () => {
  it.each([["abc"], ["-5"], [-5], ["12345678901"], [""], ["1e5"], ["1,5"]])("يرفض السعر %s", (price) => {
    expect(productInputSchema.safeParse({ ...base, price }).success).toBe(false);
  });
  it.each([[100], ["100"], ["99.99"], [0], ["0.5"]])("يقبل السعر %s", (price) => {
    expect(productInputSchema.safeParse({ ...base, price }).success).toBe(true);
  });
  it("compareAtPrice نفس القاعدة", () => {
    expect(productInputSchema.safeParse({ ...base, price: 1, compareAtPrice: "-1" }).success).toBe(false);
    expect(productInputSchema.safeParse({ ...base, price: 1, compareAtPrice: null }).success).toBe(true);
  });
  it("العملة تتحوّل لأحرف كبيرة", () => {
    const r = productInputSchema.parse({ ...base, price: 1, currency: "usd" });
    expect(r.currency).toBe("USD");
  });
  it("التحديث الجزئي يرفض سعراً سالباً", () => {
    expect(productUpdateSchema.safeParse({ price: -1 }).success).toBe(false);
  });
});
