"use client";

import Link from "next/link";
import { Can } from "@/components/auth/permissions";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Num } from "@/components/ui/formatted";
import { StatusChip } from "@/components/ui/status-chip";
import { useToast } from "@/components/ui/toast";
import { TYPE_META, type ChannelRow } from "../../channels/v2/model";
import { GROUPS_STRINGS as S } from "./strings";
import type { Group } from "./use-groups";

const SELECT = "h-10 w-full min-w-44 rounded-control border border-border-strong bg-surface-2 px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60";

/** جدول «أي منتجات كل صفحة بتبيع؟»: الصفحة · مجموعتها (اختيار بيتحفظ فورًا) · عدد منتجات المجموعة. صفحة بلا مجموعة = تنبيه. */
export function PagesTable({ pages, groups, loading, onAssign }: { pages: ChannelRow[]; groups: Group[]; loading: boolean; onAssign: (p: ChannelRow, groupId: string) => Promise<string | null> }) {
  const toast = useToast();
  const byId = new Map(groups.map((g) => [g.id, g]));

  async function change(p: ChannelRow, value: string) {
    const err = await onAssign(p, value);
    toast.show(err ?? S.saved, err ? "error" : "success");
  }

  const columns: Column<ChannelRow>[] = [
    {
      key: "page",
      header: S.pageCol,
      cell: (p) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-ink">{p.displayName || p.externalId || TYPE_META[p.type]?.name}</span>
          <span className="block text-caption text-ink-muted">{TYPE_META[p.type]?.name ?? p.type}</span>
        </span>
      ),
    },
    {
      key: "group",
      header: S.groupCol,
      cell: (p) => (
        <Can permission="catalogs.assign" fallback={<span className="text-sm text-ink-muted">{p.catalog?.name ?? S.none}</span>}>
          <select aria-label={`${S.groupCol}: ${p.displayName ?? p.type}`} className={SELECT} value={p.catalog?.id ?? ""} onChange={(e) => void change(p, e.target.value)}>
            <option value="">{S.none}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
                {g.isActive ? "" : " (متوقفة)"}
              </option>
            ))}
          </select>
        </Can>
      ),
    },
    {
      key: "count",
      header: S.countCol,
      align: "end",
      cell: (p) => {
        const g = p.catalog ? byId.get(p.catalog.id) : null;
        if (!p.catalog) return <StatusChip tone="danger">{S.noneWarn}</StatusChip>;
        if (!g?.isActive) return <StatusChip tone="warning">متوقفة</StatusChip>;
        return <Num value={g.products} />;
      },
    },
  ];

  return (
    <section className="space-y-2" data-pages-table>
      <h2 className="text-sm font-semibold text-ink">{S.pagesTitle}</h2>
      <DataTable<ChannelRow>
        columns={columns}
        rows={pages}
        rowKey={(p) => p.id}
        loading={loading}
        caption={S.pagesTitle}
        empty={
          <EmptyState
            title={S.pagesEmpty}
            description={S.pagesEmptyHint}
            action={
              <Link href="/channels">
                <Button size="sm" variant="secondary">
                  {S.pagesEmptyAction}
                </Button>
              </Link>
            }
          />
        }
      />
    </section>
  );
}
