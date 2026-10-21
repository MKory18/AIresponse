"use client";

import { useCallback, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { t } from "@/lib/i18n";
import { THEME_CHANGE_EVENT, applySchemeToDocument, currentThemeKey, themeDef } from "@/lib/theme";

/** Reads the current theme (set pre-paint by the inline script in root layout). */
export function useTheme() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = useCallback(() => {
    const next = !document.documentElement.classList.contains("dark");
    setDark(applySchemeToDocument(next).dark);
  }, []);

  return { dark, toggle };
}

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);
  const [locked, setLocked] = useState(false);

  // بيتزامن مع المنتقي: اختيار ثيم ليلي بيقفل الزر (والعكس).
  useEffect(() => {
    const sync = () => {
      setDark(document.documentElement.classList.contains("dark"));
      setLocked(themeDef(currentThemeKey()).forcesDark);
    };
    sync();
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  function handleClick() {
    const next = !document.documentElement.classList.contains("dark");
    setDark(applySchemeToDocument(next).dark);
  }

  // ⚠️ ثيم ليلي بطبيعته (نيون): الزر معطّل مع تلميح يشرح ليش — بدل زر ما بيعمل شي.
  const label = locked ? "هذا الثيم ليلي دائمًا — بدّل الثيم من «حسابي»" : dark ? t.theme.light : t.theme.dark;

  return (
    <button
      onClick={handleClick}
      disabled={locked}
      aria-label={label}
      title={label}
      className={
        className ??
        "flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      }
    >
      {dark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
