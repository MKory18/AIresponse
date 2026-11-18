"use client";

import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { Countdown } from "@/components/ui/countdown";
import { Money } from "@/components/ui/formatted";
import { StatusChip, type Tone } from "@/components/ui/status-chip";
import type { RecentOrder, SettlingOrder } from "@/modules/today/service";
import { TODAY_STRINGS as S } from "./strings";

/** نبرة حالة الطلب (من `orderStatusLabel`) ← نبرة الشريحة بالعدّة الجديدة. */
const TONE: Record<string, Tone> = { info: "info", warn: "warning", ok: "success", bad: "danger", muted: "neutral" };

/** «بتتثبّت هلأ»: طلبات بمهلة التثبيت، مع عدّاد تنازلي لكل واحد. الخادم هو الحكم على التثبيت — العدّاد للعرض. */
export function SettlingList({ rows }: { rows: readonly SettlingOrder[] }) {
  if (rows.length === 0) return <p data-settling-empty className="px-5 py-6 text-sm text-ink-muted">{S.settlingEmpty}</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((o) => (
        <li key={o.id}>
          <Link
            href={`/orders?order=${o.id}`}
            className="flex items-center gap-3 px-5 py-3 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Countdown until={o.settleAt} label="" doneLabel="جاهز" className="shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{o.recipientName ?? o.orderNumber}</span>
              <span className="block truncate text-caption text-ink-muted">{o.items || o.orderNumber}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** «آخر الطلبات»: 5 طلبات بحالة وحدة من `orderStatusLabel` وقيمة بعملتها. */
export function RecentList({ rows }: { rows: readonly RecentOrder[] }) {
  if (rows.length === 0) {
    return <EmptyState title={S.recentEmpty} action={<Link href="/orders" className="text-sm font-semibold text-primary hover:underline">{S.recentEmptyAction}</Link>} />;
  }
  return (
    <ul className="divide-y divide-line">
      {rows.map((o) => (
        <li key={o.id}>
          <Link
            href={`/orders?order=${o.id}`}
            className="flex items-center gap-3 px-5 py-3 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink" dir="ltr">
              {o.orderNumber}
            </span>
            <StatusChip tone={TONE[o.statusTone] ?? "neutral"}>{o.status}</StatusChip>
            <Money amount={o.total} currency={o.currency} className="shrink-0 text-sm text-ink" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
