/**
 * «بدي يسحب المنتجات بعروضها والمخزون والوصف وكل شيء».
 *
 * الباب الحالي بيعطي: الاسم · السعر · العملة · المخزون · العروض ·
 * المكمّلات · والأسماء التانية (مع `fields=aliases`).
 *
 * ⚠️ الوصف والصنف والصورة موجودين بالـ OMS نفسه بس باب `/api/v1/products`
 * ما بيبعتهم — الطلب موثّق بـ `docs/OMS-DOOR-V1.md`.
 * 🔧 المزامنة بتقرأهم من هلأ: أول ما الباب يبعتهم بينحفظوا بلا أي تعديل.
 */
import { describe, expect, it } from "vitest";
import { mapV1Product } from "@/modules/oms/client";

const FULL = {
  code: "KM-1",
  name: "ماء الكمأ",
  price: "15",
  currency: "USD",
  stock_status: "IN_STOCK",
  offers: [{ title: "عبوتين", quantity: 2, price: "28", saving: "2", remaining_qty: null, expires_at: null }],
  complements: ["SOAP-1"],
};

describe("اللي الباب بيعطيه اليوم", () => {
  it("السعر والعملة والمخزون", () => {
    const p = mapV1Product(FULL);
    expect(p.price).toBe(15);
    expect(p.currency).toBe("USD");
    expect(p.stockStatus).toBe("IN_STOCK");
  });

  it("العروض بتوصل كاملة", () => {
    const p = mapV1Product(FULL);
    expect(p.offers).toHaveLength(1);
    expect(p.offers[0]).toMatchObject({ title: "عبوتين", quantity: 2, price: 28 });
  });

  it("المكمّلات بتوصل", () => {
    expect(mapV1Product(FULL).complements).toEqual(["SOAP-1"]);
  });

  it("الأسماء التانية بتوصل وبتتنضّف", () => {
    const p = mapV1Product({ ...FULL, aliases: ["Truffle Water", "  ", "كمأة"] });
    expect(p.aliases).toEqual(["Truffle Water", "كمأة"]);
  });

  it("بلا أسماء تانية = قائمة فاضية مش خطأ", () => {
    expect(mapV1Product(FULL).aliases).toEqual([]);
  });
});

describe("الوصف والصنف والصورة — جاهزين لما الباب يبعتهم", () => {
  it("اليوم بيرجعوا فاضيين", () => {
    const p = mapV1Product(FULL);
    expect(p.description).toBeNull();
    expect(p.category).toBeNull();
    expect(p.imageUrl).toBeNull();
  });

  it("لما يبعتهم بينقرأوا", () => {
    const p = mapV1Product({
      ...FULL,
      description: "ماء طبيعي للبشرة",
      category: "العناية",
      image: "https://cdn.example.com/kama.jpg",
    });
    expect(p.description).toBe("ماء طبيعي للبشرة");
    expect(p.category).toBe("العناية");
    expect(p.imageUrl).toBe("https://cdn.example.com/kama.jpg");
  });

  it("بيقبل التسميات البديلة للحقول", () => {
    const p = mapV1Product({ ...FULL, category_name: "العناية", image_url: "https://x/y.png" });
    expect(p.category).toBe("العناية");
    expect(p.imageUrl).toBe("https://x/y.png");
  });

  it("نص فاضي بينحسب «ما في» — ما بيمسح وصف مكتوب بإيد", () => {
    const p = mapV1Product({ ...FULL, description: "   ", category: "" });
    expect(p.description).toBeNull();
    expect(p.category).toBeNull();
  });
});
