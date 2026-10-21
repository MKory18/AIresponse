import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES, ROLE_BLURB, ROLE_OPTIONS, RoleBlurbs, RoleMatrix } from "@/components/role-matrix";
import { ROLE_PERMISSIONS, hasPermission, isPermission } from "@/modules/rbac/permissions";

/**
 * جدول «شو بيقدر كل دور؟» بصفحة الفريق: الأدوار بالمنتقي = أدوار الـschema، كل صف
 * بصلاحية حقيقية، والنبذ الي بتشرح الأدوار صحيحة فعلًا (ما بتحكي شي المصفوفة بتنفيه).
 * الخلايا محسوبة من `hasPermission` — فالاختبار بيفحص الادّعاءات مش النسخ.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const schemaRoles = (): string[] => {
  const m = /enum UserRole [{]([^}]*)[}]/.exec(read("prisma/schema.prisma"));
  return m![1]!.split(/\s+/).filter(Boolean);
};
const can = (role: string, perm: string) => hasPermission(role, [], perm as never);
const html = () => renderToStaticMarkup(createElement(RoleMatrix));

describe("الأدوار", () => {
  it("كل دور بالـschema (غير SUPER_ADMIN الداخلي) بالمنتقي، وكل دور بالمنتقي بالـschema", () => {
    const expected = schemaRoles().filter((r) => r !== "SUPER_ADMIN").sort();
    expect(ROLE_OPTIONS.map((r) => r.value).sort()).toEqual(expected);
  });

  it("لكل دور مصفوفة صلاحيات ونبذة بتبدأ باسمه", () => {
    for (const r of ROLE_OPTIONS) {
      expect(ROLE_PERMISSIONS[r.value], r.value).toBeDefined();
      expect(ROLE_BLURB[r.value], r.value).toBeTruthy();
      expect(ROLE_BLURB[r.value]!.startsWith(r.label), r.value).toBe(true);
    }
  });
});

describe("الصفوف", () => {
  it("كل صف بصلاحية صحيحة، وبلا تكرار (صلاحية ولا اسم)", () => {
    for (const c of CAPABILITIES) expect(isPermission(c.perm), c.perm).toBe(true);
    expect(new Set(CAPABILITIES.map((c) => c.perm)).size).toBe(CAPABILITIES.length);
    expect(new Set(CAPABILITIES.map((c) => c.label)).size).toBe(CAPABILITIES.length);
  });

  it("المالك والمدير العام: كل الصفوف", () => {
    for (const c of CAPABILITIES) {
      expect(can("OWNER", c.perm), c.perm).toBe(true);
      expect(can("ADMIN", c.perm), c.perm).toBe(true);
    }
    expect(new Set(ROLE_PERMISSIONS.ADMIN)).toEqual(new Set(ROLE_PERMISSIONS.OWNER));
  });
});

describe("النبذ صحيحة فعلًا", () => {
  it("مشرف: يعتمد الخصم والحملات، وما بيدير الفريق ولا مساحة العمل", () => {
    expect(can("MANAGER", "orders.discount.approve")).toBe(true);
    expect(can("MANAGER", "campaigns.approve")).toBe(true);
    expect(can("MANAGER", "users.manage")).toBe(false);
    expect(can("MANAGER", "workspace.manage")).toBe(false);
  });

  it("موظف مبيعات: يرد ويعدّل العملاء ويكتب الطلبات ويستلم التحويلات", () => {
    for (const p of ["conversations.reply", "customers.write", "orders.write", "handoffs.claim"]) {
      expect(can("SALES_AGENT", p), p).toBe(true);
    }
    expect(can("SALES_AGENT", "orders.discount.approve")).toBe(false);
    expect(can("SALES_AGENT", "products.wholesale")).toBe(false);
  });

  it("موظف دعم: يرد ويعدّل العملاء ويشوف الطلبات بدون كتابة", () => {
    expect(can("SUPPORT_AGENT", "conversations.reply")).toBe(true);
    expect(can("SUPPORT_AGENT", "customers.write")).toBe(true);
    expect(can("SUPPORT_AGENT", "orders.read")).toBe(true);
    expect(can("SUPPORT_AGENT", "orders.write")).toBe(false);
    // ⚠️ قرار مفتوح مع المالك: موظف الدعم ما بيستلم التحويلات اليوم. لو تغيّر، عدّل هالسطر والجدول بيلحق لحاله.
    expect(can("SUPPORT_AGENT", "handoffs.claim")).toBe(false);
  });

  it("مشاهد: قراءة بس", () => {
    for (const p of ROLE_PERMISSIONS.VIEWER!) expect(p.endsWith(".read"), p).toBe(true);
    expect(can("VIEWER", "conversations.reply")).toBe(false);
  });
});

describe("الجدول (العرض)", () => {
  it("خلية لكل (صف × دور)، وعدد «يقدر» = اللي المصفوفة بتعطيه فعلًا", () => {
    const out = html();
    const yes = (out.match(/data-can="yes"/g) ?? []).length;
    const no = (out.match(/data-can="no"/g) ?? []).length;
    const expectedYes = CAPABILITIES.reduce(
      (n, c) => n + ROLE_OPTIONS.filter((r) => ROLE_PERMISSIONS[r.value]!.includes(c.perm)).length,
      0
    );
    expect(yes).toBe(expectedYes);
    expect(yes + no).toBe(CAPABILITIES.length * ROLE_OPTIONS.length);
  });

  it("ترويسات صحيحة: عمود لكل دور + صف لكل قدرة + وصف للقارئ الصوتي", () => {
    const out = html();
    expect((out.match(/scope="col"/g) ?? []).length).toBe(1 + ROLE_OPTIONS.length);
    expect((out.match(/scope="row"/g) ?? []).length).toBe(CAPABILITIES.length);
    expect(out).toContain("<caption");
    for (const r of ROLE_OPTIONS) expect(out).toContain(r.label);
    for (const c of CAPABILITIES) expect(out).toContain(c.label);
  });

  it("الخلية بنص للقارئ الصوتي (مش أيقونة بس)", () => {
    const out = html();
    expect(out).toContain(">يقدر<");
    expect(out).toContain(">لا يقدر<");
  });

  it("الجدول بحاوية تتمرّر جانبيًا (الجوال) والعمود الأول ثابت", () => {
    const out = html();
    expect(out).toContain("overflow-x-auto");
    expect(out).toContain("sticky");
  });

  it("النبذ بتنعرض لكل الأدوار", () => {
    const out = renderToStaticMarkup(createElement(RoleBlurbs));
    for (const r of ROLE_OPTIONS) expect(out).toContain(r.label);
    expect((out.match(/<li/g) ?? []).length).toBe(ROLE_OPTIONS.length);
  });
});

describe("بصفحة الفريق", () => {
  const team = read("src/app/(dashboard)/settings/team/team-view.tsx");

  it("الجدول والنبذ موصولين، والقائمة محلية ما رجعت", () => {
    expect(team).toContain("<RoleMatrix");
    expect(team).toContain("<RoleBlurbs");
    expect(team).toContain("ROLE_OPTIONS as ROLES");
    expect(team).not.toMatch(/const ROLES\s*[:=]/);
  });

  it("نموذج الدعوة: منتقي الدور مضبوط وتحته سطر شرح بيتبدّل", () => {
    expect(team).toContain("hint={ROLE_BLURB[inviteRole]}");
    expect(team).toContain("value={inviteRole}");
    expect(team).toContain('name="role"');
  });
});
