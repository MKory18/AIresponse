/**
 * الزبون بيكتب الاسم بإملائه وبيختصره، والسعر لازم يوصله.
 *
 * ⚠️ الحالة الحقيقية: الزبون سأل عن «ماء الكماة» والمنتج مسجّل «ماء الكمأ»
 * بسعر ١٥ ومتوفر. البحث كان حرفيًا فما لاقى المنتج، والرد طلع «ما عندي
 * معلومة مؤكدة عن السعر» — والسعر موجود. والزبون عادة بيختصر أكتر: «كماة».
 * 🔧 تطبيع الإملاء + احتواء + مطابقة بالكلمات، مع رفض الملتبس.
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

/** أسماء من كتالوج حقيقي عند المالك. */
const REAL = [
  { id: "r1", name: "ماء الكمأ" },
  { id: "r2", name: "ماء الذهب" },
  { id: "r3", name: "مكواة عمودية" },
  { id: "r4", name: "جهاز الليزر المنزلي الألماني إصدار 2025 - متوفر الان في سوريا" },
  { id: "r5", name: "الصابونة العشبية" },
  { id: "r6", name: "بكج الزقات الصينية" },
  { id: "r7", name: "محضر الطعام" },
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

describe("اسم مختصر أو ناقص", () => {
  it("«كماة» لحالها بتلاقي ماء الكمأ", () => {
    expect(matchProductByName("كماة", REAL)?.id).toBe("r1");
  });

  it("«الكما» ناقصة بتلاقيه", () => {
    expect(matchProductByName("الكما", REAL)?.id).toBe("r1");
  });

  it("«مكوا» مقطوعة بتلاقي المكواة", () => {
    expect(matchProductByName("مكوا", REAL)?.id).toBe("r3");
  });

  it("«الليزر» بتلاقي الاسم الطويل", () => {
    expect(matchProductByName("بدي الليزر", REAL)?.id).toBe("r4");
  });

  it("«صابونه» بإملاء تاني بتلاقي الصابونة العشبية", () => {
    expect(matchProductByName("صابونه", REAL)?.id).toBe("r5");
  });

  it("«محضر طعام» بلا «ال» بتلاقيه", () => {
    expect(matchProductByName("محضر طعام", REAL)?.id).toBe("r7");
  });

  it("غلطة حرف وحدة بتنقبل", () => {
    expect(matchProductByName("مكوايه", REAL)?.id).toBe("r3");
  });

  it("جملة كاملة مع اختصار", () => {
    expect(matchProductByName("مرحبا قديش سعر الكماة؟", REAL)?.id).toBe("r1");
  });
});

describe("ما منخمّن منتج غلط", () => {
  it("«ماء» لحالها ملتبسة بين الكمأ والذهب", () => {
    expect(matchProductByName("ماء", REAL)).toBeNull();
  });

  it("كلمة بلا علاقة ما بترجّع شي", () => {
    expect(matchProductByName("بدي ثلاجة", REAL)).toBeNull();
  });

  it("تحية لحالها ما بترجّع منتج", () => {
    expect(matchProductByName("مرحبا كيفك", REAL)).toBeNull();
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
