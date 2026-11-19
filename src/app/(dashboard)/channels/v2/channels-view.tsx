"use client";

import { useEffect, useState } from "react";
import { Plus, Radio } from "lucide-react";
import { api } from "@/lib/api-client";
import { Can } from "@/components/auth/permissions";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { describeConnectError, type ConnectErrorNote } from "@/modules/channels/facebook/connect-errors";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ChannelCard } from "./channel-card";
import { ConnectDialog } from "./connect-dialog";
import { connectSelected, pagesAtRisk, type ChannelRow, type PendingPage } from "./model";
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
  const [toArchive, setToArchive] = useState<ChannelRow | null>(null);
  const [connectError, setConnectError] = useState<ConnectErrorNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const token = p.get("fb_pages");
    // ⚠️ كل أسباب الفشل كانت رسالة وحدة، فالمالك ما بيعرف إنه الخلل عند ميتا
    // (وضع التطوير · مش أدمن) مش عنا. 🔧 سبب وتصحيح لكل رمز.
    const fbError = p.get("fb_error");
    if (fbError) setConnectError(describeConnectError(fbError));
    if (token) {
      // ⚠️ حمولة الرمز مشفّرة، فالأسماء بتجي من الخادم (مش من فك الرمز بالمتصفح) —
      // وإلا القائمة بتطلع فاضية و«ولا صفحة» وهي موجودة.
      void (async () => {
        try {
          const res = await api<{ pages: PendingPage[] }>("/api/channels/facebook/pending-pages", { method: "POST", json: { selectionToken: token } });
          const pages = res.pages ?? [];
          // ⚠️ رمز صالح بصفر صفحات كان بيخلّي الشاشة فاضية بلا ولا كلمة.
          if (pages.length === 0) setConnectError(describeConnectError("no_pages"));
          else {
            setConnectError(null);
            setPending(pages);
            setChosen(new Set(pages.map((p) => p.id)));
            setSelectionToken(token);
          }
        } catch {
          setConnectError(describeConnectError("selection"));
        }
      })();
    }
    if (token || p.get("fb_error")) window.history.replaceState({}, "", "/channels");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * ربط كل الصفحات المعلّمة مرة وحدة — بدل صفحة وحدة وترمي الباقي.
   * ⚠️ كل صفحة إضافية كانت دورة موافقة جديدة عند فيسبوك، وكل دورة بتعلّم فيها صفحة وحدة
   * بتسحب الوصول من القديمة. 🔧 رمز الاختيار بيحمل كل الصفحات، فبنربط منه اللي بدك.
   */
  async function connectChosen() {
    if (!selectionToken || chosen.size === 0) return;
    setConnecting(true);
    const ids = pending.filter((p) => chosen.has(p.id)).map((p) => p.id);
    const res = await connectSelected(ids, (pageId) => api("/api/channels/facebook/select-page", { method: "POST", json: { selectionToken, pageId } }));
    setConnecting(false);
    if (res.linked.length > 0) toast.show(S.pagesLinked(res.linked.length), "success");
    if (res.failed.length === 0) {
      setConnectError(null);
      setPending([]);
      setSelectionToken(null);
      setChosen(new Set());
    } else {
      // اللي فشلوا بيضلوا معلّمين بالقائمة عشان المالك يعيد بكبسة وحدة (الرمز ساري ١٠ دقايق).
      const names = res.failed.map((f) => pending.find((p) => p.id === f.id)?.name ?? f.id).join("، ");
      setPending(pending.filter((p) => !res.linked.includes(p.id)));
      setChosen(new Set(res.failed.map((f) => f.id)));
      setConnectError({ risk: S.partialRisk(names, res.failed[0].message), fix: S.partialFix });
    }
    void reload();
  }

  function toggleChosen(id: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  /**
   * شيل صفحة موقوفة من القائمة. ⚠️ مش حذف: صف القناة بيضل، لأنه حذفه بيجرّ
   * معه كل محادثاتها وطلباتها (`onDelete: Cascade`).
   */
  async function archive(row: ChannelRow) {
    setBusy(true);
    try {
      await api("/api/channels/facebook", { method: "DELETE", json: { pageId: row.externalId, disconnect: row.status === "CONNECTED" } });
      toast.show(S.archived, "success");
    } catch (e) {
      toast.show(e instanceof Error ? e.message : S.pageFailed, "error");
    } finally {
      setBusy(false);
      setToArchive(null);
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

  const atRisk = pagesAtRisk(pending, rows);

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

      {connectError && <Callout risk={connectError.risk} fix={connectError.fix} />}

      {pending.length > 0 && (
        <section className="space-y-3 rounded-card border border-primary/40 bg-primary-soft p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">{S.pickPages}</h2>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setChosen(new Set(pending.map((p) => p.id)))}>
                {S.selectAll}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setChosen(new Set())}>
                {S.selectNone}
              </Button>
            </div>
          </div>
          <p className="text-caption text-ink-muted">{S.pickPagesHint}</p>
          {atRisk.length > 0 && <Callout risk={S.atRiskRisk(atRisk.map((r) => r.displayName || r.externalId).join("، "))} fix={S.atRiskFix} />}
          <ul className="space-y-2">
            {pending.map((p) => (
              <li key={p.id}>
                <label className="flex w-full cursor-pointer items-center gap-3 rounded-control border border-line bg-surface-2 px-3 py-2 text-sm text-ink hover:border-primary">
                  <input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggleChosen(p.id)} className="h-4 w-4 accent-primary" />
                  <span className="flex-1">{p.name}</span>
                  <span dir="ltr" className="text-caption text-ink-muted">
                    {p.id}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <Button size="sm" onClick={() => void connectChosen()} disabled={connecting || chosen.size === 0}>
            {connecting ? S.connecting : `${S.connectChosen} (${chosen.size})`}
          </Button>
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
            <ChannelCard key={r.id} row={r} personas={personas} catalogs={catalogs} onSave={save} onReconnect={reconnect} onDisconnect={setToDisconnect} onArchive={setToArchive} onTest={(x) => void test(x)} />
          ))}
        </div>
      )}

      <ConnectDialog open={connectOpen} initial={initial} oauthConfigured={oauthConfigured} onClose={() => setConnectOpen(false)} onLinked={(m) => (toast.show(m, "success"), void reload())} />
      <ConfirmDialog open={toDisconnect !== null} onClose={() => setToDisconnect(null)} onConfirm={() => toDisconnect && void disconnect(toDisconnect)} title={S.disconnectTitle} body={S.disconnectBody} confirmLabel={S.disconnectConfirm} busy={busy} danger />
      <ConfirmDialog
        open={toArchive !== null}
        onClose={() => setToArchive(null)}
        onConfirm={() => toArchive && void archive(toArchive)}
        title={toArchive?.status === "CONNECTED" ? S.archiveConnectedTitle : S.archiveTitle}
        body={toArchive?.status === "CONNECTED" ? S.archiveConnectedBody : S.archiveBody}
        confirmLabel={toArchive?.status === "CONNECTED" ? S.archiveConnectedConfirm : S.archiveConfirm}
        busy={busy}
        danger
      />
    </div>
  );
}
