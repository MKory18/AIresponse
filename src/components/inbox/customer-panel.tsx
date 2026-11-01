"use client";

import Link from "next/link";
import { Facebook, MapPin, Package, Phone, Sparkles } from "lucide-react";
import { formatNumber, label, t, timeAgo } from "@/lib/i18n";
import { Avatar } from "../ui/avatar";
import { Badge, StatusBadge } from "../ui/badge";
import { GlassCard } from "../ui/card";
import { EmptyState } from "../ui/empty-state";
import { CHANNEL_LABELS, type CustomerDetail, type DraftInfo } from "./types";
import { MarketingCard } from "./marketing-card";

export function CustomerPanel({
  customer,
  orderDraft,
  pageName,
}: {
  customer: CustomerDetail | null;
  orderDraft: DraftInfo | null;
  pageName?: string | null;
}) {
  if (!customer) {
    return <EmptyState title={t.customer.noSelection} className="h-full" />;
  }

  return (
    <div className="space-y-3 p-4">
      {/* Identity — same resolved name as list + header, never a divergent fallback */}
      <div className="glass-subtle flex flex-col items-center gap-2 rounded-2xl px-3 pb-4 pt-5 text-center">
        <Avatar name={customer.name ?? customer.phone} src={customer.avatarUrl ?? customer.identities.map((i) => i.avatarUrl).find(Boolean) ?? null} size="lg" ring />
        <div>
          <p className="text-sm font-bold text-ink">
            {customer.name ??
              customer.identities.map((i) => i.displayName).find(Boolean) ??
              customer.phone ??
              t.inbox.unknownCustomer}
          </p>
          {customer.phone && (
            <p className="num mt-0.5 text-xs text-ink-muted" dir="ltr">
              {customer.phone}
            </p>
          )}
          {pageName && (
            <p className="mt-1.5 flex items-center justify-center gap-1 text-[11px] font-semibold text-brand-600 dark:text-brand-300">
              <Facebook size={11} />
              {pageName}
            </p>
          )}
          <div className="mt-2 flex justify-center gap-1.5">
            <StatusBadge value={customer.status} dot />
            {customer.isBlacklisted && (
              <Badge tone="FAILED" dot>
                قائمة سوداء{customer.blacklistSource ? ` · ${customer.blacklistSource}` : ""}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Contact info */}
      <GlassCard level="glass-subtle" className="space-y-2 p-3.5 text-xs">
        <p className="section-title">{t.customer.panelTitle}</p>
        {customer.email && <Row text={`البريد الإلكتروني: ${customer.email}`} />}
        {customer.province && <Row icon={<MapPin size={12} className="shrink-0 text-ink-subtle" />} text={`${t.customer.province}: ${customer.province}`} />}
        {customer.address && <Row text={`${t.customer.address}: ${customer.address}`} />}
        {customer.conversations.length > 0 && (
          <Row text={`${t.nav.conversations}: ${formatNumber(customer.conversations.length)} · ${t.customer.lastActivity}: ${timeAgo(customer.conversations[0]?.updatedAt)}`} />
        )}
        {customer.identities.length > 0 && (
          <div className="pt-1">
            <p className="mb-1.5 text-[11px] font-bold text-ink-muted">{t.customer.identities}</p>
            <div className="flex flex-wrap gap-1">
              {customer.identities.map((i) => (
                <Badge key={i.id} tone="OPEN" title={i.displayName ?? undefined}>
                  {CHANNEL_LABELS[i.channelType] ?? i.channelType}
                  {i.displayName ? ` · ${i.displayName}` : ""}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {customer.tags.length > 0 && (
          <div className="pt-1">
            <p className="mb-1.5 text-[11px] font-bold text-ink-muted">{t.customer.tags}</p>
            <div className="flex flex-wrap gap-1">
              {customer.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          </div>
        )}
      </GlassCard>

      {/* P12 — موافقة الرسائل التسويقية ومصدر الزبون */}
      <MarketingCard customerId={customer.id} />

      {/* Orders */}
      <GlassCard level="glass-subtle" className="p-3.5">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-ink">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <Package size={13} />
          </span>
          {t.customer.recentOrders}
        </p>
        {customer.orders.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-ink-subtle">{t.customer.noOrders}</p>
        ) : (
          <div className="space-y-1">
            {customer.orders.map((o) => (
              <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-[11px] transition hover:bg-surface-3/70">
                <span className="num font-bold text-ink">{o.orderNumber}</span>
                <StatusBadge value={o.status} />
                <span className="num text-ink-muted">{formatNumber(o.total)}</span>
              </Link>
            ))}
            {customer.orders.some((o) => o.adSource) && (
              <p className="px-2 pt-1 text-[10px] text-ink-subtle">
                مصدر الاكتساب: {customer.orders.map((o) => o.adSource).find(Boolean)}
              </p>
            )}
          </div>
        )}
      </GlassCard>

      {/* Order draft */}
      {orderDraft && <OrderDraftCard draft={orderDraft} />}

      {/* AI summary */}
      <div className="rounded-2xl border border-sky-500/20 bg-gradient-to-b from-sky-500/10 to-sky-500/5 p-3.5 dark:border-sky-400/20">
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-sky-700 dark:text-sky-300">
          <Sparkles aria-hidden size={13} /> {t.inbox.aiSummary}
        </p>
        <p className="text-[11px] leading-relaxed text-sky-900/80 dark:text-sky-200/80">
          {customer.aiSummary ?? t.inbox.aiSummaryEmpty}
        </p>
      </div>

      {/* Timeline */}
      {customer.conversations.length > 1 && (
        <GlassCard level="glass-subtle" className="p-3.5">
          <p className="mb-2 text-xs font-bold text-ink">النشاط الأخير</p>
          <ol className="relative space-y-2.5 border-s border-line ps-4">
            {customer.conversations.slice(0, 5).map((c) => (
              <li key={c.id} className="text-[11px]">
                <span aria-hidden className="absolute -start-[5px] mt-1 h-2 w-2 rounded-full bg-brand-500 ring-2 ring-surface-2" />
                <p className="font-semibold text-ink">{label(c.status)}</p>
                <p className="text-ink-subtle">{timeAgo(c.updatedAt)}</p>
              </li>
            ))}
          </ol>
        </GlassCard>
      )}
    </div>
  );
}

function OrderDraftCard({ draft }: { draft: DraftInfo }) {
  const complete = draft.missingFields.length === 0;
  const pct = complete ? 100 : Math.round(((4 - draft.missingFields.length) / 4) * 100);
  return (
    <div className={
      complete
        ? "rounded-2xl border border-emerald-500/20 bg-gradient-to-b from-emerald-500/10 to-emerald-500/5 p-3.5 dark:border-emerald-400/20"
        : "rounded-2xl border border-amber-500/20 bg-gradient-to-b from-amber-500/10 to-amber-500/5 p-3.5 dark:border-amber-400/20"
    }>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-ink">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
          <Package size={13} />
        </span>
        {t.inbox.draftTitle}
        <StatusBadge value={draft.state} />
      </p>
      <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={complete ? "h-full rounded-full bg-gradient-to-l from-emerald-400 to-emerald-600 transition-all" : "h-full rounded-full bg-gradient-to-l from-amber-400 to-amber-600 transition-all"}
          style={{ width: `${pct}%` }}
        />
      </div>
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
        <p className="mt-1.5 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400">
          {t.inbox.draftMissing}: {draft.missingFields.join("، ")}
        </p>
      ) : (
        <p className="mt-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-400">{t.inbox.draftReady}</p>
      )}
    </div>
  );
}

function Row({ icon, text, ok }: { icon?: React.ReactNode; text: string; ok?: boolean }) {
  return (
    <p className={ok === false ? "flex items-center gap-1.5 text-amber-700 dark:text-amber-400" : "flex items-center gap-1.5 text-ink-muted"}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{text}</span>
    </p>
  );
}
