import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_GROUPS, pageForPath } from "@/lib/nav-model";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

import { EmptyNext } from "@/components/ui/empty-state";

/**
 * «الخطوة بتودي للتانية»: الحالة الفاضية الفعلية (قائمة فاضية مش خطأ ولا «اختر شي»)
 * ما بتضل مسدودة — بتدلّ على الخطوة الجاية برابط أو زر.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("EmptyNext", () => {
  it("رابط داخلي بشكل زر مع سهم الاتجاه", () => {
    const out = renderToStaticMarkup(createElement(EmptyNext, { href: "/channels", children: "اربط قناة" }));
    expect(out).toContain('href="/channels"');
    expect(out).toContain("data-empty-next");
    expect(out).toContain("اربط قناة");
    expect(out).toContain("<svg");
    expect(out).toContain("bg-primary");
  });

  it("الثانوي: بلا تعبئة", () => {
    const out = renderToStaticMarkup(createElement(EmptyNext, { href: "/orders", secondary: true, children: "x" }));
    expect(out).not.toContain("bg-primary text-white");
    expect(out).toContain("border-line");
  });
});

describe("الحالات الفاضية الفعلية بتدلّ على الخطوة الجاية", () => {
  const SITES: [string, string][] = [
    ["src/app/(dashboard)/customers/page.tsx", 'title="لا يوجد عملاء بعد"'],
    ["src/app/(dashboard)/handoffs/page.tsx", 'title="لا توجد تحويلات"'],
    ["src/app/(dashboard)/follow-ups/page.tsx", 'title="لا توجد متابعات"'],
    ["src/app/(dashboard)/catalogs/page.tsx", 'title="لا كتالوجات بعد"'],
    ["src/app/(dashboard)/feedback/page.tsx", 'title="لا توجد آراء"'],
    ["src/app/(dashboard)/settings/team/team-view.tsx", 'title="لا أعضاء"'],
    ["src/app/(dashboard)/intelligence/page.tsx", 'title="لا محادثات بعد"'],
    ["src/app/(dashboard)/analytics/page.tsx", 'title="لا بيانات منتجات بهالفترة"'],
    ["src/app/(dashboard)/orders/page.tsx", "title={t.orders.emptyTitle}"],
    ["src/app/(dashboard)/knowledge/page.tsx", "title={t.knowledge.emptyTitle}"],
    ["src/app/(dashboard)/media/page.tsx", "title={t.media.emptyTitle}"],
    ["src/app/(dashboard)/automation/page.tsx", 'title="ولا قاعدة لسا"'],
    ["src/app/(dashboard)/campaigns/page.tsx", 'title="لا حملات بعد"'],
  ];

  it.each(SITES)("%s ← %s", (file, marker) => {
    const src = read(file);
    const at = src.indexOf(marker);
    expect(at, "الحالة الفاضية مش موجودة").toBeGreaterThan(-1);
    const start = src.lastIndexOf("<EmptyState", at);
    const end = src.indexOf("/>", at);
    expect(src.slice(start, end), "بلا action").toContain("action=");
  });

  it("كل رابط `EmptyNext` بيأشّر على صفحة موجودة بالقائمة (بلا روابط ميتة)", () => {
    const root = join(process.cwd(), "src");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".tsx"));
    const hrefs = files.flatMap((f) =>
      [...read(join("src", f)).matchAll(/<EmptyNext href="([^"]+)"/g)].map((m) => m[1]!)
    );
    expect(hrefs.length).toBeGreaterThanOrEqual(6);
    for (const h of hrefs) expect(pageForPath(h, NAV_GROUPS), h).toBeTruthy();
  });
});
