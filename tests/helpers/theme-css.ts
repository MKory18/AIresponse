import { readFileSync } from "node:fs";
import { join } from "node:path";
import { themeDef } from "@/lib/theme";

/**
 * يحلّل `globals.css` ويحسب لوحة ألوان أي (ثيم × مظهر) بنفس ترتيب الـcascade
 * الحقيقي، وتباين WCAG بين أي زوج. بيخلّي «الثيم الجديد لازم يعدّي التباين»
 * قاعدة مفروضة بالاختبار، مش وعد بالتوثيق.
 */

const CSS = () => readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");

/** جسم الكتلة بمحدّد بالضبط (بلا كتل متداخلة — متغيّرات بس). */
function block(selector: string): Record<string, string> | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^{}]*)\\}`).exec(CSS());
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const [, k, v] of m[1]!.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[k!] = v!.trim();
  return out;
}

/**
 * اللوحة الفعلية: `:root` ثم `.dark` (إذا داكن) ثم كتلة الثيم.
 * الثيم الليلي (يفرض الداكن) كتلته الوحيدة `[data-theme="k"]`؛ غيره كتلتين:
 * `:not(.dark)` للفاتح و`.dark` للداكن — عشان الفاتح ما يطغى على الداكن.
 */
export function paletteFor(themeKey: string, dark: boolean): Record<string, string> {
  const root = block(":root");
  if (!root) throw new Error("globals.css: كتلة :root مفقودة");
  const pal = { ...root };
  if (dark) {
    const d = block(".dark");
    if (!d) throw new Error("globals.css: كتلة .dark مفقودة");
    Object.assign(pal, d);
  }
  if (themeKey !== "default") {
    const forced = themeDef(themeKey).forcesDark;
    const sel = forced
      ? `[data-theme="${themeKey}"]`
      : dark
        ? `[data-theme="${themeKey}"].dark`
        : `[data-theme="${themeKey}"]:not(.dark)`;
    const t = block(sel);
    if (!t) throw new Error(`globals.css: كتلة ${sel} مفقودة — الثيم «${themeKey}» ما انكتب`);
    Object.assign(pal, t);
  }
  return pal;
}

export type RGB = [number, number, number];

/** `"15 108 189"` أو `"15 108 189 / 0.5"` ← [15,108,189]. */
export function rgb(value: string | undefined): RGB {
  if (!value) throw new Error("لون مفقود");
  const n = value.split("/")[0]!.match(/\d+/g)?.map(Number);
  if (!n || n.length < 3) throw new Error(`لون مش صالح: ${value}`);
  return [n[0]!, n[1]!, n[2]!];
}

export function luminance([r, g, b]: RGB): number {
  const f = (x: number) => {
    const c = x / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** تباين WCAG 2.x بين لونين (1..21). */
export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

export const WHITE: RGB = [255, 255, 255];
