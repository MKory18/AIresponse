"use client";

import { MapPin, Package, Phone, Sparkles, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatNumber, label, t, timeAgo } from "@/lib/i18n";
import { Avatar } from "../ui/avatar";
import { Badge, StatusBadge } from "../ui/badge";
import { Card } from "../ui/card";
import { EmptyState } from "../ui/empty-state";
import { CHANNEL_LABELS, type CustomerDetail, type DraftInfo } from "./types";

export function CustomerPanel({
  customer,
  orderDraft,
}: {
  customer: CustomerDetail | null;
  orderDraft: DraftInfo | null;
}) {
  if (!customer) {
    return <EmptyState title={t.customer.noSelection} className="h-full" />;
  }

  return (
    <div className="space-y-3 p-4">
      {/* Identity */}
      <div className="flex flex-col items-center gap-2 border-b border-line pb-4 text-center">
        <Avatar name={customer.name ?? customer.phone} size="lg" />
        <div>
          <p className="text-sm font-bold text-ink">{customer.name ?? "بدون اسم"}</p>
          {customer.phone && (
            <p className="num mt-0.5 text-xs text-ink-muted" dir="ltr">
              {customer.phone}
            </p>
          )}
          <div className="mt-1.5 flex justify-center">
            <StatusBadge value={customer.status} />
          </div>
        </div>
      </div>

      {/* Contact info */}
      <div className="space-y-1.5 text-xs">
        {customer.province && <Row icon={<MapPin size={11} className="shrink-0 text-ink-subtle" />} text={`${t.customer.province}: ${customer.province}`} />}
        {customer.address && <Row text={`${t.customer.address}: ${customer.address}`} />}
        {customer.identities.length > 0 && (
          <div className="pt-1">
            <p className="mb-1 font-semibold text-ink-muted">{t.customer.identities}</p>
            <div className="flex flex-wrap gap-1">
              {customer.identities.map((i) => (
                <Badge key={i.id} tone="OPEN">
                  {CHANNEL_LABELS[i.channelType] ?? i.channelType}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {customer.tags.length > 0 && (
          <div className="pt-1">
            <p className="mb-1 font-semibold text-ink-muted">{t.customer.tags}</p>
            <div className="flex flex-wrap gap-1">
              {customer.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Orders */}
      <Card className="p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
          <Package size={13} className="text-ink-subtle" /> {t.customer.recentOrders}
        </p>
        {customer.orders.length === 0 ? (
          <p className="text-[11px] text-ink-subtle">{t.customer.noOrders}</p>
        ) : (
          <div className="space-y-2">
            {customer.orders.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="num font-medium text-ink">{o.orderNumber}</span>
                <StatusBadge value={o.status} />
                <span className="num text-ink-muted">{formatNumber(o.total)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Order draft */}
      {orderDraft && <OrderDraftCard draft={orderDraft} />}

      {/* AI summary */}
      <Card className="border-violet-200/70 bg-violet-50/60 p-3 dark:border-violet-900 dark:bg-violet-950/40">
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
          <Sparkles aria-hidden className="opacity-70" size={13} /> {t.inbox.aiSummary}
        </p>
        <p className="text-[11px] leading-relaxed text-violet-800 dark:text-violet-300">
          {customer.aiSummary ?? t.inbox.aiSummaryEmpty}
        </p>
      </Card>
    </div>
  );
}

function OrderDraftCard({ draft }: { draft: DraftInfo }) {
  const complete = draft.missingFields.length === 0;
  return (
    <Card className={complete ? "border-emerald-200/70 bg-emerald-50/50 p-3 dark:border-emerald-900 dark:bg-emerald-950/30" : "border-amber-200/70 bg-amber-50/50 p-3 dark:border-amber-900 dark:bg-amber-950/30"}>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-ink">
        <Package size={13} className="text-brand-500" /> {t.inbox.draftTitle}
        <StatusBadge value={draft.state} />
      </p>
      <div className="space-y-1 text-[11px] text-ink-muted">
        {draft.productName && <Row text={`${t.customer.product}: ${draft.productName}`} />}
        {draft.quantity && <Row text={`${t.customer.quantity}: ${formatNumber(draft.quantity)}`} />}
        <Row icon={<Phone size={11} />} text={draft.phone ? `${t.customer.phone}: ✓` : `${t.customer.phone}: —`} ok={Boolean(draft.phone)} />
        <Row
          icon={<MapPin size={11} />}
          text={`${t.customer.address}: ${draft.rawAddress || draft.province ? "✓" : "—"}`}
          ok={Boolean(draft.rawAddress || draft.province)}
        />
      </div>
      {draft.missingFields.length > 0 ? (
        <p className="mt-1.5 text-[10px] text-amber-700 dark:text-amber-400">
          {t.inbox.draftMissing}: {draft.missingFields.join("، ")}
        </p>
      ) : (
        <p className="mt-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">{t.inbox.draftReady}</p>
      )}
    </Card>
  );
}

function Row({ icon, text, ok }: { icon?: React.ReactNode; text: string; ok?: boolean }) {
  return (
    <p className={ok === false ? "text-amber-700 dark:text-amber-400" : "text-ink-muted"}>
      {icon}
      {text}
    </p>
  );
}