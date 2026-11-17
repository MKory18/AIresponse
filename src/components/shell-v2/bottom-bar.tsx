"use client";

import Link from "next/link";
import { Ellipsis } from "lucide-react";
import { cn } from "@/lib/cn";
import { groupLanding, type NavGroupView } from "@/lib/nav-model";
import { NAV_ICONS } from "@/components/nav-icons";
import { CountBadge } from "@/components/ui/count-badge";

/** المجموعات اللي بتظهر بالشريط السفلي بالجوال؛ الباقي بزر «المزيد» (يفتح القائمة). */
export const BOTTOM_BAR_KEYS = ["today", "chats", "orders"] as const;

/** شريط سفلي للجوال (< 768px، 03 §2): اليوم · المحادثات · الطلبات · المزيد — أهداف لمس ≥ 48px. */
export function BottomBar({
  groups,
  activeGroupKey,
  counts,
  onMore,
}: {
  groups: readonly NavGroupView[];
  activeGroupKey: string | null;
  counts: Record<string, number>;
  onMore: () => void;
}) {
  const items = BOTTOM_BAR_KEYS.map((k) => groups.find((g) => g.key === k)).filter((g): g is NavGroupView => !!g);
  const cls = "relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium";
  return (
    <nav aria-label="التنقل السريع" data-bottom-bar className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface-2 pb-[env(safe-area-inset-bottom)] md:hidden">
      {items.map((g) => {
        const Icon = NAV_ICONS[g.icon];
        const active = g.key === activeGroupKey;
        return (
          <Link key={g.key} href={groupLanding(g)} aria-current={active ? "page" : undefined} className={cn(cls, active ? "text-primary" : "text-ink-muted")}>
            {Icon && <Icon size={20} aria-hidden />}
            <span>{g.label}</span>
            <span className="absolute end-1/4 top-1">
              <CountBadge count={counts[g.key] ?? 0} tone="danger" />
            </span>
          </Link>
        );
      })}
      <button type="button" onClick={onMore} className={cn(cls, "text-ink-muted")}>
        <Ellipsis size={20} aria-hidden />
        <span>المزيد</span>
      </button>
    </nav>
  );
}
