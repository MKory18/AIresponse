/**
 * تطابق السعر والعملة حرفيًا مع المنتج بالبرنامج.
 *
 * يثبت الحالة اللي صارت: منتج 10 دولار والرد قال «25 درهم» — كان يمرّ
 * لأن الفحص القديم يتجاهل الأرقام ≤ 1000 ولا يعرف «درهم». هلأ:
 *  - أي عملة غير عملة المنتج = CURRENCY_MISMATCH.
 *  - أي رقم ملاصق لعملة ≠ سعر المنتج = PRICE_MISMATCH (بأي حجم).
 *  - السعر الصحيح بالعملة الصحيحة يمرّ، والكميات («3 حبات») ما بتتأثر.
 */
import { describe, expect, it } from "vitest";
import { validateResponse } from "@/modules/ai/guardrails";

function product(price = "10", currency = "USD") {
  return {
    product: {
      id: "p1",
      name: "منتج",
      sku: "SKU",
      price,
      currency,
      compareAtPrice: null,
      stockStatus: "IN_STOCK",
      shortDescription: null,
      description: null,
      benefits: [],
      usage: null,
      warnings: null,
      ingredients: null,
      objections: [],
      salesNotes: null,
      faqs: [],
      priceTiers: [],
    },
    knowledge: { faqs: [], documents: [] },
    media: [],
    feedback: [],
    memory: [],
  } as never;
}

describe("تطابق السعر والعملة", () => {
  it("10 دولار بالبرنامج + «25 درهم» بالرد = مرفوض (سعر وعملة)", () => {
    const r = validateResponse({ response: "سعره 25 درهم", context: product("10", "USD") });
    expect(r.valid).toBe(false);
    expect(r.violations).toContain("PRICE_MISMATCH");
    expect(r.violations).toContain("CURRENCY_MISMATCH");
  });

  it("السعر الصحيح بنفس العملة يمرّ", () => {
    expect(validateResponse({ response: "سعره 10 دولار", context: product() }).valid).toBe(true);
    expect(validateResponse({ response: "السعر: 10 USD فقط", context: product() }).valid).toBe(true);
  });

  it("عملة ثانية بنفس الرقم = مرفوض (تحويل العملة ممنوع)", () => {
    const r = validateResponse({ response: "سعره 10 درهم", context: product("10", "USD") });
    expect(r.violations).toContain("CURRENCY_MISMATCH");
    expect(r.violations).not.toContain("PRICE_MISMATCH");
  });

  it("ليرة سورية بفواصل: 150,000 ل.س يمرّ", () => {
    const r = validateResponse({ response: "سعره 150,000 ل.س", context: product("150000", "SYP") });
    expect(r.valid).toBe(true);
  });

  it("رقم غلط حتى لو صغير (25) = مرفوض", () => {
    const r = validateResponse({ response: "بـ 25 دولار", context: product("10", "USD") });
    expect(r.violations).toContain("PRICE_MISMATCH");
  });

  it("الكميات ما بتتأثر: «بدي 3 حبات»", () => {
    expect(validateResponse({ response: "تمام، 3 حبات", context: product("10", "USD") }).valid).toBe(true);
  });

  it("بلا منتج: أي سعر = اختراع", () => {
    const r = validateResponse({ response: "السعر 25 درهم", context: { ...product(), product: undefined } as never });
    expect(r.violations).toContain("UNSUPPORTED_PRICE");
  });
});
