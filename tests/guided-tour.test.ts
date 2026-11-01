import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_GROUPS } from "@/lib/nav-model";
import { TOUR_STEPS, shouldAutoStartTour } from "@/lib/guided-tour";

/**
 * الجولة السريعة (driver.js · MIT).
 *
 * ⚠️ قبل: ولا تعريف بالقائمة نفسها — الشرح جوّا الصفحات بس، بعد ما تدخلها.
 * 🔧 جولة قصيرة مرة وحدة أول دخول، ومن زر «جولة» بأي وقت. الاختبار بيضمن إن كل
 * خطوة إلها عنصر حقيقي، والنص عربي وقصير، والمكتبة مثبّتة بنسخة محدّدة.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const shell = read("src/components/app-shell.tsx");
const sidebar = read("src/components/app-sidebar.tsx");

describe("خطوات الجولة", () => {
  it("كل مجموعة بالقائمة إلها خطوة، وكل خطوة مجموعة إلها مجموعة حقيقية", () => {
    const groupSteps = TOUR_STEPS.filter((s) => s.target.startsWith("group-")).map((s) => s.target.slice(6));
    expect(groupSteps.sort()).toEqual(NAV_GROUPS.map((g) => g.key).sort());
    expect(sidebar).toContain("tour={`group-${");
    expect(sidebar).toContain("data-tour={tour}");
  });

  it("الخطوات التانية مربوطة بعنصر موجود بالشريط العلوي", () => {
    for (const s of TOUR_STEPS.filter((x) => !x.target.startsWith("group-"))) {
      expect(shell, s.target).toContain(`data-tour="${s.target}"`);
    }
  });

  it("النص عربي وقصير، وبلا اسم داخلي", () => {
    for (const s of TOUR_STEPS) {
      expect(s.text, s.target).toMatch(/[؀-ۿ]/);
      expect(s.text.length, s.target).toBeLessThanOrEqual(120);
      expect(s.title.length, s.target).toBeLessThanOrEqual(24);
    }
    expect(JSON.stringify(TOUR_STEPS).toLowerCase()).not.toContain("hermes");
  });
});

describe("متى بتشتغل لحالها", () => {
  it("أول دخول للرئيسية بس", () => {
    expect(shouldAutoStartTour("/dashboard", null)).toBe(true);
    expect(shouldAutoStartTour("/dashboard", "1")).toBe(false);
    expect(shouldAutoStartTour("/orders", null)).toBe(false);
  });

  it("بترجع من زر «جولة» بالشريط العلوي", () => {
    expect(shell).toContain("startGuidedTour(");
  });
});

describe("المكتبة", () => {
  it("driver.js مثبّتة بنسخة محدّدة (بلا ^ ولا ~)", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["driver.js"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("شكلها من متغيّرات الثيم (بلا ألوان ثابتة)", () => {
    const css = read("src/app/globals.css");
    const block = css.slice(css.indexOf(".zr-tour"));
    expect(block.length).toBeGreaterThan(10);
    const tourCss = block.slice(0, block.indexOf("/* /zr-tour */"));
    expect(tourCss).toContain("var(--surface)");
    expect(tourCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
