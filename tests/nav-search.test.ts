import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_GROUPS, visibleGroups } from "@/lib/nav-model";
import { PAGE_KEYWORDS, normalizeQuery, searchPages } from "@/lib/nav-search";

/**
 * القفز السريع للصفحات من صندوق البحث: بتكتب «طلبات» أو «زبون» أو «باسورد» وبتطلع
 * الصفحة الصح — وبس الصفحات المسموحة للعضو.
 */

const all = visibleGroups(NAV_GROUPS, () => true);
const top = (q: string) => searchPages(q, all)[0]?.href;

describe("normalizeQuery", () => {
  it("بلا تشكيل ولا تطويل، وألف/ياء/تاء مربوطة موحّدة، ولاتيني صغير", () => {
    expect(normalizeQuery("أَتْمَتَة")).toBe("اتمته");
    expect(normalizeQuery("الطلبـــات")).toBe("الطلبات");
    expect(normalizeQuery("مُنتَجات")).toBe("منتجات");
    expect(normalizeQuery("على")).toBe("علي");
    expect(normalizeQuery("  Inbox   Now ")).toBe("inbox now");
  });
});

describe("searchPages", () => {
  it.each([
    ["طلبات", "/orders"],
    ["اوردر", "/orders"],
    ["زبون", "/customers"],
    ["زباين", "/customers"],
    ["بضاعة", "/products"],
    ["باسورد", "/settings/account"],
    ["أتمتة", "/automation"],
    ["اتمتة", "/automation"],
    ["شات", "/conversations"],
    ["الوارد", "/conversations"],
    ["تقارير", "/analytics"],
    ["فيسبوك", "/channels"],
    ["موظفين", "/settings/team"],
    ["inbox", "/conversations"],
    ["ضبط الذكاء", "/settings/ai"],
  ])("«%s» ← %s أول نتيجة", (q, href) => {
    expect(top(q)).toBe(href);
  });

  it("استعلام فاضي أو مسافات ← ولا نتيجة، والحد الأقصى ٦ (أو الي بتحدّده)", () => {
    expect(searchPages("", all)).toEqual([]);
    expect(searchPages("   ", all)).toEqual([]);
    expect(searchPages("ا", all).length).toBeLessThanOrEqual(6);
    expect(searchPages("ا", all, 2).length).toBeLessThanOrEqual(2);
  });

  it("كل الكلمات لازم تطابق (AND) — كلمة ما إلها وجود ← ولا نتيجة", () => {
    expect(searchPages("طلبات قمر", all)).toEqual([]);
  });

  it("⚠️ بس الصفحات المسموحة: العضو بلا صلاحية الطلبات ما بتطلعله صفحة الطلبات", () => {
    const limited = visibleGroups(NAV_GROUPS, (p) => p === "conversations.read");
    expect(searchPages("طلبات", limited).map((h) => h.href)).not.toContain("/orders");
    expect(searchPages("الوارد", limited).map((h) => h.href)).toContain("/conversations");
    // «حسابي» متاحة لكل عضو مسجّل
    expect(searchPages("باسورد", limited)[0]?.href).toBe("/settings/account");
  });

  it("النتيجة فيها اسم المجموعة (للتمييز بين صفحتين متشابهتين)", () => {
    const hit = searchPages("المنتجات", all).find((h) => h.href === "/products");
    expect(hit?.groupLabel).toBe("المبيعات");
  });

  it("كلمات الصفحات المدموجة بتلاقي مكانها الجديد", () => {
    expect(searchPages("استوديو", all)[0]?.href).toBe("/settings/ai");
    expect(searchPages("سير عمل", all)[0]?.href).toBe("/automation");
    expect(searchPages("تكلفة", all)[0]?.href).toBe("/analytics");
  });
});

describe("كلمات الصفحات البديلة", () => {
  it("كل صفحة بالقائمة إلها كلمات (وإلا ما بتنلاقى)، ولا كلمات لصفحة مش موجودة", () => {
    const hrefs = NAV_GROUPS.flatMap((g) => g.pages.map((p) => p.href));
    for (const h of hrefs) expect(PAGE_KEYWORDS[h], `${h} بلا كلمات`).toBeTruthy();
    for (const k of Object.keys(PAGE_KEYWORDS)) expect(hrefs, `${k} مش بالقائمة`).toContain(k);
  });
});

describe("صندوق البحث بالشريط العلوي", () => {
  const shell = readFileSync(join(process.cwd(), "src", "components", "app-shell.tsx"), "utf8");

  it("combobox بأسهم وEnter وEscape واختصار «/» وCtrl+K، وبحث المحادثات بيضل", () => {
    expect(shell).toContain("searchPages(");
    for (const s of ['role="combobox"', "aria-activedescendant", 'role="listbox"', "ArrowDown", "Escape", 'e.key === "/"', '"k"']) {
      expect(shell, s).toContain(s);
    }
    expect(shell).toContain("/conversations?q=");
  });
});
