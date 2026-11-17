import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_GROUPS, NAV_GROUPS_V2, groupLanding, navGroupsFor, pageForPath, visibleGroups } from "@/lib/nav-model";
import { NAV_ICONS } from "@/components/nav-icons";
import { PERMISSIONS, effectivePermissions } from "@/modules/rbac/permissions";
import { DEFAULT_UI_VERSION, parseUiVersion, resolveUiVersion } from "@/lib/ui-version";
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

describe("NAV_GROUPS_V2", () => {
  it("٧ مجموعات بأيقونات فريدة وموجودة", () => {
    expect(NAV_GROUPS_V2).toHaveLength(7);
    const icons = NAV_GROUPS_V2.map((g) => g.icon);
    expect(new Set(icons).size).toBe(7);
    for (const i of icons) expect(NAV_ICONS[i], i).toBeTruthy();
    expect(new Set(NAV_GROUPS_V2.map((g) => g.key)).size).toBe(7);
  });

  it("كل صفحة إلها ملف page.tsx وصلاحية صالحة، ولا رابط مكرّر", () => {
    const seen = new Set<string>();
    for (const g of NAV_GROUPS_V2)
      for (const p of g.pages) {
        expect(seen.has(p.href), `مكرّر ${p.href}`).toBe(false);
        seen.add(p.href);
        expect(existsSync(pageFile(p.href)), `صفحة ناقصة: ${p.href}`).toBe(true);
        if (p.permission) expect(PERMISSIONS as readonly string[]).toContain(p.permission);
      }
  });

  it("ولا صفحة بتضيع من الواجهة الجديدة (ما منلغي الميزة قبل بديلها)", () => {
    const v2 = new Set(NAV_GROUPS_V2.flatMap((g) => g.pages.map((p) => p.href)));
    for (const g of NAV_GROUPS) for (const p of g.pages) expect(v2.has(p.href), `ضاعت: ${p.href}`).toBe(true);
  });

  it("نفس صلاحية كل صفحة بالنسختين (الهيكل ما بيغيّر مين بيشوف شو)", () => {
    const v1 = new Map(NAV_GROUPS.flatMap((g) => g.pages.map((p) => [p.href, p.permission] as const)));
    for (const g of NAV_GROUPS_V2) for (const p of g.pages) expect(p.permission, p.href).toBe(v1.get(p.href));
  });

  it("navGroupsFor بيختار حسب النسخة", () => {
    expect(navGroupsFor("v1")).toBe(NAV_GROUPS);
    expect(navGroupsFor("v2")).toBe(NAV_GROUPS_V2);
  });

  it("حارس الصفحات بيشتغل على v2 (موظف مبيعات ما بيدخل الفريق)", () => {
    const set = effectivePermissions("SALES_AGENT", []);
    const can = (p: never) => set.has(p);
    const d = decidePageAccess("/settings/team", can, NAV_GROUPS_V2);
    expect(d.kind).toBe("redirect");
    expect(decidePageAccess("/orders/abc", can, NAV_GROUPS_V2).kind).toBe("allow");
  });
});

describe("مفتاح الواجهة uiVersion", () => {
  it("الافتراضي v1، والكوكي بيغلب الإعداد، وقيم تالفة بتتجاهل", () => {
    expect(DEFAULT_UI_VERSION).toBe("v1");
    expect(resolveUiVersion({})).toBe("v1");
    expect(resolveUiVersion({ setting: "v2" })).toBe("v2");
    expect(resolveUiVersion({ cookie: "v1", setting: "v2" })).toBe("v1");
    expect(resolveUiVersion({ cookie: "v2", setting: "v1" })).toBe("v2");
    expect(resolveUiVersion({ cookie: "garbage", setting: "v2" })).toBe("v2");
    expect(resolveUiVersion({ cookie: 5, setting: {} })).toBe("v1");
    expect(parseUiVersion("v3")).toBeNull();
  });

  it("إعداد المساحة: افتراضي v1، وقيمة تالفة بتسقط للافتراضي", () => {
    expect(DEFAULT_INTEGRATION_SETTINGS.uiVersion).toBe("v1");
    expect(resolveIntegrationSettings({ uiVersion: "v2" }).uiVersion).toBe("v2");
    expect(resolveIntegrationSettings({ uiVersion: "v9" }).uiVersion).toBe("v1");
  });

  it("الـlayout بيختار الهيكل والحارس والقشرة من نفس النسخة", () => {
    const l = read("src/app/(dashboard)/layout.tsx");
    expect(l).toContain("resolveUiVersion");
    expect(l).toContain("navGroupsFor(uiVersion)");
    expect(l).toContain("decidePageAccess(pathname, auth.can, navGroups)");
    expect(l).toContain("AppShellV2");
  });

  it("تفعيلها للفريق للمالك بس (والمعاينة بالكوكي لأي عضو)", () => {
    const r = read("src/app/api/settings/ui-version/route.ts");
    expect(r).toContain("isOwnerRole");
    expect(r).toContain('permission: "settings.manage"');
    expect(r).toContain("rateLimit");
    expect(read("src/components/settings/ui-version-card.tsx")).toContain("document.cookie");
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
    expect(countsByGroup(items, NAV_GROUPS_V2)).toEqual({ chats: 2, orders: 1, settings: 2 });
  });
});

describe("SidebarV2 / BottomBar", () => {
  const all = visibleGroups(NAV_GROUPS_V2, () => true);
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
    const limited = visibleGroups(NAV_GROUPS_V2, (p) => p === "orders.read");
    const out = renderToStaticMarkup(createElement(BottomBar, { groups: limited, activeGroupKey: "orders", counts: {}, onMore: () => {} }));
    expect(out).toContain('href="/orders"');
    expect(out).not.toContain('href="/dashboard"');
  });
});

describe("نقاط عامة", () => {
  it("pageForPath يفهم صفحات v2 الفرعية", () => {
    expect(pageForPath("/orders/abc", NAV_GROUPS_V2)?.group.key).toBe("orders");
    expect(pageForPath("/settings/ai", NAV_GROUPS_V2)?.group.key).toBe("agent");
  });
});
