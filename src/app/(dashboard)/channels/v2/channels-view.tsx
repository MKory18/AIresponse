"use client";

import { useEffect, useState } from "react";
import { Plus, Radio } from "lucide-react";
import { api } from "@/lib/api-client";
import { Can } from "@/components/auth/permissions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ChannelCard } from "./channel-card";
import { ConnectDialog } from "./connect-dialog";
import { parsePendingPages, type ChannelRow, type PendingPage } from "./model";
import { CHANNELS_STRINGS as S } from "./strings";
import { useChannels } from "./use-channels";

/**
 * «الصفحات والقنوات» (3.6، 03 §5.6): بطاقة لكل صفحة/قناة بـ4 إعدادات بس (الوضع · الشخصية · مجموعة المنتجات · السوق)،
 * «أعد الربط» للتوكن المنتهي، والتفاصيل التقنية مطوية. بطاقتا الـ OMS وتيليجرام الطلبات انتقلتا لـ«الإعدادات › الربط».
 * بعد OAuth فيسبوك الرابط بيرجع بـ`?fb_pages=` فبنعرض اختيار الصفحة.
 */
export function ChannelsView() {
  const toast = useToast();
  const { rows, personas, catalogs, oauthConfigured, loading, error, reload, save } = useChannels();
  const [connectOpen, setConnectOpen] = useState(false);
  const [initial, setInitial] = useState<"FACEBOOK" | "INSTAGRAM" | "TELEGRAM" | "WHATSAPP">("FACEBOOK");
  const [pending, setPending] = useState<PendingPage[]>([]);
  const [selectionToken, setSelectionToken] = useState<string | null>(null);
  const [toDisconnect, setToDisconnect] = useState<ChannelRow | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const token = p.get("fb_pages");
    if (p.get("fb_error")) toast.show(S.fbError, "error");
    if (token) {
      const pages = parsePendingPages(token);
      if (pages) {
        setPending(pages);
        setSelectionToken(token);
      } else toast.show(S.badToken, "error");
    }
    if (token || p.get("fb_error")) window.history.replaceState({}, "", "/channels");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectPage(pageId: string) {
    if (!selectionToken) return;
    try {
      await api("/api/channels/facebook/select-page", { method: "POST", json: { selectionToken, pageId } });
      setPending([]);
      setSelectionToken(null);
      toast.show(S.pageLinked, "success");
      void reload();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : S.pageFailed, "error");
    }
  }

  async function disconnect(row: ChannelRow) {
    setBusy(true);
    try {
      if (row.type === "FACEBOOK") await api("/api/channels/facebook/disconnect", { method: "POST", json: { pageId: row.externalId } });
      else await api(`/api/channels/${row.type}`, { method: "DELETE", json: row.externalId ? { externalId: row.externalId } : {} });
      toast.show(S.saved, "success");
    } catch (e) {
      toast.show(e instanceof Error ? e.message : S.pageFailed, "error");
    } finally {
      setBusy(false);
      setToDisconnect(null);
      void reload();
    }
  }

  async function test(row: ChannelRow) {
    try {
      await api("/api/channels/facebook/disconnect", { method: "PUT", json: { pageId: row.externalId } });
      toast.show(S.testOk, "success");
    } catch {
      toast.show(S.testFail, "error");
    }
  }

  function reconnect(row: ChannelRow) {
    setInitial(row.type === "INSTAGRAM" || row.type === "TELEGRAM" || row.type === "WHATSAPP" ? row.type : "FACEBOOK");
    setConnectOpen(true);
  }

  return (
    <div data-channels-v2 className="mx-auto max-w-5xl space-y-4">
      <Can permission="channels.connect">
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => {
              setInitial("FACEBOOK");
              setConnectOpen(true);
            }}
          >
            <Plus size={15} aria-hidden /> {S.add}
          </Button>
        </div>
      </Can>

      {pending.length > 0 && (
        <section className="space-y-2 rounded-card border border-primary/40 bg-primary-soft p-4">
          <h2 className="text-sm font-semibold text-ink">{S.pickPage}</h2>
          <ul className="space-y-2">
            {pending.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => void selectPage(p.id)} className="flex w-full items-center justify-between gap-2 rounded-control border border-line bg-surface-2 px-3 py-2 text-start text-sm text-ink hover:border-primary focus-visible:outline-2 focus-visible:outline-focus">
                  <span>{p.name}</span>
                  <span dir="ltr" className="text-caption text-ink-muted">
                    {p.id}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-card border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-ink">
          <span>
            {S.loadError}: {error}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void reload()}>
            {S.retry}
          </Button>
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-72" />
          ))}
        </div>
      ) : rows.length === 0 && !error && pending.length === 0 ? (
        <EmptyState
          icon={<Radio size={28} strokeWidth={1.5} />}
          title={S.empty}
          description={S.emptyHint}
          action={
            <Can permission="channels.connect">
              <Button size="sm" onClick={() => setConnectOpen(true)}>
                <Plus size={14} aria-hidden /> {S.add}
              </Button>
            </Can>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((r) => (
            <ChannelCard key={r.id} row={r} personas={personas} catalogs={catalogs} onSave={save} onReconnect={reconnect} onDisconnect={setToDisconnect} onTest={(x) => void test(x)} />
          ))}
        </div>
      )}

      <ConnectDialog open={connectOpen} initial={initial} oauthConfigured={oauthConfigured} onClose={() => setConnectOpen(false)} onLinked={(m) => (toast.show(m, "success"), void reload())} />
      <ConfirmDialog open={toDisconnect !== null} onClose={() => setToDisconnect(null)} onConfirm={() => toDisconnect && void disconnect(toDisconnect)} title={S.disconnectTitle} body={S.disconnectBody} confirmLabel={S.disconnectConfirm} busy={busy} danger />
    </div>
  );
}
