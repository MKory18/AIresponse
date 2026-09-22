"use client";

import { useCallback, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { t } from "@/lib/i18n";

/** Reads the current theme (set pre-paint by the inline script in root layout). */
export function useTheme() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = useCallback(() => {
    const dark = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, []);

  return { dark, toggle };
}

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function handleClick() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
    setDark(next);
  }

  return (
    <button
      onClick={handleClick}
      aria-label={dark ? t.theme.light : t.theme.dark}
      title={dark ? t.theme.light : t.theme.dark}
      className={className ?? "flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition hover:bg-surface-3 hover:text-ink"}
    >
      {dark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}