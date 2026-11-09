import { describe, expect, it } from "vitest";
import { redactProductForActor } from "@/modules/products/service";
import { hasPermission } from "@/modules/rbac/permissions";

const product = { id: "p1", name: "منتج", price: "100", wholesalePrice: "60", discountCap: "10", salesNotes: "x" };
const actorFor = (role: string) => ({ can: (p: "products.wholesale") => hasPermission(role, [], p) });

describe("إخفاء سعر الجملة وسقف الخصم من الـ API", () => {
  for (const role of ["SALES_AGENT", "SUPPORT_AGENT", "VIEWER"]) {
    it(`${role} ما بيشوف wholesalePrice ولا discountCap`, () => {
      const out = redactProductForActor(product, actorFor(role)) as Record<string, unknown>;
      expect(out).not.toHaveProperty("wholesalePrice");
      expect(out).not.toHaveProperty("discountCap");
      expect(out.price).toBe("100");
      expect(out.name).toBe("منتج");
    });
  }

  it("المدير (products.wholesale) بيشوفهم", () => {
    const out = redactProductForActor(product, actorFor("MANAGER")) as Record<string, unknown>;
    expect(out.wholesalePrice).toBe("60");
    expect(out.discountCap).toBe("10");
  });

  it("ما بيعدّل الكائن الأصلي", () => {
    redactProductForActor(product, actorFor("VIEWER"));
    expect(product.wholesalePrice).toBe("60");
  });
});
