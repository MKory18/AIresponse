import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Metric } from "@/modules/today/service";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { MetricCard } from "@/app/(dashboard)/dashboard/today/metric-card";
import { RecentList, SettlingList } from "@/app/(dashboard)/dashboard/today/lists";
import { TODAY_STRINGS } from "@/app/(dashboard)/dashboard/today/strings";
import { findForbiddenTerms } from "@/lib/glossary";

/** 3.3 — واجهة «اليوم»: كل رقم بقاعدة احتسابه · الفرق بالنص والأيقونة · قوائم بفراغ إله فعل · مفتاح الواجهة. */
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const base: Metric = { key: "newConversations", label: "محادثات جديدة", value: 38, delta: 6, unit: "count", currency: null, definition: "تعريف الرقم هون." };
const DIR = join(process.cwd(), "src", "app", "(dashboard)", "dashboard", "today");

describe("MetricCard", () => {
  it("الرقم والفرق والتعريف (ولا رقم بلا «كيف بنحسبه»)", () => {
    const out = html(createElement(MetricCard, { metric: base, prevLabel: "عن أمس" }));
    expect(out).toContain("38");
    expect(out).toContain("▲ 6 عن أمس");
    expect(out).toContain("كيف بنحسبه: تعريف الرقم هون.");
    expect(out).toContain('data-metric="newConversations"');
  });

  it("الهبوط ▼ والتساوي والمبلغ برمز العملة والنسبة بنقاط", () => {
    expect(html(createElement(MetricCard, { metric: { ...base, delta: -2 }, prevLabel: "عن أمس" }))).toContain("▼ 2 عن أمس");
    expect(html(createElement(MetricCard, { metric: { ...base, delta: 0 }, prevLabel: "عن أمس" }))).toContain("مثل أمس");
    expect(html(createElement(MetricCard, { metric: { ...base, unit: "money", value: 220, currency: "JOD", delta: 40 }, prevLabel: "عن أمس" }))).toContain("220 د.أ");
    const pct = html(createElement(MetricCard, { metric: { ...base, key: "conversionRate", unit: "percent", value: 29, delta: -2 }, prevLabel: "عن أمس" }));
    expect(pct).toContain("29%");
    expect(pct).toContain("2 نقطة");
  });

  it("نسبة بلا عيّنة = «—» مع سبب (مش 0%)", () => {
    const out = html(createElement(MetricCard, { metric: { ...base, key: "conversionRate", unit: "percent", value: null, delta: null }, prevLabel: "عن أمس" }));
    expect(out).toContain("—");
    expect(out).toContain(TODAY_STRINGS.lowSample);
    expect(out).not.toContain("0%");
  });
});

describe("القوائم", () => {
  it("«بتتثبّت هلأ»: بنود برابط الطلب وعدّاد، والفراغ بجملة", () => {
    const out = html(createElement(SettlingList, { rows: [{ id: "o1", orderNumber: "SY-1", settleAt: new Date(Date.now() + 8 * 60_000).toISOString(), recipientName: "أبو أحمد", items: "كريم حرير ×1", conversationId: "c1" }] }));
    expect(out).toContain('href="/orders?order=o1"');
    expect(out).toContain("أبو أحمد");
    expect(out).toContain("data-countdown");
    expect(html(createElement(SettlingList, { rows: [] }))).toContain(TODAY_STRINGS.settlingEmpty);
  });

  it("«آخر الطلبات»: رقم + شريحة حالة + مبلغ بعملته، والفراغ له فعل", () => {
    const out = html(createElement(RecentList, { rows: [{ id: "o2", orderNumber: "SY-2", status: "مثبّت", statusTone: "ok", total: 20, currency: "USD", createdAt: "2026-11-17T10:00:00Z" }] }));
    expect(out).toContain("SY-2");
    expect(out).toContain('data-tone="success"');
    expect(out).toContain("$20");
    const empty = html(createElement(RecentList, { rows: [] }));
    expect(empty).toContain(TODAY_STRINGS.recentEmpty);
    expect(empty).toContain('href="/orders"');
  });
});

describe("صفحة /dashboard", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("الصفحة بتعرض «اليوم» بس (اللوحة القديمة انحذفت بـ3.8)", () => {
    const p = read("src/app/(dashboard)/dashboard/page.tsx");
    expect(p).toContain("<TodayView />");
    expect(p).not.toContain("resolveUiVersion");
    expect(p).not.toContain("LegacyDashboard");
  });

  it("الأزرار والأقسام من القاموس: ولا كلمة ممنوعة بملفات «اليوم»، ولا ملف فوق 300 سطر", () => {
    for (const f of readdirSync(DIR)) {
      const code = read(join(DIR, f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(findForbiddenTerms(code).map((x) => x.word), f).toEqual([]);
      expect(code.split("\n").length, f).toBeLessThanOrEqual(300);
    }
  });

  it("«ابدأ من هون» للمالك بس، و«يحتاجك» من نفس مصدر القائمة", () => {
    const v = read(join(DIR, "today-view.tsx"));
    expect(v).toMatch(/<Can permission="settings.manage">\s*<SetupChecklist/);
    expect(v).toContain("useAttention");
  });
});
