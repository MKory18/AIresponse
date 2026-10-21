/**
 * الثيمات — مصدر الحقيقة الوحيد للمفاتيح والسلوك.
 *
 * الثيم = اتنين مستقلين:
 *   - **الثيم** (`data-theme` على <html>): فلوينت (الافتراضي، بلا attribute) أو
 *     إسلامي أو المدينة الليلية. بيبدّل **متغيّرات الألوان** بـ globals.css.
 *   - **المظهر** (`.dark` على <html>): فاتح/داكن — زر الشريط العلوي زي ما كان.
 *
 * ⚠️ ثيم «المدينة الليلية» ليلي بطبيعته (نيون): بيفرض `.dark` ولا بيحترم
 * زر فاتح/داكن. 🔧 بدون ما نكتب مظهر المستخدم المحفوظ — فلما يرجع لثيم تاني
 * بيرجع لاختياره (فاتح أو داكن) بدل ما يضل عالق على الداكن.
 *
 * الحفظ: `localStorage` بالجهاز (مش بالحساب) — ما في ترحيل ولا عمود جديد.
 */

export const THEME_STORAGE_KEY = "zr-theme";
/** مفتاح المظهر (فاتح/داكن) — نفس المفتاح القديم، ما بينكسر الي محفوظ. */
export const SCHEME_STORAGE_KEY = "theme";

export type ThemeKey = "default";

export interface ThemeDef {
  key: ThemeKey;
  label: string;
  description: string;
  /** ثيم ليلي بطبيعته: بيفرض الداكن ويعطّل زر فاتح/داكن. */
  forcesDark: boolean;
  /** ألوان المعاينة ببطاقة المنتقي: [خلفية · سطح · أساسي · تمييز]. */
  swatches: [string, string, string, string];
}

export const THEMES: ThemeDef[] = [
  {
    key: "default",
    label: "فلوينت",
    description: "الواجهة الأساسية: مسطّحة ونظيفة وهادئة للعمل اليومي.",
    forcesDark: false,
    swatches: ["#f3f3f3", "#ffffff", "#0f6cbd", "#479ef5"],
  },
];

export function isThemeKey(value: unknown): value is ThemeKey {
  return typeof value === "string" && THEMES.some((t) => t.key === value);
}

export function themeDef(key: string | null | undefined): ThemeDef {
  return THEMES.find((t) => t.key === key) ?? THEMES[0]!;
}

/**
 * الثيم والمظهر الفعليين من المخزّن وتفضيل النظام.
 *
 * - مفتاح مجهول/تالف ← الافتراضي (ما بيرمي ولا بيعلّق الواجهة).
 * - ثيم ليلي ← داكن دايمًا.
 * - غيره: اختيار المستخدم المحفوظ، وإلا تفضيل النظام.
 *
 * ⚠️ لازم يطابق `THEME_INIT_SCRIPT` تحت بالضبط — اختبار `theme-system` بيشغّل
 * السكربت الحقيقي ويقارن بهالدالة على كل التركيبات.
 */
export function resolveTheme(input: {
  theme?: string | null;
  scheme?: string | null;
  prefersDark: boolean;
}): { theme: ThemeKey; dark: boolean } {
  const theme: ThemeKey = isThemeKey(input.theme) ? input.theme : "default";
  const dark =
    themeDef(theme).forcesDark || input.scheme === "dark" || (!input.scheme && input.prefersDark);
  return { theme, dark };
}

/**
 * سكربت قبل أول رسم (inline بـ<head>): بيحط `data-theme` و`.dark` قبل ما
 * المتصفح يرسم — بدونه الصفحة بتومض بالثيم الافتراضي لحظة قبل ما تتبدّل.
 * مبني من نفس `THEMES` فما بيتفرّق عن الدالة فوق.
 */
export const THEME_INIT_SCRIPT = (() => {
  const others = THEMES.map((t) => t.key).filter((k) => k !== "default");
  const forced = THEMES.filter((t) => t.forcesDark).map((t) => t.key);
  return (
    `(function(){try{var d=document.documentElement,` +
    `t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}),` +
    `s=localStorage.getItem(${JSON.stringify(SCHEME_STORAGE_KEY)}),` +
    `K=${JSON.stringify(others)},F=${JSON.stringify(forced)};` +
    `if(K.indexOf(t)<0)t="default";` +
    `var dark=F.indexOf(t)>=0||s==="dark"||(!s&&window.matchMedia("(prefers-color-scheme: dark)").matches);` +
    `if(t!=="default")d.setAttribute("data-theme",t);` +
    `if(dark)d.classList.add("dark");}catch(e){}})();`
  );
})();

/** البيئة الي بتحتاجها `applyTheme` — بتنحقن بالاختبار، وبالمتصفح هي الحقيقية. */
export interface ThemeEnv {
  root: {
    getAttribute(k: string): string | null;
    setAttribute(k: string, v: string): void;
    removeAttribute(k: string): void;
    classList: { toggle(c: string, on: boolean): void };
  };
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  prefersDark: boolean;
}

/**
 * بيطبّق ثيم ويحفظه. المظهر المحفوظ ما بينلمس لما الثيم بيفرض الداكن — فلما
 * ترجع لثيم عادي بيرجع اختيارك (فاتح/داكن).
 */
export function applyTheme(key: string, env: ThemeEnv): { theme: ThemeKey; dark: boolean } {
  const read = (k: string) => {
    try {
      return env.storage.getItem(k);
    } catch {
      return null;
    }
  };
  const r = resolveTheme({ theme: key, scheme: read(SCHEME_STORAGE_KEY), prefersDark: env.prefersDark });
  if (r.theme === "default") env.root.removeAttribute("data-theme");
  else env.root.setAttribute("data-theme", r.theme);
  env.root.classList.toggle("dark", r.dark);
  try {
    env.storage.setItem(THEME_STORAGE_KEY, r.theme);
  } catch {
    /* تخزين محجوب (وضع خاص) — الثيم بيشتغل لهالجلسة بس */
  }
  return r;
}

/**
 * بيبدّل المظهر (فاتح/داكن). بالثيم الليلي ما بيعمل شي: الثيم بيفرض الداكن،
 * وكتابة اختيار «فاتح» هون كانت رح تضل محفوظة وتفاجئك لما ترجع لثيم عادي.
 */
export function applyScheme(dark: boolean, env: ThemeEnv): { theme: ThemeKey; dark: boolean } {
  const rawKey = env.root.getAttribute("data-theme");
  const theme: ThemeKey = isThemeKey(rawKey) ? rawKey : "default";
  if (themeDef(theme).forcesDark) return { theme, dark: true };
  env.root.classList.toggle("dark", dark);
  try {
    env.storage.setItem(SCHEME_STORAGE_KEY, dark ? "dark" : "light");
  } catch {
    /* تخزين محجوب — بيشتغل لهالجلسة بس */
  }
  return { theme, dark };
}

/** حدث بيبلّغ باقي المكوّنات (زر الشريط العلوي) إن الثيم أو المظهر اتبدّل. */
export const THEME_CHANGE_EVENT = "zr-theme-change";

function documentEnv(): ThemeEnv {
  return {
    root: document.documentElement,
    storage: window.localStorage,
    prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  };
}

/** نسخة المتصفح الحقيقية من `applyTheme`. */
export function applyThemeToDocument(key: string): { theme: ThemeKey; dark: boolean } {
  const r = applyTheme(key, documentEnv());
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
  return r;
}

/** نسخة المتصفح الحقيقية من `applyScheme`. */
export function applySchemeToDocument(dark: boolean): { theme: ThemeKey; dark: boolean } {
  const r = applyScheme(dark, documentEnv());
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
  return r;
}

/** الثيم الحالي من <html> (بيجي من سكربت ما قبل الرسم). */
export function currentThemeKey(): ThemeKey {
  const v = typeof document === "undefined" ? null : document.documentElement.getAttribute("data-theme");
  return isThemeKey(v) ? v : "default";
}
