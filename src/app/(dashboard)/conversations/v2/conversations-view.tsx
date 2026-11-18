"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api-client";
import { Drawer } from "@/components/ui/drawer";
import { useAttention } from "@/components/attention/use-attention";
import { pageNameOf } from "@/components/inbox/types";
import { ListPane } from "./list-pane";
import { SidePanel } from "./side-panel";
import { ThreadPane } from "./thread-pane";
import { NO_FILTERS, attentionConversationCount, type Filters, type ViewTab } from "./model";
import { useConversationList } from "./use-conversation-list";
import { useThread } from "./use-thread";

/**
 * «المحادثات» (3.1، 03 §5.2): قائمة 320 | محادثة | لوحة 340 (بطاقة الطلب أول شي). بالجوال شاشة وحدة تتنقّل:
 * قائمة ← محادثة ← (ملف العميل وبطاقة الطلب بدرج). الرابط `?id=` بيفتح أي محادثة حتى خارج الصفحة المحمّلة.
 * الملف مجرّد تركيب — المنطق بالـhooks (`use-conversation-list` · `use-thread`) والدوال الصرفة بـ`model.ts`.
 */
export function ConversationsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selectedId = params.get("id");
  const [view, setView] = useState<ViewTab>("all");
  const [q, setQ] = useState(params.get("q") ?? "");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [channels, setChannels] = useState<{ id: string; label: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const attention = useAttention();

  const list = useConversationList(view, q, filters, selectedId);
  const { markRead, remove, refresh } = list;
  const thread = useThread(selectedId, markRead);

  useEffect(() => {
    api<{ channels?: Array<{ id: string; displayName?: string | null; externalId?: string | null; type?: string }> }>("/api/channels")
      .then((d) => setChannels((d.channels ?? []).map((c) => ({ id: c.id, label: c.displayName || c.externalId || c.type || c.id }))))
      .catch(() => undefined);
  }, []);

  const select = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set("id", id);
      else next.delete("id");
      next.delete("q");
      setDraft("");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router]
  );

  const changed = useCallback(() => {
    void refresh();
    void thread.reload();
  }, [refresh, thread]);

  const attentionCount = useMemo(() => attentionConversationCount(attention.data.items), [attention.data.items]);
  const selected = list.selected;
  const pageName = selected ? pageNameOf(selected) : null;
  const panel = <SidePanel conversationId={selectedId} customer={thread.customer} setCustomer={thread.setCustomer} pageName={pageName} />;

  return (
    <div data-conversations-v2 className="flex h-[calc(100dvh-4rem-var(--shell-extra,0px))] gap-3">
      <ListPane
        className={cn(selectedId && "max-lg:hidden")}
        items={list.items}
        total={list.total}
        loading={list.loading}
        loadingMore={list.loadingMore}
        error={list.error}
        hasMore={list.hasMore}
        view={view}
        setView={setView}
        q={q}
        setQ={setQ}
        filters={filters}
        setFilters={setFilters}
        channels={channels}
        attentionCount={attentionCount}
        selectedId={selectedId}
        onSelect={select}
        onLoadMore={() => void list.loadMore()}
        onRetry={() => void list.refresh()}
      />
      <ThreadPane
        className={selectedId ? "flex" : "hidden lg:flex"}
        conversation={selected}
        messages={thread.messages}
        loading={thread.loading}
        error={thread.error}
        openHandoff={thread.openHandoff}
        draft={draft}
        setDraft={setDraft}
        onSend={thread.send}
        onNote={thread.note}
        onRetry={(m) => void thread.retry(m)}
        onBack={() => select(null)}
        onOpenPanel={() => setPanelOpen(true)}
        onChanged={changed}
        onDeleted={(id) => {
          remove(id);
          select(null);
        }}
      />
      <aside className="hidden w-[340px] shrink-0 overflow-y-auto rounded-card border border-line bg-surface-2 xl:block" data-side-panel>
        {panel}
      </aside>
      <Drawer open={panelOpen} onClose={() => setPanelOpen(false)} title="ملف العميل وبطاقة الطلب">
        {panelOpen && panel}
      </Drawer>
    </div>
  );
}
