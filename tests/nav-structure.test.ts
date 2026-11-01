import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NAV_GROUPS,
  NAV_REDIRECTS,
  groupLanding,
  pageForPath,
  visibleGroups,
} from "@/lib/nav-model";
import { NAV_ICONS } from "@/components/nav-icons";
import { PERMISSIONS, ROLE_PERMISSIONS, hasPermission } from "@/modules/rbac/permissions";

// `next/link` بيحتاج سياق الراوتر — للاختبار بنرجّعه <a> عادي.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { GroupTabs } from "@/components/group-tabs";

/**
 * هيكل التنقل.
 *
 * ⚠️ قبل: ٢٢ بند بصف واحد، ونفس الشغلة بأكتر من مكان، وأيقونات مكرّرة.
 * 🔧 هلأ: ٧ مجموعات. هالاختبارات بتحرس إن ولا صفحة بتضيع من القائمة وإن
 * ولا رابط قديم بينكسر — لأن إعادة التجميع بتغيّر شكل القائمة بس، مش المسارات.
 * الصفحة المدموجة بغيرها بتضل رابط شغّال بيحوّل لمكانها الجديد (`NAV_REDIRECTS`).
 */

/** صفحات التحويل: كل وحدة بتنادي `redirectToMerged` بمسارها. */
const REDIRECT_ROUTES = Object.keys(NAV_REDIRECTS);

/** كل `page.tsx` تحت (dashboard) كمسار — `[id]` بيصير `x`. */
function dashboardRoutes(): string[] {
  const root = join(process.cwd(), "src", "app", "(dashboard)");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "page.tsx") {
        const rel = relative(root, dir).split(sep).join("/");
        out.push("/" + rel.replace(/\[[^\]]+\]/g, "x"));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** الروابط الـ٢٢ الي كانت بالقائمة القديمة — لازم تضل كلها شغّالة. */
const OLD_NAV_HREFS = [
  "/dashboard", "/conversations", "/intelligence", "/customers", "/orders", "/products",
  "/catalogs", "/media", "/feedback", "/knowledge", "/personas", "/ai/studio",
  "/ai/playground", "/channels", "/automation", "/workflows", "/follow-ups",
  "/campaigns", "/handoffs", "/analytics", "/settings", "/settings/team",
];

describe("هيكل القائمة", () => {
  it("٧ مجموعات بمفاتيح فريدة", () => {
    expect(NAV_GROUPS).toHaveLength(7);
    expect(new Set(NAV_GROUPS.map((g) => g.key)).size).toBe(7);
  });

  it("ولا صفحة بتتكرر بأكتر من مجموعة", () => {
    const hrefs = NAV_GROUPS.flatMap((g) => g.pages.map((p) => p.href));
    expect(new Set(hrefs).size, "رابط مكرّر بين المجموعات").toBe(hrefs.length);
  });

  it("ولا صفحة ضايعة: كل صفحة بلوحة التحكم إلها مجموعة", () => {
    const orphans = dashboardRoutes().filter((r) => !pageForPath(r, NAV_GROUPS));
    expect(orphans, `صفحات بلا مجموعة: ${orphans.join(" ")}`).toEqual([]);
  });

  it("ولا رابط قديم بينكسر: الـ٢٢ رابط الأصلية كلها لسا صفحات — بالقائمة أو بتحوّل لصفحة بالقائمة", () => {
    const routes = new Set(dashboardRoutes());
    const inNav = new Set(NAV_GROUPS.flatMap((g) => g.pages.map((p) => p.href)));
    for (const href of OLD_NAV_HREFS) {
      expect(routes.has(href), `الصفحة انشالت: ${href}`).toBe(true);
      const target = NAV_REDIRECTS[href]?.split("?")[0];
      expect(inNav.has(href) || (!!target && inNav.has(target)), `الرابط ضاع: ${href}`).toBe(true);
    }
  });

  it("صفحات التحويل: ما بتظهر بالقائمة، وكل وحدة ملفها بيحوّل بمسارها", () => {
    const inNav = new Set(NAV_GROUPS.flatMap((g) => g.pages.map((p) => p.href)));
    for (const href of REDIRECT_ROUTES) {
      expect(inNav.has(href), `${href} بالقائمة وكمان بيحوّل`).toBe(false);
      const file = join(process.cwd(), "src", "app", "(dashboard)", ...href.slice(1).split("/"), "page.tsx");
      expect(readFileSync(file, "utf8"), file).toContain(`redirectToMerged("${href}")`);
    }
  });

  it("ولا تكرار: الـ٢٦ تبويب صاروا ٢١ (الصفحات الي كانت نسخة من غيرها اندمجت)", () => {
    expect(NAV_GROUPS.flatMap((g) => g.pages)).toHaveLength(21);
  });

  it("كل صفحة بالقائمة موجودة فعلًا (ولا تبويب بيودّي لـ ٤٠٤)", () => {
    const routes = new Set(dashboardRoutes());
    for (const g of NAV_GROUPS) {
      for (const p of g.pages) expect(routes.has(p.href), `تبويب بلا صفحة: ${p.href}`).toBe(true);
    }
  });

  it("كل مجموعة أيقونتها فريدة وموجودة بالسجل", () => {
    const icons = NAV_GROUPS.map((g) => g.icon);
    expect(new Set(icons).size, `أيقونات مكرّرة: ${icons.join(" ")}`).toBe(icons.length);
    for (const i of icons) expect(NAV_ICONS[i], `أيقونة ناقصة: ${i}`).toBeTruthy();
  });

  it("الصلاحيات الي بالنموذج كلها صلاحيات حقيقية", () => {
    for (const g of NAV_GROUPS) {
      for (const p of g.pages) {
        if (p.permission !== null) expect(PERMISSIONS as readonly string[], p.href).toContain(p.permission);
      }
    }
  });

  it("كل تحويل بيأشّر لصفحة موجودة بالقائمة", () => {
    for (const [from, target] of Object.entries(NAV_REDIRECTS)) {
      expect(dashboardRoutes()).toContain(from);
      expect(pageForPath(target, NAV_GROUPS), `${from} → ${target}`).not.toBeNull();
    }
  });
});

describe("مطابقة المسار بالصفحة", () => {
  const hit = (p: string) => pageForPath(p, NAV_GROUPS);

  it("/settings/ai بتتبع «التشغيل» بمجموعة الذكاء، والرابط المدموج بيتبع مكانه الجديد", () => {
    expect(hit("/settings/ai")?.page.label).toBe("التشغيل");
    expect(hit("/settings/ai")?.group.key).toBe("ai");
    expect(hit("/settings")?.page.href).toBe("/settings/account");
    expect(hit("/ai/studio")?.page.href).toBe("/settings/ai");
    expect(hit("/workflows")?.page.href).toBe("/automation");
    expect(hit("/analytics/ai")?.group.key).toBe("reports");
    expect(hit("/analytics/products")?.page.href).toBe("/analytics");
  });

  it("التحويل حرفي: /settings بتحوّل، بس /settings/team صفحة حقيقية", () => {
    expect(hit("/settings/team")?.page.href).toBe("/settings/team");
    expect(hit("/settings/account")?.page.href).toBe("/settings/account");
  });

  it("صفحات التفاصيل بتتبع صفحة القائمة", () => {
    expect(hit("/orders/abc123")?.group.key).toBe("sales");
    expect(hit("/products/p1")?.page.label).toBe("المنتجات");
    expect(hit("/catalogs/c9")?.page.label).toBe("الكتالوجات");
  });

  it("الرابط القديم /order-warehouse بيتبع مجموعة الطلبات", () => {
    expect(hit("/order-warehouse")?.page.href).toBe("/orders");
    expect(hit("/order-warehouse")?.group.key).toBe("sales");
  });

  it("بادئة مش مطابقة بتنرفض (/ordersX مش /orders)", () => {
    expect(hit("/ordersX")).toBeNull();
    expect(hit("/")).toBeNull();
    expect(hit("/nothing/here")).toBeNull();
  });

  it("الـ query والشرطة الأخيرة ما بيأثّروا", () => {
    expect(hit("/orders/?page=2")?.page.href).toBe("/orders");
    expect(hit("/conversations?q=ahmad")?.page.href).toBe("/conversations");
  });
});

describe("الصلاحيات بالقائمة", () => {
  const forRole = (role: string, extra: string[] = []) =>
    visibleGroups(NAV_GROUPS, (perm) => hasPermission(role, extra, perm));

  it("بلا صلاحية = الصفحة بتنشال، والمجموعة الفاضية بتختفي", () => {
    const groups = visibleGroups(NAV_GROUPS, (perm) => perm === "conversations.read");
    const keys = groups.map((g) => g.key);
    // الوارد + مختبر التجميع بس (صلاحيتهم conversations.read) + «حسابي» بلا صلاحية.
    expect(keys).toContain("chats");
    expect(groups.find((g) => g.key === "chats")!.pages.map((p) => p.href)).toEqual([
      "/conversations",
      "/intelligence",
    ]);
    for (const hidden of ["sales", "ai", "automation", "reports", "home"]) expect(keys).not.toContain(hidden);
  });

  it("«حسابي» ظاهرة لكل عضو حتى بلا ولا صلاحية", () => {
    const groups = visibleGroups(NAV_GROUPS, () => false);
    expect(groups.map((g) => g.key)).toEqual(["settings"]);
    expect(groups[0]!.pages.map((p) => p.href)).toEqual(["/settings/account"]);
  });

  it("كل دور بيشوف بالضبط الصفحات الي صلاحياته بتفتحها — ولا بند بيودّي لممنوع", () => {
    for (const role of Object.keys(ROLE_PERMISSIONS)) {
      for (const g of forRole(role)) {
        for (const p of g.pages) {
          const def = NAV_GROUPS.flatMap((x) => x.pages).find((x) => x.href === p.href)!;
          if (def.permission !== null) expect(hasPermission(role, [], def.permission), `${role} ← ${p.href}`).toBe(true);
        }
      }
    }
  });

  it("المجموعة بتفتح أول صفحة مسموحة (مش صفحة ممنوعة)", () => {
    const groups = visibleGroups(NAV_GROUPS, (perm) => perm === "customers.read");
    expect(groupLanding(groups.find((g) => g.key === "chats")!)).toBe("/customers");
  });

  it("الصلاحيات ما بتتسرّب للعميل (الشكل الخفيف بلا permission)", () => {
    const v = visibleGroups(NAV_GROUPS, () => true);
    expect(JSON.stringify(v)).not.toContain("permission");
  });
});

describe("شريط التبويبات", () => {
  const chats = visibleGroups(NAV_GROUPS, () => true).find((g) => g.key === "chats")!;
  const render = (activeHref: string) =>
    renderToStaticMarkup(createElement(GroupTabs, { group: chats, activeHref }));

  it("بيعرض كل صفحات المجموعة بترتيبها", () => {
    const html = render("/conversations");
    const labels = ["الوارد", "التحويلات", "العملاء", "مختبر التجميع"];
    let at = -1;
    for (const l of labels) {
      const i = html.indexOf(l, at + 1);
      expect(i, `التبويب ناقص أو بغير ترتيب: ${l}`).toBeGreaterThan(at);
      at = i;
    }
  });

  it("تبويب واحد بس هو النشط (aria-current)", () => {
    const html = render("/customers");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*>العملاء|href="\/customers"[^>]*aria-current="page"/);
  });

  it("الشريط معنون لقارئ الشاشة باسم المجموعة", () => {
    expect(render("/handoffs")).toContain('aria-label="صفحات المحادثات"');
  });
});
