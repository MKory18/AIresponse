"use client";

import { Bot, Facebook, ShoppingBag, Sparkles, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { t, timeAgo } from "@/lib/i18n";
import { Avatar } from "../ui/avatar";
import { Badge, StatusBadge } from "../ui/badge";
import { EmptyState } from "../ui/empty-state";
import { Skeleton } from "../ui/skeleton";
import { CHANNEL_ICONS, avatarOf, displayNameOf, pageNameOf, type ConversationListItem } from "./types";

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
  const ChIcon = CHANNEL_ICONS[c.channel.type];
  const name = displayNameOf(c) ?? t.inbox.unknownCustomer;
  const pageName = pageNameOf(c);
  return (
    <button
      onClick={() => onSelect(c.id)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "relative block w-full rounded-xl px-3 py-3 text-start transition-all duration-150",
        selected
          ? "bg-gradient-to-l from-brand-500/15 to-brand-500/5 shadow-glow ring-1 ring-inset ring-brand-500/20"
          : "hover:bg-surface-3/70"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-2.5 start-0 w-1 rounded-full bg-gradient-to-b from-brand-400 to-brand-600 transition-opacity",
          c.unreadCount > 0 && !selected ? "opacity-100" : "opacity-0"
        )}
      />
      <div className="flex items-center gap-2.5">
        <div className="relative shrink-0">
          <Avatar name={name} src={avatarOf(c)} size="sm" ring={selected} />
          {ChIcon && (
            <span className="glass-subtle absolute -bottom-1 -end-1 flex h-4 w-4 items-center justify-center rounded-full text-ink-muted">
              <ChIcon size={9} />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[13px] font-bold text-ink">
              {name}
            </span>
            <span className="shrink-0 text-[10px] text-ink-subtle">{timeAgo(c.lastCustomerMessageAt)}</span>
          </div>
          {pageName && (
            <p className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold text-brand-600 dark:text-brand-300">
              <Facebook size={10} className="shrink-0" />
              <span className="truncate">{pageName}</span>
            </p>
          )}
          {c.lastMessage?.text ? (
            <p className={cn("mt-0.5 truncate text-[11px]", c.unreadCount > 0 ? "font-semibold text-ink" : "text-ink-subtle")}>{c.lastMessage.text}</p>
          ) : c.customer.phone ? (
            <p className={cn("num mt-0.5 text-[11px]", c.unreadCount > 0 ? "font-semibold text-ink" : "text-ink-subtle")}>{c.customer.phone}</p>
          ) : null}
          <div className="mt-1.5 flex items-center justify-between gap-1.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              <StatusBadge value={c.status} />
              {c.aiState === "HUMAN_ACTIVE" ? (
                <Badge tone="HUMAN_ACTIVE">
                  <UserRound size={10} /> {t.roles.human}
                </Badge>
              ) : (
                <Badge tone="AI_ACTIVE">
                  <Sparkles size={10} /> {t.roles.ai}
                </Badge>
              )}
              {c.hasOpenHandoff && <Badge tone="URGENT" dot>{t.inbox.needsReview}</Badge>}
              {(c.priority === "HIGH" || c.priority === "URGENT") && <Badge tone={c.priority} dot>{c.priority === "URGENT" ? "عاجلة" : "عالية"}</Badge>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {c.assignedAgent && (
                <span className="hidden max-w-14 truncate text-[10px] text-ink-subtle sm:inline" title={c.assignedAgent.name}>
                  {c.assignedAgent.name}
                </span>
              )}
              {c.unreadCount > 0 && (
                <span className="num inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-gradient-to-b from-brand-400 to-brand-600 px-1.5 text-[10px] font-bold text-white shadow-xs">
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
    <div className="space-y-2 p-3">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5 rounded-xl p-1">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-2.5 w-2/3" />
            <Skeleton className="h-2 w-1/3" />
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
      title={isFiltered ? t.inbox.noResultsTitle : t.inbox.emptyListTitle}
      description={isFiltered ? t.inbox.noResultsDesc : t.inbox.emptyListDesc}
    />
  );
}

export function OrderIndicatorBadge() {
  return (
    <Badge tone="DELIVERED">
      <ShoppingBag size={10} />
      طلب
    </Badge>
  );
}

export function AiIndicator() {
  return (
    <Badge tone="AI_ACTIVE">
      <Bot size={10} /> {t.roles.ai}
    </Badge>
  );
}
