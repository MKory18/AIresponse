"use client";

import { Button } from "@/components/ui/button";
import { GroupsTable } from "./groups-table";
import { PagesTable } from "./pages-table";
import { GROUPS_STRINGS as S } from "./strings";
import { useGroups } from "./use-groups";

/**
 * «مجموعات الصفحات» (3.4ج، 03 §5.4): السؤال اللي بتجاوبه الصفحة مكتوب فوق — «أي منتجات كل صفحة بتبيع؟» — وتحته جدول
 * الصفحات ومجموعاتها (اختيار فوري)، وتحته إدارة المجموعات. صفحة بلا مجموعة بتطلع كبند «يحتاجك» كمان.
 */
export function CatalogsView() {
  const g = useGroups();
  return (
    <div data-catalogs-v2 className="mx-auto max-w-5xl space-y-6">
      <header>
        <h2 className="text-lg font-semibold text-ink">{S.question}</h2>
        <p className="mt-1 text-sm text-ink-muted">{S.questionHint}</p>
      </header>

      {g.error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-card border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-ink">
          <span>
            {S.loadError}: {g.error}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void g.reload()}>
            {S.retry}
          </Button>
        </div>
      )}

      <PagesTable pages={g.pages} groups={g.groups} loading={g.loading} onAssign={g.assign} />
      <GroupsTable groups={g.groups} loading={g.loading} onToggle={g.toggle} onCreate={g.create} onRemove={g.remove} />
    </div>
  );
}
