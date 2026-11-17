import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_GROUPS, groupLanding, pageForPath, visibleGroups } from "@/lib/nav-model";
import { NAV_ICONS } from "@/components/nav-icons";
import { PERMISSIONS, effectivePermissions } from "@/modules/rbac/permissions";
import { countsByGroup } from "@/lib/attention-counts";
import { decidePageAccess } from "@/modules/auth/page-guard";
import { DEFAULT_INTEGRATION_SETTINGS, resolveIntegrationSettings } from "@/modules/integrations/settings";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { SidebarV2 } from "@/components/shell-v2/sidebar-v2";
import { BottomBar } from "@/components/shell-v2/bottom-bar";

/** 2.3ب — الهيكل الجديد: خريطة تنقل v2 · مفتاح الواجهة · قشرة بعدّادات · شريط سفلي للجوال. */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const pageFile = (href: string) => join(process.cwd(), "src", "app", "(dashboard)", ...href.split("/").filter(Boolean), "page.tsx");

describe("NAV_GROUPS", () => {
  it("٧ مجموعات بأيقونات فريدة وموجودة", () => {
    expect(NAV_GROUPS).toHaveLength(7);
    const icons = NAV_GROUPS.map((g) => g.icon);
    expect(new Set(icons).size).toBe(7);
    for (const i of icons) expect(NAV_ICONS[i], i).toBeTruthy();
    expect(new Set(NAV_GROUPS.map((g) => g.key)).size).toBe(7);
  });

  it("كل صفحة إلها ملف page.tsx وصلاحية صالحة، ولا رابط مكرّر", () => {
    const seen = new Set<string>();
    for (const g of NAV_GROUPS)
      for (const p of g.pages) {
        expect(seen.has(p.href), `مكرّر ${p.href}`).toBe(false);
        seen.add(p.href);
        expect(existsSync(pageFile(p.href)), `صفحة ناقصة: ${p.href}`).toBe(true);
        if (p.permission) expect(PERMISSIONS as readonly string[]).toContain(p.permission);
      }
  });

  it("حارس الصفحات بيشتغل على v2 (موظف مبيعات ما بيدخل الفريق)", () => {
    const set = effectivePermissions("SALES_AGENT", []);
    const can = (p: never) => set.has(p);
    const d = decidePageAccess("/settings/team", can, NAV_GROUPS);
    expect(d.kind).toBe("redirect");
    expect(decidePageAccess("/orders/abc", can, NAV_GROUPS).kind).toBe("allow");
  });
});

describe("بعد حذف الواجهة القديمة (3.8)", () => {
  it("ما في مفتاح واجهة: ولا ملف ولا إعداد ولا مسار", () => {
    expect(existsSync(join(process.cwd(), "src/lib/ui-version.ts"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/app/api/settings/ui-version/route.ts"))).toBe(false);
    expect(Object.keys(DEFAULT_INTEGRATION_SETTINGS)).not.toContain("uiVersion");
    // قيمة قديمة محفوظة بالمساحة بتنتجاهل بصمت (ما بتكسر القراءة).
    expect(Object.keys(resolveIntegrationSettings({ uiVersion: "v2" }))).not.toContain("uiVersion");
  });

  it("الـlayout بيستعمل القشرة الجديدة والهيكل الوحيد والحارس", () => {
    const l = read("src/app/(dashboard)/layout.tsx");
    expect(l).not.toContain("resolveUiVersion");
    expect(l).not.toContain("navGroupsFor");
    expect(l).toContain("decidePageAccess(pathname, auth.can, NAV_GROUPS)");
    expect(l).toContain("AppShellV2");
    expect(l).not.toContain("<AppShell ");
  });

  it("القشرة والوارد والصفحات القديمة انحذفت", () => {
    for (const f of [
      "src/components/app-shell.tsx",
      "src/components/app-sidebar.tsx",
      "src/components/inbox/inbox.tsx",
      "src/app/(dashboard)/dashboard/legacy-dashboard.tsx",
      "src/app/(dashboard)/orders/legacy-orders.tsx",
      "src/app/(dashboard)/analytics/legacy-analytics.tsx",
    ])
      expect(existsSync(join(process.cwd(), f)), f).toBe(false);
  });
});

describe("countsByGroup", () => {
  const items = [
    { href: "/conversations?id=c1", severity: "high" },
    { href: "/conversations?id=c2", severity: "medium" },
    { href: "/orders?order=o1", severity: "high" },
    { href: "/settings/integrations", severity: "critical" }, // صفحة لسا مش بالقائمة (3.6) ← الإعدادات
    { href: "/channels", severity: "critical" },
    { href: "/unknown/page", severity: "low" },
  ];
  it("كل بند على مجموعة صفحته", () => {
    expect(countsByGroup(items, NAV_GROUPS)).toEqual({ chats: 2, orders: 1, settings: 2 });
  });
});

describe("SidebarV2 / BottomBar", () => {
  const all = visibleGroups(NAV_GROUPS, () => true);
  const sidebar = (props: Partial<Parameters<typeof SidebarV2>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(SidebarV2, { groups: all, activeGroupKey: "orders", counts: { chats: 3, orders: 120 }, workspaceName: "متجري", open: false, onClose: () => {}, ...props })
    );

  it("كل مجموعة رابط لأول صفحة مسموحة، والنشطة aria-current", () => {
    const out = sidebar();
    for (const g of all) expect(out).toContain(`href="${groupLanding(g)}"`);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toContain('data-nav-group="orders"');
  });

  it("العدّادات (وفوق 99 = 99+) واسم المتجر والقائمة الرئيسية معنونة", () => {
    const out = sidebar();
    expect(out).toContain(">3<");
    expect(out).toContain("99+");
    expect(out).toContain("متجري");
    expect(out).toContain('aria-label="القائمة الرئيسية"');
  });

  it("الإعدادات تحت الفاصل، والدرج بالجوال بس لما open", () => {
    expect(sidebar({ open: false })).not.toContain('role="dialog"');
    expect(sidebar({ open: true })).toContain('role="dialog"');
  });

  it("الشريط السفلي: اليوم · المحادثات · الطلبات · المزيد، وبس بالجوال", () => {
    const out = renderToStaticMarkup(createElement(BottomBar, { groups: all, activeGroupKey: "chats", counts: { chats: 2 }, onMore: () => {} }));
    expect(out).toContain("md:hidden");
    expect(out).toContain('href="/dashboard"');
    expect(out).toContain('href="/conversations"');
    expect(out).toContain('href="/orders"');
    expect(out).toContain("المزيد");
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("قائمة مقيّدة بالصلاحيات: الشريط السفلي بس باللي مسموح", () => {
    const limited = visibleGroups(NAV_GROUPS, (p) => p === "orders.read");
    const out = renderToStaticMarkup(createElement(BottomBar, { groups: limited, activeGroupKey: "orders", counts: {}, onMore: () => {} }));
    expect(out).toContain('href="/orders"');
    expect(out).not.toContain('href="/dashboard"');
  });
});

describe("نقاط عامة", () => {
  it("pageForPath يفهم صفحات v2 الفرعية", () => {
    expect(pageForPath("/orders/abc", NAV_GROUPS)?.group.key).toBe("orders");
    expect(pageForPath("/settings/ai", NAV_GROUPS)?.group.key).toBe("agent");
  });
});

describe("بنود «يحتاجك» بتودّي لصفحات موجودة (ولا رابط ميت)", () => {
  it("كل href بخدمة «يحتاجك» إلو صفحة فعلية", () => {
    const src = read("src/modules/attention/service.ts");
    const hrefs = [...src.matchAll(/href: [`"](\/[a-z][a-z/-]*)/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(5);
    for (const h of new Set(hrefs)) expect(existsSync(pageFile(h)), `رابط ميت بـ«يحتاجك»: ${h}`).toBe(true);
  });
});
