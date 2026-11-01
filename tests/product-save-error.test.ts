import { describe, expect, it } from "vitest";
import { productSaveError } from "@/lib/product-save-error";

describe("P18 — رسالة فشل حفظ المنتج", () => {
  it("403: تفسير صلاحية واضح", () => {
    const msg = productSaveError(403, { error: "FORBIDDEN" });
    expect(msg).toContain("صلاحية");
    expect(msg).toContain("كتالوج المنتجات");
  });

  it("422: يسمّي الحقل والسطر بالعربي", () => {
    const msg = productSaveError(422, {
      error: "VALIDATION_ERROR",
      details: [{ path: "benefits.0", message: "String must contain at most 300 character(s)" }],
    });
    expect(msg).toContain("الفوائد");
    expect(msg).toContain("السطر 1");
    expect(msg).toContain("300");
  });

  it("422 بلا تفاصيل: رسالة عامة مفهومة", () => {
    const msg = productSaveError(422, { error: "VALIDATION_ERROR" });
    expect(msg).toContain("حقل غير صالح");
  });

  it("500: خطأ خادم مع نصيحة إعادة المحاولة", () => {
    const msg = productSaveError(500, null);
    expect(msg).toContain("خطأ بالخادم");
    expect(msg).toContain("جرّب");
  });

  it("رسالة الخادم تُعرض إذا كانت موجودة", () => {
    const msg = productSaveError(400, { message: "قيمة السعر غير صالحة" });
    expect(msg).toContain("قيمة السعر غير صالحة");
  });
});
