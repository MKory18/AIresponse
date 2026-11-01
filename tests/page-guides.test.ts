import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_GROUPS, pageForPath } from "@/lib/nav-model";
import { PAGE_GUIDES, guideForPath, visitGuide } from "@/lib/page-guides";

// `next/link` بيحتاج سياق الراوتر — للاختبار بنرجّعه <a> عادي.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { PageGuidePanel } from "@/components/page-guide";

/**
 * الشرح جوّا كل صفحة.
 *
 * ⚠️ قبل: ولا شرح بكل الموقع — صفحة مثل «الكتالوجات» أو «مختبر التجميع» ما فيها
 * ولا كلمة بتقول شو بتعمل ولا شو بعدها.
 * 🔧 هلأ كل صفحة بالقائمة إلها شرح و«خطوة جاية»، والاختبار بيفرضه — صفحة
 * جديدة بلا شرح = الاختبار بيفشل.
 */

const NAV_HREFS = NAV_GROUPS.flatMap((g) => g.pages.map((p) => p.href));

describe("تغطية الشرح", () => {
  it("كل صفحة بالقائمة إلها شرح — ولا شرح ليتيم", () => {
    const missing = NAV_HREFS.filter((h) => !PAGE_GUIDES[h]);
    expect(missing, `صفحات بلا شرح: ${missing.join(" ")}`).toEqual([]);
    const orphans = Object.keys(PAGE_GUIDES).filter((h) => !NAV_HREFS.includes(h));
    expect(orphans, `شرح لصفحة مش بالقائمة: ${orphans.join(" ")}`).toEqual([]);
  });

  it("الشرح قصير وواضح (سطرين مش مقال)", () => {
    for (const [href, g] of Object.entries(PAGE_GUIDES)) {
      expect(g.what.length, `${href}: شرح قصير جدًا`).toBeGreaterThanOrEqual(30);
      expect(g.what.length, `${href}: شرح طويل (${g.what.length})`).toBeLessThanOrEqual(220);
      if (g.tip) expect(g.tip.length, `${href}: نصيحة طويلة`).toBeLessThanOrEqual(170);
      expect(g.next.label.length, `${href}: عنوان الخطوة`).toBeLessThanOrEqual(40);
    }
  });

  it("⚠️ ولا كلمة «Hermes» بأي نص مرئي (قرار المالك — تسميات عامة)", () => {
    expect(JSON.stringify(PAGE_GUIDES).toLowerCase()).not.toContain("hermes");
  });
});

describe("«الخطوة الجاية» بتودّي لمكان حقيقي", () => {
  it("كل خطوة جاية بتأشّر على صفحة بالقائمة، وما بتأشّر على نفسها", () => {
    for (const [href, g] of Object.entries(PAGE_GUIDES)) {
      expect(NAV_HREFS, `${href} ← ${g.next.href}`).toContain(g.next.href);
      expect(g.next.href, `${href} بتأشّر على نفسها`).not.toBe(href);
    }
  });

  it("ولا طريق مسدود: من أي صفحة، باتباع «الخطوة الجاية» بتوصل لدورة (ما بتوقف)", () => {
    for (const start of NAV_HREFS) {
      const seen = new Set<string>();
      let at = start;
      while (!seen.has(at)) {
        seen.add(at);
        at = PAGE_GUIDES[at]!.next.href;
      }
      expect(seen.size).toBeGreaterThan(1);
    }
  });

  it("الدليل وبطاقة «ابدأ من هون» بيحكوا نفس القصة: قناة ← منتجات ← شخصية ← معرفة ← تجربة ← تشغيل", () => {
    const chain = ["/channels", "/products", "/personas", "/knowledge", "/ai/playground", "/settings/ai"];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(PAGE_GUIDES[chain[i]!]!.next.href, `${chain[i]} ← ؟`).toBe(chain[i + 1]);
    }
  });
});

describe("مطابقة المسار بالشرح", () => {
  it("صفحة التفاصيل بتاخد شرح صفحتها، والاسم المستعار كمان", () => {
    expect(guideForPath("/orders/abc123")?.href).toBe("/orders");
    expect(guideForPath("/products/p9")?.href).toBe("/products");
    expect(guideForPath("/order-warehouse")?.href).toBe("/orders");
    expect(guideForPath("/settings/ai")?.href).toBe("/settings/ai");
    // الروابط المدموجة بتاخد شرح مكانها الجديد.
    expect(guideForPath("/settings")?.href).toBe("/settings/account");
    expect(guideForPath("/ai/studio")?.href).toBe("/settings/ai");
    expect(guideForPath("/workflows")?.href).toBe("/automation");
    expect(guideForPath("/analytics/ai")?.href).toBe("/analytics");
  });

  it("مسار مجهول = ولا شرح (مش شرح غلط)", () => {
    expect(guideForPath("/nothing")).toBeNull();
    expect(guideForPath("/")).toBeNull();
  });

  it("كل صفحة فعلية بالقائمة بتطلع إلها شرح", () => {
    for (const h of NAV_HREFS) expect(guideForPath(h)?.href).toBe(h);
    expect(pageForPath("/orders/x", NAV_GROUPS)).not.toBeNull();
  });
});

describe("أول زيارة بس", () => {
  it("أول مرة: بيفتح ويتعلّم مزار", () => {
    const r = visitGuide(null, "/orders", true);
    expect(r.open).toBe(true);
    expect(JSON.parse(r.seenRaw)).toEqual(["/orders"]);
  });

  it("المرة التانية: مطوي (الخبير ما بيشوفه كل مرة)", () => {
    const first = visitGuide(null, "/orders", true);
    const second = visitGuide(first.seenRaw, "/orders", true);
    expect(second.open).toBe(false);
    expect(JSON.parse(second.seenRaw)).toEqual(["/orders"]); // ما بيتكرر
  });

  it("صفحة تانية = أول زيارة إلها", () => {
    const a = visitGuide(null, "/orders", true);
    const b = visitGuide(a.seenRaw, "/products", true);
    expect(b.open).toBe(true);
    expect(JSON.parse(b.seenRaw)).toEqual(["/orders", "/products"]);
  });

  it("صندوق الوارد (شاشة كاملة): بيتعلّم مزار بس ما بيفتح لحاله", () => {
    const r = visitGuide(null, "/conversations", false);
    expect(r.open).toBe(false);
    expect(JSON.parse(r.seenRaw)).toContain("/conversations");
  });

  it("تخزين تالف أو بشكل غلط ما بيكسر شي — بنبدأ من فاضي", () => {
    for (const bad of ["{not json", "42", '{"a":1}', "null", '"str"']) {
      const r = visitGuide(bad, "/orders", true);
      expect(r.open, bad).toBe(true);
      expect(JSON.parse(r.seenRaw)).toEqual(["/orders"]);
    }
  });

  it("عناصر مش نصوص بالتخزين بتنشال، والقائمة محدودة الطول", () => {
    const dirty = JSON.stringify(["/a", 5, null, "/b", { x: 1 }]);
    expect(JSON.parse(visitGuide(dirty, "/c", true).seenRaw)).toEqual(["/a", "/b", "/c"]);
    const big = JSON.stringify(Array.from({ length: 500 }, (_, i) => `/p${i}`));
    const r = visitGuide(big, "/new", true);
    const seen = JSON.parse(r.seenRaw) as string[];
    expect(seen.length).toBeLessThanOrEqual(200);
    expect(seen[seen.length - 1]).toBe("/new"); // الأحدث بيضل
  });
});

describe("اللوحة", () => {
  const guide = PAGE_GUIDES["/products"]!;
  const render = (over: Partial<Parameters<typeof PageGuidePanel>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(PageGuidePanel, { guide, nextAllowed: true, onClose: () => {}, ...over })
    );

  it("بتعرض الشرح والنصيحة والخطوة الجاية برابط صحيح", () => {
    const html = render();
    expect(html).toContain("شو هاي الصفحة؟");
    expect(html).toContain(guide.what);
    expect(html).toContain(guide.tip!);
    expect(html).toContain(`href="${guide.next.href}"`);
    expect(html).toContain(guide.next.label);
  });

  it("منطقة معنونة لقارئ الشاشة وزر إغلاق", () => {
    const html = render();
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="شرح الصفحة"');
    expect(html).toContain('aria-label="إغلاق الشرح"');
  });

  it("الخطوة الجاية بتختفي لما العضو ما بيقدر يفتح الصفحة (بدل ٤٠٣)", () => {
    const html = render({ nextAllowed: false });
    expect(html).not.toContain("الخطوة الجاية");
    expect(html).not.toContain(`href="${guide.next.href}"`);
    expect(html).toContain(guide.what); // الشرح نفسه بيضل
  });

  it("الوارد: طبقة فوق المحتوى (overlay) مش بالتدفّق — ما بتخرّب ارتفاع الأعمدة", () => {
    expect(render({ overlay: true })).toContain('data-guide="overlay"');
    expect(render({ overlay: true })).toContain("absolute");
    expect(render()).toContain('data-guide="inline"');
    expect(render()).not.toContain("absolute");
  });
});

describe("ربط القشرة", () => {
  const shell = readFileSync(join(process.cwd(), "src/components/app-shell.tsx"), "utf8");

  it("زر «؟» بالشريط العلوي معنون ومرتبط بالحالة", () => {
    expect(shell).toContain('aria-label="شرح هذه الصفحة"');
    expect(shell).toContain("aria-expanded={guideOpen}");
  });

  it("الرأس والتبويبات ثابتين مع التمرير (غلاف sticky واحد)", () => {
    expect(shell).toContain('<div className="sticky top-0 z-20">');
  });

  it("Esc بيسكّر الشرح", () => {
    expect(shell).toContain('e.key === "Escape") setGuideOpen(false)');
  });
});
