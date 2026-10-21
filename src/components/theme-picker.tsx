"use client";

import { useEffect, useState } from "react";
import { Check, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  THEMES,
  THEME_CHANGE_EVENT,
  applySchemeToDocument,
  applyThemeToDocument,
  currentThemeKey,
  themeDef,
  type ThemeKey,
} from "@/lib/theme";

/**
 * منتقي المظهر: بطاقة لكل ثيم بمعاينة ألوانه + فاتح/داكن.
 *
 * - الثيم الليلي بيفرض الداكن، فزر «فاتح» بيتعطّل ومعه سبب (مش بيختفي بصمت).
 * - الحفظ بالجهاز (`localStorage`) — ما في ترحيل ولا عمود.
 */

/** عرض صرف — الاختبار بيعرضه بخصائص جاهزة. */
export function ThemePickerView({
  theme,
  dark,
  onSelect,
  onScheme,
}: {
  theme: ThemeKey;
  dark: boolean;
  onSelect?: (key: ThemeKey) => void;
  onScheme?: (dark: boolean) => void;
}) {
  const locked = themeDef(theme).forcesDark;
  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="الثيم" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {THEMES.map((t) => {
          const selected = t.key === theme;
          return (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={selected}
              data-theme-card={t.key}
              onClick={() => onSelect?.(t.key)}
              className={cn(
                "group flex flex-col gap-3 rounded-2xl border p-3 text-start transition-colors",
                selected ? "border-primary bg-primary-soft" : "border-line bg-surface-2 hover:bg-surface-hover"
              )}
            >
              {/* معاينة: خلفية · سطح · أساسي · تمييز */}
              <span aria-hidden className="flex h-14 overflow-hidden rounded-lg border border-line" style={{ direction: "ltr" }}>
                {t.swatches.map((c, i) => (
                  <span key={i} className="flex-1" style={{ backgroundColor: c }} />
                ))}
              </span>
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block text-[13px] font-bold text-ink">{t.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-ink-muted">{t.description}</span>
                </span>
                {selected && (
                  <span
                    aria-hidden
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-white"
                  >
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
              </span>
              {t.forcesDark && (
                <span className="w-fit rounded-[4px] bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold text-ink-muted">
                  ليلي دائمًا
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold text-ink-muted">المظهر</p>
        <div role="radiogroup" aria-label="المظهر" className="inline-flex rounded-lg border border-line bg-surface-3 p-0.5">
          {[
            { dark: false, label: "فاتح", Icon: Sun },
            { dark: true, label: "داكن", Icon: Moon },
          ].map(({ dark: d, label, Icon }) => {
            const selected = dark === d;
            const disabled = locked && !d;
            return (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={disabled || undefined}
                disabled={disabled}
                data-scheme={d ? "dark" : "light"}
                onClick={() => onScheme?.(d)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                  selected ? "bg-surface-2 text-ink shadow-xs" : "text-ink-muted hover:text-ink"
                )}
              >
                <Icon size={14} />
                {label}
              </button>
            );
          })}
        </div>
        {locked && (
          <p className="mt-1.5 text-xs text-ink-muted">
            هذا الثيم ليلي بطبيعته (ألوان نيون) — الوضع الفاتح غير متاح له. بترجع لاختيارك لما تبدّل الثيم.
          </p>
        )}
      </div>
    </div>
  );
}

export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeKey>("default");
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const sync = () => {
      setTheme(currentThemeKey());
      setDark(document.documentElement.classList.contains("dark"));
    };
    sync();
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  return (
    <ThemePickerView
      theme={theme}
      dark={dark}
      onSelect={(key) => {
        const r = applyThemeToDocument(key);
        setTheme(r.theme);
        setDark(r.dark);
      }}
      onScheme={(d) => setDark(applySchemeToDocument(d).dark)}
    />
  );
}
