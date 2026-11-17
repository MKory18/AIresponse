import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_GROUPS } from "@/lib/nav-model";
import { decidePageAccess, firstAllowedPage, PATH_HEADER } from "@/modules/auth/page-guard";
import { effectivePermissions, type Permission } from "@/modules/rbac/permissions";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const canFor = (role: string, extras: string[] = []) => {
  const set = effectivePermissions(role, extras);
  return (p: Permission) => set.has(p);
};

/**
 * 2.2 — حارس الصفحات من الخادم: فتح رابط صفحة ممنوعة مباشرة ما بيعرضها، بيرجّع لأول صفحة مسموحة.
 */
describe("decidePageAccess", () => {
  it("المالك بيدخل كل صفحات القائمة", () => {
    const can = canFor("OWNER");
    for (const g of NAV_GROUPS) for (const p of g.pages) expect(decidePageAccess(p.href, can).kind).toBe("allow");
  });

  it("الصفحة الممنوعة بترجّع لأول صفحة مسموحة مع ?denied=1", () => {
    const can = canFor("SALES_AGENT");
    const d = decidePageAccess("/settings/team", can);
    expect(d.kind).toBe("redirect");
    if (d.kind === "redirect") {
      expect(d.to.endsWith("?denied=1")).toBe(true);
      const target = d.to.split("?")[0]!;
      // وجهة التحويل نفسها لازم تكون مسموحة — وإلا حلقة تحويل.
      expect(decidePageAccess(target, can).kind).toBe("allow");
    }
  });

  it("الصفحات الفرعية بتتبع صفحتها (/orders/abc ← الطلبات)", () => {
    const noOrders = (p: Permission) => p !== "orders.read" && canFor("OWNER")(p);
    expect(decidePageAccess("/orders/abc123", noOrders).kind).toBe("redirect");
    expect(decidePageAccess("/orders/abc123", canFor("OWNER")).kind).toBe("allow");
  });

  it("الرابط المدموج بيتبع صلاحية مكانه الجديد", () => {
    const noAnalytics = (p: Permission) => p !== "analytics.read" && canFor("OWNER")(p);
    expect(decidePageAccess("/analytics/products", noAnalytics).kind).toBe("redirect");
  });

  it("مسار مجهول للقائمة ما بيتحجب (الـAPI بيحكم)", () => {
    expect(decidePageAccess("/some/unknown/path", () => false)).toEqual({ kind: "allow" });
  });

  it("«حسابي» مفتوحة لكل عضو، وبلا أي صلاحية بيرجع لها", () => {
    const none = () => false;
    expect(decidePageAccess("/settings/account", none).kind).toBe("allow");
    expect(firstAllowedPage(none)).toBe("/settings/account");
    const d = decidePageAccess("/orders", none);
    expect(d).toEqual({ kind: "redirect", to: "/settings/account?denied=1" });
  });

  it("إضافة عضو بتفتح له الصفحة (استثناء فوق الدور)", () => {
    expect(decidePageAccess("/settings/team", canFor("SALES_AGENT")).kind).toBe("redirect");
    expect(decidePageAccess("/settings/team", canFor("SALES_AGENT", ["users.manage"])).kind).toBe("allow");
  });
});

describe("ربط الحارس بالـlayout والـmiddleware", () => {
  it("الـmiddleware بيحط نفس الهيدر وبيستثني الـAPI والملفات الثابتة", () => {
    const mw = read("src/middleware.ts");
    expect(mw).toContain(`"${PATH_HEADER}"`);
    expect(mw).toMatch(/matcher/);
    expect(mw).toContain("api/");
    expect(mw).toContain("_next/");
  });

  it("الـlayout بيستعمل decidePageAccess وشاشة «حسابك مش مفعّل» — لا قائمة كاملة عند فشل الصلاحيات", () => {
    const layout = read("src/app/(dashboard)/layout.tsx");
    expect(layout).toContain("decidePageAccess");
    expect(layout).toContain("InactiveWorkspace");
    expect(layout).not.toMatch(/visibleGroups\([^)]*\(\)\s*=>\s*true/);
  });
});
