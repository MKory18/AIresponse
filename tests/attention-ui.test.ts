import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { AttentionItem } from "@/modules/attention/service";

// `next/link` بيحتاج سياق الراوتر — للاختبار بنرجّعه <a> عادي.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { AttentionPanelView } from "@/components/attention/attention-panel";
import { HealthBannerView } from "@/components/attention/health-banner";

/** 2.3 — «يحتاجك» بالواجهة: شريط العطل · لوحة البنود · صفحات الخطأ/التحميل/غير موجود. */
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const item = (over: Partial<AttentionItem>): AttentionItem => ({
  id: "x", type: "ORDER_REVIEW", severity: "high", title: "طلب يحتاج مراجعة", subtitle: "SY-1", href: "/orders?order=o1", createdAt: "2026-11-17T12:00:00.000Z", ...over,
});

describe("HealthBanner", () => {
  it("بلا عطل = ما بيرسم شي", () => {
    expect(html(createElement(HealthBannerView, { banner: null }))).toBe("");
  });
  it("عطل = سطر تنبيه برابط «أصلح» لمكان الإصلاح بالضبط", () => {
    const out = html(createElement(HealthBannerView, { banner: { type: "OMS_DOWN", title: "ربط الـOMS متوقف", href: "/settings/integrations" } }));
    expect(out).toContain('role="alert"');
    expect(out).toContain("ربط الـOMS متوقف");
    expect(out).toContain('href="/settings/integrations"');
    expect(out).toContain("أصلح");
  });
  it("أكتر من عطل حرج = «و2 غيره»", () => {
    const out = html(createElement(HealthBannerView, { banner: { type: "OMS_DOWN", title: "عطل", href: "/x" }, extra: 2 }));
    expect(out).toContain("و2 غيره");
  });
});

describe("AttentionPanel", () => {
  it("فاضي = رسالة «ما في شي يحتاجك» (مش نهاية مسدودة بلا معنى)", () => {
    const out = html(createElement(AttentionPanelView, { items: [] }));
    expect(out).toContain("data-attention-empty");
    expect(out).toContain("ما في شي يحتاجك هلأ");
  });
  it("كل بند رابط مباشر لمكان المعالجة وبشارة شدته", () => {
    const out = html(
      createElement(AttentionPanelView, {
        items: [item({ id: "a", severity: "critical", type: "OMS_DOWN", title: "ربط الـOMS متوقف", href: "/settings/integrations" }), item({ id: "b" })],
      })
    );
    expect(out).toContain('href="/settings/integrations"');
    expect(out).toContain('href="/orders?order=o1"');
    expect(out).toContain('data-attention-item="OMS_DOWN"');
    expect(out).toContain("عطل");
    expect(out).toContain("مهم");
  });
});

describe("error / loading / not-found للّوحة", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("الثلاثة موجودة وبالعربي", () => {
    expect(read("src/app/(dashboard)/error.tsx")).toContain("أعد المحاولة");
    expect(read("src/app/(dashboard)/error.tsx")).toContain('"use client"');
    expect(read("src/app/(dashboard)/loading.tsx")).toContain("data-dashboard-loading");
    expect(read("src/app/(dashboard)/not-found.tsx")).toContain('href="/dashboard"');
  });
});
