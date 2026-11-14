/**
 * الزبون بيكتب الاسم بإملائه، والسعر لازم يوصله.
 *
 * ⚠️ الحالة الحقيقية: الزبون سأل عن «ماء الكماة» والمنتج مسجّل «ماء الكمأ»
 * بسعر ١٥ ومتوفر. البحث كان حرفيًا فما لاقى المنتج، والرد طلع «ما عندي
 * معلومة مؤكدة عن السعر» — والسعر موجود.
 * 🔧 التطبيع العربي + احتواء بالاتجاهين، مع رفض الملتبس.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeProductName,
  sameProductName,
  matchProductByName,
  matchProductByAnyName,
} from "@/modules/products/name-match";

const CATALOG = [
  { id: "p1", name: "ماء الكمأ" },
  { id: "p2", name: "ماء الذهب" },
  { id: "p3", name: "الصابونة العشبية" },
  { id: "p4", name: "مكواة عمودية" },
];

describe("تطبيع الاسم العربي", () => {
  it("بيوحّد الهمزة والتاء المربوطة", () => {
    expect(normalizeProductName("ماء الكمأ")).toBe("ماء الكما");
    expect(normalizeProductName("ماء الكماة")).toBe("ماء الكماه");
  });

  it("بيشيل التشكيل والتطويل", () => {
    expect(normalizeProductName("مَكـواة")).toBe(normalizeProductName("مكواه"));
  });

  it("بيوحّد الألف المقصورة", () => {
    expect(sameProductName("مصطفى", "مصطفي")).toBe(true);
  });
});

describe("مطابقة المنتج من كلام الزبون", () => {
  it("«ماء الكماة» بتلاقي «ماء الكمأ» — الحالة اللي وقّفت السعر", () => {
    expect(matchProductByName("ماء الكماة", CATALOG)?.id).toBe("p1");
  });

  it("الاسم المطابق بيلاقي نفسه", () => {
    expect(matchProductByName("ماء الكمأ", CATALOG)?.id).toBe("p1");
  });

  it("جملة كاملة فيها الاسم بتلاقيه", () => {
    expect(matchProductByName("قديش سعر ماء الكماة؟", CATALOG)?.id).toBe("p1");
  });

  it("الاسم الأطول بيفوز لما الاتنين محتوايين", () => {
    const list = [...CATALOG, { id: "p5", name: "ماء" }];
    expect(matchProductByName("بدي ماء الكماة", list)?.id).toBe("p1");
  });

  it("«ماء» لحالها ملتبسة — ما منجاوب بمنتج غلط", () => {
    expect(matchProductByName("ماء", CATALOG)).toBeNull();
  });

  it("اسم مش موجود ما بيرجّع شي", () => {
    expect(matchProductByName("ثلاجة", CATALOG)).toBeNull();
  });

  it("حرف واحد ما بيطابق", () => {
    expect(matchProductByName("م", CATALOG)).toBeNull();
  });

  it("كتالوج فاضي ما بيطابق", () => {
    expect(matchProductByName("ماء الكماة", [])).toBeNull();
  });
});

describe("مرشّحين بالترتيب", () => {
  it("أول مرشّح بيطابق هو اللي بيفوز", () => {
    expect(matchProductByAnyName(["ثلاجة", "ماء الكماة"], CATALOG)?.id).toBe("p1");
  });

  it("ولا مرشّح بيطابق", () => {
    expect(matchProductByAnyName(["ثلاجة", "غسالة"], CATALOG)).toBeNull();
  });
});
