import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  SCHEME_STORAGE_KEY,
  THEMES,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  applyScheme,
  applyTheme,
  isThemeKey,
  resolveTheme,
  themeDef,
  type ThemeEnv,
} from "@/lib/theme";
import { ThemePickerView } from "@/components/theme-picker";
import { WHITE, contrast, luminance, paletteFor, rgb } from "./helpers/theme-css";

/**
 * نظام الثيمات.
 *
 * ⚠️ قبل: `primary` و`brand-*` كانت ألوان hex ثابتة بـ tailwind.config — فأي
 * ثيم ما كان قادر يبدّلها. وبالوضع الداكن `bg-primary-soft` ضل فاتح (#ebf3fc):
 * بند القائمة النشط طلع مستطيل أبيض بنص باهت.
 * 🔧 هلأ كل لون ثيم بمتغيّر CSS، وهالاختبارات بتفرض: السكربت = الدالة،
 * الثيم الجديد لازم يعدّي التباين، والداكن ما يرجع يتكسّر.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

// ───────────────────────── المنطق الصرف ─────────────────────────

const THEME_INPUTS = [null, undefined, "", "bogus", "DEFAULT", ...THEMES.map((t) => t.key)];
const SCHEME_INPUTS = [null, "light", "dark", "zzz"];

describe("resolveTheme", () => {
  it("مفتاح مجهول أو تالف = الافتراضي (ما بيرمي ولا بيعلّق الواجهة)", () => {
    for (const bad of [null, undefined, "", "bogus", "DEFAULT", "__proto__", "constructor"]) {
      expect(resolveTheme({ theme: bad, scheme: null, prefersDark: false }).theme, String(bad)).toBe("default");
    }
  });

  it("اختيار المستخدم المحفوظ أقوى من تفضيل النظام", () => {
    expect(resolveTheme({ theme: "default", scheme: "light", prefersDark: true }).dark).toBe(false);
    expect(resolveTheme({ theme: "default", scheme: "dark", prefersDark: false }).dark).toBe(true);
  });

  it("بلا اختيار محفوظ = تفضيل النظام", () => {
    expect(resolveTheme({ theme: "default", scheme: null, prefersDark: true }).dark).toBe(true);
    expect(resolveTheme({ theme: "default", scheme: null, prefersDark: false }).dark).toBe(false);
  });

  it("ثيم ليلي بطبيعته بيفرض الداكن حتى لو اخترت «فاتح»", () => {
    for (const t of THEMES.filter((x) => x.forcesDark)) {
      expect(resolveTheme({ theme: t.key, scheme: "light", prefersDark: false }).dark, t.key).toBe(true);
    }
  });

  it("isThemeKey صارم", () => {
    expect(isThemeKey("default")).toBe(true);
    for (const bad of ["x", "", null, undefined, 3, {}, "toString"]) expect(isThemeKey(bad)).toBe(false);
  });
});

// ───────────────────── السكربت قبل الرسم = الدالة ─────────────────────

function runScript(storage: Record<string, string>, prefersDark: boolean, throwing = false) {
  const attrs: Record<string, string> = {};
  const classes = new Set<string>();
  const ctx = {
    document: {
      documentElement: {
        setAttribute: (k: string, v: string) => (attrs[k] = v),
        classList: { add: (c: string) => classes.add(c) },
      },
    },
    localStorage: {
      getItem: (k: string) => {
        if (throwing) throw new Error("blocked");
        return k in storage ? storage[k]! : null;
      },
    },
    window: { matchMedia: () => ({ matches: prefersDark }) },
  };
  runInNewContext(THEME_INIT_SCRIPT, ctx);
  return { theme: (attrs["data-theme"] as string | undefined) ?? "default", dark: classes.has("dark"), attrs };
}

describe("سكربت ما قبل الرسم", () => {
  it("بيطلع نفس نتيجة resolveTheme على كل التركيبات (ما بيتفرّقوا)", () => {
    let n = 0;
    for (const theme of THEME_INPUTS) {
      for (const scheme of SCHEME_INPUTS) {
        for (const prefersDark of [false, true]) {
          const storage: Record<string, string> = {};
          if (typeof theme === "string") storage[THEME_STORAGE_KEY] = theme;
          if (typeof scheme === "string") storage[SCHEME_STORAGE_KEY] = scheme;
          const got = runScript(storage, prefersDark);
          const want = resolveTheme({ theme: theme as string | null, scheme: scheme as string | null, prefersDark });
          expect(got.theme, JSON.stringify({ theme, scheme, prefersDark })).toBe(want.theme);
          expect(got.dark, JSON.stringify({ theme, scheme, prefersDark })).toBe(want.dark);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(40);
  });

  it("الافتراضي ما بيكتب data-theme (بلا attribute)", () => {
    expect(runScript({}, false).attrs["data-theme"]).toBeUndefined();
  });

  it("تخزين محجوب (يرمي) = ما بيعطّل الصفحة ولا بيغيّر شي", () => {
    const r = runScript({}, true, true);
    expect(r.theme).toBe("default");
    expect(r.dark).toBe(false);
  });

  it("الـlayout بيستعمل نفس السكربت", () => {
    expect(read("src/app/layout.tsx")).toContain("THEME_INIT_SCRIPT");
  });
});

// ───────────────────── التطبيق والحفظ ─────────────────────

function fakeEnv(initial: Record<string, string> = {}, prefersDark = false, throwing = false) {
  const store: Record<string, string> = { ...initial };
  const attrs: Record<string, string> = {};
  let dark = false;
  const env: ThemeEnv = {
    root: {
      getAttribute: (k) => attrs[k] ?? null,
      setAttribute: (k, v) => void (attrs[k] = v),
      removeAttribute: (k) => void delete attrs[k],
      classList: { toggle: (_c, on) => void (dark = on) },
    },
    storage: {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => {
        if (throwing) throw new Error("blocked");
        store[k] = v;
      },
    },
    prefersDark,
  };
  return { env, store, attrs, isDark: () => dark };
}

describe("applyTheme / applyScheme", () => {
  it("بيحفظ الثيم، وبيشيل data-theme للافتراضي", () => {
    const f = fakeEnv({}, false);
    applyTheme("default", f.env);
    expect(f.store[THEME_STORAGE_KEY]).toBe("default");
    expect(f.attrs["data-theme"]).toBeUndefined();
  });

  it("المظهر بيتبدّل ويتحفظ", () => {
    const f = fakeEnv();
    expect(applyScheme(true, f.env).dark).toBe(true);
    expect(f.isDark()).toBe(true);
    expect(f.store[SCHEME_STORAGE_KEY]).toBe("dark");
    applyScheme(false, f.env);
    expect(f.isDark()).toBe(false);
    expect(f.store[SCHEME_STORAGE_KEY]).toBe("light");
  });

  it("تخزين محجوب ما بيرمي (الثيم بيشتغل لهالجلسة)", () => {
    const f = fakeEnv({}, false, true);
    expect(() => applyTheme("default", f.env)).not.toThrow();
    expect(() => applyScheme(true, f.env)).not.toThrow();
  });

  it("ثيم ليلي: بيفرض الداكن بلا ما يكتب اختيارك — وبترجع لاختيارك لما تبدّله", () => {
    const night = THEMES.find((t) => t.forcesDark);
    if (!night) return; // الثيم الليلي بينضاف بكوميت لاحق — الاختبار بيتفعّل لحاله
    const f = fakeEnv({ [SCHEME_STORAGE_KEY]: "light" }, false);
    const r = applyTheme(night.key, f.env);
    expect(r.dark).toBe(true);
    expect(f.store[SCHEME_STORAGE_KEY]).toBe("light"); // ما انلمس
    // زر فاتح/داكن ما بيعمل شي بالثيم الليلي ولا بيكتب «فاتح» محفوظ.
    f.store[SCHEME_STORAGE_KEY] = "dark";
    expect(applyScheme(false, f.env)).toMatchObject({ dark: true });
    expect(f.store[SCHEME_STORAGE_KEY]).toBe("dark");
    // رجعت لثيم عادي ← اختيارك المحفوظ.
    f.store[SCHEME_STORAGE_KEY] = "light";
    expect(applyTheme("default", f.env).dark).toBe(false);
  });
});

// ───────────────────── ربط الألوان بالمتغيّرات ─────────────────────

describe("الألوان بمتغيّرات CSS (مش hex ثابت)", () => {
  const config = read("tailwind.config.ts");

  it("tailwind.config ما فيه ولا لون hex — كله من المتغيّرات (التعليقات مستثناة)", () => {
    const code = config.replace(/\/\/.*$/gm, "");
    expect(code.match(/#[0-9a-fA-F]{6}\b/g) ?? []).toEqual([]);
  });

  it("primary وbrand وaccent وshowcase بيقروا من var(--…)", () => {
    for (const v of ["--primary)", "--primary-hover)", "--primary-soft)", "--primary-fg)", "--accent)", "--accent-fg)", "--showcase)"]) {
      expect(config, v).toContain(`rgb(var(${v}`);
    }
    for (const n of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
      expect(config, `brand-${n}`).toContain(`rgb(var(--brand-${n}) / <alpha-value>)`);
    }
  });

  it("النص `text-primary` بيقرا لون «الأمامي» مش لون التعبئة", () => {
    expect(config).toMatch(/textColor:\s*\{\s*primary:\s*\{\s*DEFAULT:\s*"rgb\(var\(--primary-fg\)/);
  });

  it("سلّم brand الافتراضي = الـhex القديم بالحرف (ولا بكسل بيتغيّر بالثيم الافتراضي)", () => {
    const OLD: Record<number, string> = {
      50: "#ebf3fc", 100: "#cfe4fa", 200: "#b4d6f7", 300: "#77b7f2", 400: "#3d95e8", 500: "#0f6cbd",
      600: "#115ea3", 700: "#0f548c", 800: "#0c3b5e", 900: "#082e4a", 950: "#051e2f",
    };
    const pal = paletteFor("default", false);
    for (const [n, hex] of Object.entries(OLD)) {
      const [r, g, b] = rgb(pal[`brand-${n}`]);
      expect("#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join(""), `brand-${n}`).toBe(hex);
    }
    expect(rgb(pal.primary)).toEqual([0x0f, 0x6c, 0xbd]);
    expect(rgb(pal["primary-hover"])).toEqual([0x11, 0x5e, 0xa3]);
    expect(rgb(pal["primary-soft"])).toEqual([0xeb, 0xf3, 0xfc]);
  });

  it("⚠️ الداكن: الخلفية الخفيفة غامقة والنص فاتح (كان مستطيل أبيض بنص باهت)", () => {
    const dark = paletteFor("default", true);
    // `bg-primary-soft` لازم يكون غامق، مش #ebf3fc الثابت القديم.
    expect(luminance(rgb(dark["primary-soft"]))).toBeLessThan(0.05);
    // و`text-primary` عليه لازم يتقرا (هاد بالضبط زوج «شريحة الأيقونة» بكل الموقع).
    expect(contrast(rgb(dark["primary-fg"]), rgb(dark["primary-soft"]))).toBeGreaterThanOrEqual(4.5);
    // تعبئة الأزرار ما اتغيّرت (نص أبيض عليها).
    expect(rgb(dark.primary)).toEqual([0x0f, 0x6c, 0xbd]);
  });

  it("ولا `bg-[#hex]` ثابت بلوحة الدخول (كانت لون مش قابل للثيم)", () => {
    expect(read("src/components/auth-form.tsx")).not.toMatch(/bg-\[#[0-9a-fA-F]{3,8}\]/);
  });
});

// ───────────────────── التباين لكل ثيم × مظهر ─────────────────────

const REQUIRED = [
  "surface-1", "surface-2", "surface-3", "surface-hover", "line", "text", "text-muted", "text-subtle",
  "primary", "primary-hover", "primary-soft", "primary-fg", "brand", "accent", "accent-fg", "showcase",
  "shadow-card", "shadow-pop", ...[50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((n) => `brand-${n}`),
];

const COMBOS = THEMES.flatMap((t) => (t.forcesDark ? [[t.key, true]] : [[t.key, false], [t.key, true]])) as [string, boolean][];

describe.each(COMBOS)("تباين الثيم «%s» (داكن: %s)", (key, dark) => {
  const p = paletteFor(key, dark);
  const s = (n: string) => rgb(p[n]);
  const surfaces = ["surface-1", "surface-2", "surface-3"];

  it("كل الأدوار معرّفة", () => {
    for (const v of REQUIRED) expect(p[v], `--${v} ناقص`).toBeTruthy();
  });

  it("النص الأساسي ≥ 7:1 والمخفّف ≥ 4.5:1 على كل الأسطح", () => {
    for (const sf of surfaces) {
      expect(contrast(s("text"), s(sf)), `text/${sf}`).toBeGreaterThanOrEqual(7);
      expect(contrast(s("text-muted"), s(sf)), `muted/${sf}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("النص الخافت ≥ 4.5:1 (الافتراضي مستثنى بـ 4.4 — موروث من #26)", () => {
    const min = key === "default" ? 4.4 : 4.5;
    for (const sf of [...surfaces, "primary-soft"]) {
      expect(contrast(s("text-subtle"), s(sf)), `subtle/${sf}`).toBeGreaterThanOrEqual(min);
    }
  });

  it("`text-primary` مقروء على الأسطح وعلى الشريحة الخفيفة (الزوج الأكثر استعمالًا)", () => {
    for (const sf of [...surfaces, "primary-soft"]) {
      expect(contrast(s("primary-fg"), s(sf)), `primary-fg/${sf}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("النص الأبيض على تعبئة الأزرار ≥ 4.5:1", () => {
    expect(contrast(WHITE, s("primary")), "white/primary").toBeGreaterThanOrEqual(4.5);
    expect(contrast(WHITE, s("primary-hover")), "white/primary-hover").toBeGreaterThanOrEqual(4.5);
    expect(contrast(WHITE, s("brand-500")), "white/brand-500").toBeGreaterThanOrEqual(4.5);
    expect(contrast(WHITE, s("brand-600")), "white/brand-600").toBeGreaterThanOrEqual(4.5);
  });

  it("لون التمييز النصي ≥ 4.5:1 وحلقة التركيز ≥ 3:1", () => {
    expect(contrast(s("accent-fg"), s("surface-2")), "accent-fg").toBeGreaterThanOrEqual(4.5);
    expect(contrast(s("brand"), s("surface-2")), "focus ring").toBeGreaterThanOrEqual(3);
  });

  it("الحالات (نجاح/تحذير/خطر) مقروءة على السطح", () => {
    for (const st of ["success", "warning", "danger", "info"]) {
      expect(contrast(s(st), s("surface-2")), st).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// ───────────────────── المنتقي ─────────────────────

describe("منتقي الثيم", () => {
  const html = (over: Partial<Parameters<typeof ThemePickerView>[0]> = {}) =>
    renderToStaticMarkup(createElement(ThemePickerView, { theme: "default", dark: false, ...over }));

  it("بطاقة لكل ثيم بمجموعة radio معنونة، والمختار بس aria-checked", () => {
    const out = html();
    expect(out).toContain('role="radiogroup"');
    expect(out).toContain('aria-label="الثيم"');
    for (const t of THEMES) expect(out).toContain(`data-theme-card="${t.key}"`);
    const cards = THEMES.length;
    expect(out.match(/role="radio"[^>]*aria-checked="true"[^>]*data-theme-card/g) ?? []).toHaveLength(1);
    expect((out.match(/data-theme-card/g) ?? []).length).toBe(cards);
  });

  it("معاينة الألوان لكل ثيم (٤ خانات)", () => {
    const out = html();
    for (const t of THEMES) for (const c of t.swatches) expect(out).toContain(`background-color:${c}`);
  });

  it("فاتح/داكن: المختار aria-checked، وكلهم شغّالين بثيم عادي", () => {
    const out = html({ dark: true });
    expect(out).toMatch(/data-scheme="dark"[^>]*>/);
    expect(out).not.toContain('disabled=""'); // (كلمة disabled بأسماء أصناف Tailwind مش المقصودة)
    expect(out).not.toContain("ليلي بطبيعته");
  });

  it("كل ثيم بالمنتقي معرّف بـ themeDef", () => {
    for (const t of THEMES) expect(themeDef(t.key).label).toBe(t.label);
  });
});
