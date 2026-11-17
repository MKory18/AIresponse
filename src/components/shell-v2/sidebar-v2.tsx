"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { groupLanding, type NavGroupView } from "@/lib/nav-model";
import { BrandLogo } from "@/components/brand-logo";
import { NAV_ICONS } from "@/components/nav-icons";
import { CountBadge } from "@/components/ui/count-badge";

function Item({ group, active, count, onNavigate }: { group: NavGroupView; active: boolean; count: number; onNavigate?: () => void }) {
  const Icon = NAV_ICONS[group.icon];
  return (
    <Link
      href={groupLanding(group)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      data-nav-group={group.key}
      className={cn(
        "flex min-h-10 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors duration-150 ease-zaki focus-visible:outline-2 focus-visible:outline-focus",
        active ? "bg-primary text-on-primary" : "text-sidebar-fg hover:bg-sidebar-fg/10"
      )}
    >
      {Icon && <Icon size={18} aria-hidden />}
      <span className="flex-1 truncate">{group.label}</span>
      <CountBadge count={count} tone="danger" />
    </Link>
  );
}

/**
 * الشريط الجانبي للواجهة الجديدة (03 §2): كحلي غامق بالوضعين (هوية Zaki)، أيقونة + اسم + **عدّاد** لما في شغل،
 * واسم المتجر تحت. بالجوال بيصير درج بملء الحاجة (`open`).
 */
export function SidebarV2({
  groups,
  activeGroupKey,
  counts,
  workspaceName,
  open,
  onClose,
}: {
  groups: readonly NavGroupView[];
  activeGroupKey: string | null;
  counts: Record<string, number>;
  workspaceName: string;
  open: boolean;
  onClose: () => void;
}) {
  const main = groups.filter((g) => g.placement === "main");
  const bottom = groups.filter((g) => g.placement === "bottom");
  const body = (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-fg" data-pane="nav">
      <div className="flex h-14 items-center justify-between px-4">
        <span className="flex items-center gap-2 text-sidebar-fg">
          <BrandLogo size="sm" />
          <span className="text-base font-semibold">Zaki</span>
        </span>
        <button type="button" onClick={onClose} aria-label="إغلاق القائمة" className="rounded-control p-2 hover:bg-sidebar-fg/10 lg:hidden">
          <X size={18} />
        </button>
      </div>
      <nav aria-label="القائمة الرئيسية" className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {main.map((g) => (
          <Item key={g.key} group={g} active={g.key === activeGroupKey} count={counts[g.key] ?? 0} onNavigate={onClose} />
        ))}
      </nav>
      <div className="space-y-1 border-t border-sidebar-fg/20 px-3 py-3">
        {bottom.map((g) => (
          <Item key={g.key} group={g} active={g.key === activeGroupKey} count={counts[g.key] ?? 0} onNavigate={onClose} />
        ))}
        {workspaceName && <p className="truncate px-3 pt-2 text-caption text-sidebar-fg">{workspaceName}</p>}
      </div>
    </div>
  );
  return (
    <>
      {/* عرض 240px (w-60) — حشوة القشرة (lg:ps-60) بتعتمد عليه */}
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-60 lg:block">
        {body}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="القائمة">
          <button type="button" aria-label="إغلاق" className="absolute inset-0 bg-ink/50" onClick={onClose} />
          <aside className="absolute inset-y-0 start-0 w-72 max-w-[85vw]">{body}</aside>
        </div>
      )}
    </>
  );
}
