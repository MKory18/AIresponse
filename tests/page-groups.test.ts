/**
 * الحزمة 3.4ج — «مجموعات الصفحات»: السؤال فوق · جدول الصفحات ومجموعاتها (اختيار فوري) · إدارة المجموعات ·
 * صفحة بلا مجموعة تنبيه · الصلاحيات · قيود الكود. (بند «يحتاجك» لصفحة بلا مجموعة: tests/attention.test.ts.)
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findForbiddenTerms } from "@/lib/glossary";
import { PermissionsProvider } from "@/components/auth/permissions";
import { ToastProvider } from "@/components/ui/toast";
import type { ChannelRow } from "@/app/(dashboard)/channels/v2/model";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => createElement("a", { href, ...rest }, children as never),
}));
import { PagesTable } from "@/app/(dashboard)/catalogs/v2/pages-table";
import { GroupsTable } from "@/app/(dashboard)/catalogs/v2/groups-table";
import type { Group } from "@/app/(dashboard)/catalogs/v2/use-groups";

const read = (p: string) => readFileSync(p, "utf8");
const page = (o: Partial<ChannelRow> = {}): ChannelRow => ({
  id: "ch1", type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة أ", externalId: "1", aiPersonaId: null, sendMode: "AUTO_REPLY", market: null,
  catalog: null, hasAccount: true, tokenStatus: "VALID", connectedAt: null, lastWebhookAt: null, lastSendAt: null, ...o,
});
const group = (o: Partial<Group> = {}): Group => ({ id: "g1", name: "صحة بلس", description: null, isActive: true, products: 12, pages: 1, ...o });
const wrap = (perms: string[], child: React.ReactElement) => renderToStaticMarkup(createElement(ToastProvider, null, createElement(PermissionsProvider, { permissions: perms }, child)));

describe("جدول الصفحات ومجموعاتها", () => {
  const render = (pages: ChannelRow[], groups: Group[], perms = ["catalogs.assign"]) =>
    wrap(perms, createElement(PagesTable, { pages, groups, loading: false, onAssign: async () => null }));

  it("صفحة بلا مجموعة: تنبيه «الوكيل ما بيعرف ولا منتج»، والصفحة بمجموعتها: عدد منتجاتها", () => {
    const h = render([page(), page({ id: "ch2", displayName: "صفحة ب", catalog: { id: "g1", name: "صحة بلس", isActive: true } })], [group()]);
    expect(h).toContain("الوكيل ما بيعرف ولا منتج لهالصفحة");
    expect(h).toContain(">12<");
    expect(h).toContain("بلا مجموعة");
  });
  it("مجموعة متوقفة = شارة «متوقفة» (الصفحة بتبقى مربوطة بس الوكيل ما بيستعملها)", () => {
    const h = render([page({ catalog: { id: "g1", name: "صحة بلس", isActive: false } })], [group({ isActive: false })]);
    expect(h).toContain("متوقفة");
  });
  it("الاختيار بصلاحية catalogs.assign، ومن غيرها نص للقراءة", () => {
    expect(render([page()], [group()])).toContain("<select");
    const ro = render([page()], [group()], ["catalogs.read"]);
    expect(ro).not.toContain("<select");
  });
  it("فاضي = خطوة جاية (روح للصفحات والقنوات)", () => {
    const h = render([], []);
    expect(h).toContain("ما في صفحة مربوطة");
    expect(h).toContain('href="/channels"');
  });
});

describe("إدارة المجموعات", () => {
  const render = (groups: Group[], perms = ["catalogs.write"]) =>
    wrap(perms, createElement(GroupsTable, { groups, loading: false, onToggle: async () => null, onCreate: async () => null, onRemove: async () => null }));

  it("اسم المجموعة رابط للتفاصيل، ومعها المنتجات والصفحات ومفتاح «شغّالة»", () => {
    const h = render([group()]);
    expect(h).toContain('href="/catalogs/g1"');
    expect(h).toContain("صحة بلس");
    expect(h).toContain('role="switch"');
    expect(h).toContain("أنشئ مجموعة");
  });
  it("بلا صلاحية الكتابة: ما في أنشئ ولا مفتاح ولا قائمة", () => {
    const h = render([group()], ["catalogs.read"]);
    expect(h).not.toContain("أنشئ مجموعة");
    expect(h).not.toContain('role="switch"');
  });
  it("فاضي = زر «أنشئ مجموعة»", () => {
    expect(render([])).toContain("ما في مجموعات منتجات");
  });
});

describe("الصفحة والمسارات", () => {
  it("/catalogs بتعرض الشاشة الجديدة، والسؤال مكتوب فوق", () => {
    expect(read("src/app/(dashboard)/catalogs/page.tsx")).toContain("<CatalogsView />");
    expect(read("src/app/(dashboard)/catalogs/v2/catalogs-view.tsx")).toContain("S.question");
    expect(read("src/app/(dashboard)/catalogs/v2/strings.ts")).toContain("أي منتجات كل صفحة بتبيع؟");
  });
  it("الإسناد والفصل والحذف بنفس المسارات الموجودة، والحذف الإجباري بتأكيد صريح", () => {
    const h = read("src/app/(dashboard)/catalogs/v2/use-groups.ts");
    expect(h).toContain("/pages");
    expect(h).toContain('method: "DELETE", json: { channelId: page.id }');
    expect(h).toContain("?force=1");
    expect(h).toContain("e.status === 409");
  });
});

describe("قيود الكود", () => {
  const DIR = join(process.cwd(), "src", "app", "(dashboard)", "catalogs", "v2");
  it("ولا كلمة ممنوعة ولا ملف فوق 300 سطر", () => {
    for (const f of readdirSync(DIR)) {
      const code = read(join(DIR, f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(findForbiddenTerms(code).map((x) => x.word), f).toEqual([]);
      expect(code.split("\n").length, f).toBeLessThanOrEqual(300);
    }
  });
});
