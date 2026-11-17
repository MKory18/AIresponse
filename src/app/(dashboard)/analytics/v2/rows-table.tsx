"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Money } from "@/components/ui/formatted";
import { Tooltip } from "@/components/ui/tooltip";
import type { KpiValue } from "@/modules/analytics/kpi-catalog";
import type { KpiOut } from "@/modules/analytics/reports";
import { REPORT_STRINGS as S } from "./strings";

type Row = Record<string, string | number | null>;

function cell(key: string, row: Row): React.ReactNode {
  const v = row[key];
  if (v === null || v === undefined) return <span className="text-ink-subtle">—</span>;
  if (key === "value" && typeof v === "number" && typeof row.currency === "string") return <Money amount={v} currency={row.currency} />;
  if (key === "fix" && typeof row.href === "string") {
    return (
      <Link href={row.href} className="text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus">
        {String(v)}
      </Link>
    );
  }
  if (typeof v === "number") return formatNumber(v, 1);
  return String(v);
}

/** جدول التفصيل (واحد بكل تبويب أو أكتر): أعمدته من الكتالوج، والأرقام لاتينية، والمبالغ بعملتها. المقدّم بطيّ ⓘ للمعادلة. */
export function RowsTable({ k }: { k: KpiOut }) {
  const v = k.value as KpiValue;
  if (v.kind === "unavailable") {
    return (
      <section data-table={k.key} className="rounded-card border border-line bg-surface-2 p-5">
        <h3 className="text-sm font-medium text-ink-muted">{k.label}</h3>
        <p className="mt-2 text-sm text-ink-muted">
          {S.unavailable}: {v.reason}
        </p>
      </section>
    );
  }
  if (v.kind !== "rows") return null;
  const columns: Column<Row>[] = v.columns
    .filter((c) => c.key !== "currency")
    .map((c, i) => ({ key: c.key, header: c.label, align: i === 0 || c.key === "fix" || c.key === "reason" ? "start" : "end", cell: (r: Row) => cell(c.key, r) }));
  return (
    <section data-table={k.key} className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-ink-muted">{k.label}</h3>
        <Tooltip content={`${S.howWeCount}: ${k.formula}`} side="bottom">
          <button type="button" aria-label={`${S.howWeCount}: ${k.label}`} className="rounded-full p-1 text-ink-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
            <Info size={14} aria-hidden />
          </button>
        </Tooltip>
      </div>
      <DataTable<Row>
        columns={columns}
        rows={v.rows}
        rowKey={(r) => columns.map((c) => String(r[c.key] ?? "")).join("|") + String(r.currency ?? "")}
        caption={k.label}
        empty={<p className="px-4 py-6 text-center text-sm text-ink-muted">{S.empty}</p>}
      />
    </section>
  );
}
