/**
 * 3.1ب — تعديل بيانات العميل من لوحة المحادثة: بيبعت الحقول اللي تغيّرت بس (الفاضي = مسح)،
 * والبطاقة مخفية لمن ما عنده `customers.write`، والمسار نفسه (PATCH) حارس بالصلاحية والتدقيق.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { changedFields } from "@/app/(dashboard)/conversations/v2/customer-edit-card";
import { updateCustomerSchema } from "@/modules/conversations/schemas";

const base = { name: "سامر", phone: "0791234567", province: "عمان", city: "", address: "الدوار السابع", notes: "" };

describe("changedFields", () => {
  it("ما تغيّر شي = ولا حقل", () => {
    expect(changedFields(base, { ...base })).toEqual({});
    expect(changedFields(base, { ...base, name: "  سامر  " })).toEqual({});
  });
  it("الحقول المتغيّرة بس، والفاضي بيصير null (مسح)", () => {
    expect(changedFields(base, { ...base, phone: "0799999999", address: "" })).toEqual({ phone: "0799999999", address: null });
    expect(changedFields(base, { ...base, city: " إربد " })).toEqual({ city: "إربد" });
  });
  it("الناتج دايمًا مقبول من schema الخادم (أسماء حقول صحيحة)", () => {
    const patch = changedFields(base, { name: "ليلى", phone: "0944000111", province: "دمشق", city: "المزة", address: "x1y", notes: "ملاحظة" });
    expect(updateCustomerSchema.safeParse(patch).success).toBe(true);
  });
});

describe("البطاقة والمسار", () => {
  it("البطاقة بترجع null بدون canWrite، والمسار PATCH بصلاحية customers.write", () => {
    const card = readFileSync("src/app/(dashboard)/conversations/v2/customer-edit-card.tsx", "utf8");
    expect(card).toMatch(/if \(!c\.canWrite\) return null/);
    const route = readFileSync("src/app/api/customers/[id]/route.ts", "utf8");
    expect(route).toMatch(/PATCH[\s\S]*permission: "customers\.write"/);
  });
});
