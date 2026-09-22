"use client";

import { MessageSquareText, Package, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { t, timeAgo } from "@/lib/i18n";
import { Avatar } from "../ui/avatar";
import { Badge, StatusBadge } from "../ui/badge";
import { EmptyState } from "../ui/empty-state";
import { Skeleton } from "../ui/skeleton";
import { CHANNEL_ICONS, type ConversationListItem } from "./types";

function ChannelGlyph({ type, className }: { type: string; className?: string }) {
  const Icon = CHANNEL_ICONS[type];
  if (!Icon) return <MessageSquareText size={13} className={className} />;
  return <Icon size={13} className={className} />;
}

export function ConversationItem({
  conversation,
  selected,
  onSelect,
}: {
  conversation: ConversationListItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const c = conversation;
  return (
    <button
      onClick={() => onSelect(c.id)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "block w-full border-b border-line/60 px-3.5 py-3 text-start transition-colors",
        selected ? "bg-brand-50 dark:bg-brand-950/60" : "hover:bg-surface-1 dark:hover:bg-surface-3"
      )}
    >
      <div className="flex items-center gap-2.5">
        {/* Unread indicator bar */}
        <span
          aria-hidden
          className={cn(
            "absolute start-0 top-1/2 h-8 w-1 -translate-y-1/2 rounded-e-full bg-brand-500 transition-opacity",
            c.unreadCount > 0 && !selected ? "opacity-100" : "opacity-0"
          )}
        />
        <div className="relative shrink-0">
          <Avatar name={c.customer.name ?? c.customer.phone} size="sm" />
          <span className="absolute -bottom-0.5 -end-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface-2 text-ink-subtle">
            {(() => {
              const ChIcon = CHANNEL_ICONS[c.channel.type];
              return ChIcon ? <ChIcon size={9} /> : null;
            })()}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[13px] font-semibold text-ink">
              {c.customer.name ?? c.customer.phone ?? "عميل"}
            </span>
            <span className="shrink-0 text-[10px] text-ink-subtle">{timeAgo(c.lastCustomerMessageAt)}</span>
          </div>
          {c.customer.phone && (
            <p className="num mt-0.5 text-[11px] text-ink-subtle">{c.customer.phone}</p>
          )}
          <div className="mt-1.5 flex items-center justify-between gap-1.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              <StatusBadge value={c.status} />
              {c.aiState === "HUMAN_ACTIVE" ? (
                <Badge tone="NORMAL">
                  <UserRound size={10} /> {t.roles.human}
                </Badge>
              ) : (
                <Badge className="bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                  {t.roles.ai}
                </Badge>
              )}
              {(c.priority === "HIGH" || c.priority === "URGENT") && <Badge tone={c.priority}>{c.priority === "URGENT" ? "عاجلة" : "عالية"}</Badge>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-ink-subtle">
              {c.assignedAgent && (
                <span className="hidden max-w-14 truncate sm:inline" title={c.assignedAgent.name}>
                  {c.assignedAgent.name}
                </span>
              )}
              {c.unreadCount > 0 && (
                <span className="num inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-500 px-1.5 text-[10px] font-bold text-white">
                  {c.unreadCount}
                </span>
              )}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

export function ConversationListSkeleton() {
  return (
    <div className="space-y-3 p-3">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <div className="h-8 w-8 animate-pulse rounded-full bg-surface-3" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2.5 w-2/3 animate-pulse rounded bg-surface-3" />
            <div className="h-2 w-1/3 animate-pulse rounded bg-surface-3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ConversationListEmpty({
  isFiltered,
}: {
  isFiltered: boolean;
}) {
  return (
    <EmptyState
      icon={<MessageSquareText size={28} strokeWidth={1.5} />}
      title={isFiltered ? t.inbox.noResultsTitle : t.inbox.emptyListTitle}
      description={isFiltered ? t.inbox.noResultsDesc : t.inbox.emptyListDesc}
    />
  );
}

export function OrderIndicatorBadge() {
  return (
    <Badge className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
      <Package size={10} />
      طلب
    </Badge>
  );
}