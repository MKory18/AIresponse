import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_MARK_PATH, BRAND_SPARK_PATH, BrandLogo } from "@/components/brand-logo";

/**
 * علامة Zaki: فقاعة محادثة والحرف Z مفرّغ منها. شكل البلاطة بيتبدّل بالثيم من CSS،
 * والأيقونة (favicon / PWA) بنفس المسار — هالاختبارات بتمنع الانحراف.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const html = (size?: "xs" | "sm" | "md" | "lg" | "xl") => renderToStaticMarkup(createElement(BrandLogo, { size }));

describe("علامة Zaki (BrandLogo)", () => {
  it("زخرفية (aria-hidden) وفيها مقابض الثيمات: بلاطة · فقاعة · شرارة", () => {
    const out = html();
    expect(out).toContain("aria-hidden");
    for (const hook of ["data-brand-logo", "data-logo-tile", "data-logo-bubble", "data-logo-spark"]) {
      expect(out, hook).toContain(hook);
    }
  });

  it("الألوان من متغيّرات الثيم — ولا لون ثابت (كانت sky-400 / blue-800 / sky-200)", () => {
    const out = html();
    for (const c of ["from-logo-from", "via-logo-via", "to-logo-to", "var(--logo-bubble)", "var(--logo-spark)"]) {
      expect(out, c).toContain(c);
    }
    expect(out).not.toMatch(/sky-\d|blue-\d|#[0-9a-fA-F]{3,6}/);
  });

  it("كل مقاس بصنف مقاس مختلف", () => {
    const sizes = (["xs", "sm", "md", "lg", "xl"] as const).map((s) => /h-\d+ w-\d+/.exec(html(s))![0]);
    expect(new Set(sizes).size).toBe(5);
  });

  it("الفقاعة والحرف مسار واحد evenodd: مسارين فرعيين (فقاعة + Z مفرّغ)", () => {
    expect(BRAND_MARK_PATH.match(/M/g)).toHaveLength(2);
    expect(html()).toContain('fill-rule="evenodd"');
  });

  it("الأيقونة (icon.svg) بنفس مسار المكوّن — ما بينحرفوا", () => {
    const svg = read("src/app/icon.svg");
    expect(svg).toContain(BRAND_MARK_PATH);
    expect(svg).toContain(BRAND_SPARK_PATH);
    expect(svg).toContain('fill-rule="evenodd"');
  });

  it("الثيم الإسلامي: بلاطة نجمة ثمانية (16 نقطة) والتوهّج على الغلاف (clip-path بيقصّ الظل)", () => {
    const css = read("src/app/globals.css");
    const tile = /\[data-theme="islamic"\] \[data-logo-tile\]\s*\{([^}]*)\}/.exec(css);
    expect(tile, "قاعدة البلاطة ناقصة").toBeTruthy();
    const poly = /clip-path:\s*polygon\(([^)]*)\)/.exec(tile![1]!);
    expect(poly, "clip-path ناقص").toBeTruthy();
    expect(poly![1]!.split(",")).toHaveLength(16);
    expect(css).toMatch(/\[data-theme="islamic"\] \[data-brand-logo\]\s*\{[^}]*drop-shadow/);
  });
});
