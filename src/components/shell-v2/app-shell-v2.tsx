"use client";

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { pageForPath, type NavGroupView } from "@/lib/nav-model";
import { guideForPath } from "@/lib/page-guides";
import { countsByGroup } from "@/lib/attention-counts";
import { GroupTabs, TABS_HEIGHT } from "@/components/group-tabs";
import { PageGuidePanel } from "@/components/page-guide";
import { HealthBannerView } from "@/components/attention/health-banner";
import { useAttention } from "@/components/attention/use-attention";
import { SidebarV2 } from "./sidebar-v2";
import { HeaderV2 } from "./header-v2";
import { BottomBar } from "./bottom-bar";

/**
 * قشرة الواجهة الجديدة (2.3ب، 03 §2): شريط جانبي كحلي بعدّادات · رأس (عنوان · بحث شامل · «يحتاجك» · الحساب) ·
 * شريط العطل · تبويبات المجموعة · شريط سفلي بالجوال. بتتفعّل بـ`uiVersion = v2` والهيكل القديم بيضل لحاله.
 *
 * الشرح: ما بيظهر لحاله — من «شو هاي الصفحة؟» بقائمة الحساب. الجولة: بتنضاف مع مثبّتاتها بحزمة لاحقة.
 */
export function AppShellV2({
  groups,
  workspaceName,
  userName,
  children,
}: {
  groups: NavGroupView[];
  workspaceName: string;
  userName: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const { data } = useAttention();

  const hit = useMemo(() => pageForPath(pathname, groups), [pathname, groups]);
  const tabGroup = hit && hit.group.pages.length > 1 ? hit.group : null;
  const counts = useMemo(() => countsByGroup(data.items, groups), [data.items, groups]);
  const guideHit = useMemo(() => guideForPath(pathname), [pathname]);
  const nextAllowed = guideHit ? groups.some((g) => g.pages.some((p) => p.href === guideHit.guide.next.href)) : false;
  const canTeam = groups.some((g) => g.pages.some((p) => p.href === "/settings/team"));
  // صندوق المحادثات شاشة كاملة بارتفاع محسوب — بلا حشوة، والشرح فوقه طبقة.
  const fullBleed = pathname === "/conversations";

  return (
    <div data-shell="v2" className="min-h-screen bg-surface-1" style={{ "--shell-extra": tabGroup ? TABS_HEIGHT : "0px" } as React.CSSProperties}>
      <SidebarV2
        groups={groups}
        activeGroupKey={hit?.group.key ?? null}
        counts={counts}
        workspaceName={workspaceName}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
      />
      <div className="flex min-h-screen flex-col pb-14 md:pb-0 lg:ps-60">
        <HealthBannerView banner={data.banner} extra={Math.max(0, data.counts.critical - 1)} />
        <div className="sticky top-0 z-20">
          <HeaderV2
            title={hit?.page.label ?? ""}
            groups={groups}
            userName={userName}
            attentionCount={data.counts.total}
            attentionItems={data.items}
            canTeam={canTeam}
            onOpenMenu={() => setMenuOpen(true)}
            onHelp={guideHit ? () => setGuideOpen((o) => !o) : null}
            onTour={null}
          />
          {tabGroup && hit && <GroupTabs group={tabGroup} activeHref={hit.page.href} />}
          {guideOpen && guideHit && fullBleed && (
            <PageGuidePanel guide={guideHit.guide} nextAllowed={nextAllowed} overlay onClose={() => setGuideOpen(false)} />
          )}
        </div>
        {guideOpen && guideHit && !fullBleed && <PageGuidePanel guide={guideHit.guide} nextAllowed={nextAllowed} onClose={() => setGuideOpen(false)} />}
        <main className={cn("min-w-0 flex-1", !fullBleed && "p-4 lg:p-6")}>{children}</main>
      </div>
      <BottomBar groups={groups} activeGroupKey={hit?.group.key ?? null} counts={counts} onMore={() => setMenuOpen(true)} />
    </div>
  );
}
