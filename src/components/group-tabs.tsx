"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import type { NavGroupView } from "@/lib/nav-model";

/** ارتفاع الشريط — الشل بيطرحه من ارتفاع صندوق الوارد (`--shell-extra`). */
export const TABS_HEIGHT = "2.75rem";

/**
 * شريط تبويبات المجموعة: بيتنقّل بين صفحات نفس الشغلة (الوارد ↔ التحويلات ↔
 * العملاء…) بدون ما ترجع للقائمة الجانبية. مكوّن عرض صرف: المسار النشط بيجي
 * من الشل (اختبار بلا mocks).
 *
 * على الجوال بيتمرّر أفقيًا، والتبويب النشط بيتمركز لحاله.
 */
export function GroupTabs({ group, activeHref }: { group: NavGroupView; activeHref: string }) {
  const activeRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [activeHref]);

  return (
    <div className="border-b border-line bg-surface-2" data-tabs-bar>
      <nav
        aria-label={`صفحات ${group.label}`}
        className="flex items-stretch gap-1 overflow-x-auto px-4 [scrollbar-width:none] lg:px-6"
        style={{ height: TABS_HEIGHT }}
      >
        {group.pages.map((p) => {
          const active = p.href === activeHref;
          return (
            <Link
              key={p.href}
              href={p.href}
              ref={active ? activeRef : undefined}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-[13px] transition-colors",
                active
                  ? "font-bold text-ink after:absolute after:inset-x-2.5 after:bottom-0 after:h-[3px] after:rounded-full after:bg-primary"
                  : "font-medium text-ink-muted hover:bg-surface-hover hover:text-ink"
              )}
            >
              {p.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
