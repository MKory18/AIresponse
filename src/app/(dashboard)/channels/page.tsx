"use client";

import { useCallback, useEffect, useState } from "react";
import { Facebook, PlugZap, Unplug } from "lucide-react";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";

type Connection = {
  channelId: string;
  pageId: string | null;
  pageName: string | null;
  status: string;
  connectedAt: string | null;
  lastWebhookAt: string | null;
  lastSendAt: string | null;
  tokenStatus: string;
};

export default function ChannelsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [oauthConfigured, setOauthConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingPages, setPendingPages] = useState<{ id: string; name: string }[]>([]);
  const [selectionToken, setSelectionToken] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [confirmPageId, setConfirmPageId] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/channels/facebook");
    if (res.ok) {
      const data = await res.json();
      setConnections(data.connections);
      setOauthConfigured(data.oauthConfigured);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // OAuth callback may land here with ?fb_pages=<token> for page selection
    const params = new URLSearchParams(window.location.search);
    const fbPages = params.get("fb_pages");
    const fbError = params.get("fb_error");
    if (fbError) {
      setMessage("فشل ربط الصفحة — حاول مجددًا.");
      window.history.replaceState({}, "", "/channels");
    }
    if (fbPages) {
      // Decode pages client-side only for display; selection POST verifies the token.
      try {
        const payload = JSON.parse(atob(fbPages.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        setPendingPages((payload.pages ?? []).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })));
        setSelectionToken(fbPages);
      } catch {
        setMessage("رمز اختيار الصفحة غير صالح.");
      }
      window.history.replaceState({}, "", "/channels");
    }
  }, [load]);

  async function selectPage(pageId: string) {
    if (!selectionToken) return;
    const res = await fetch("/api/channels/facebook/select-page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectionToken, pageId }),
    });
    if (res.ok) {
      setPendingPages([]);
      setSelectionToken(null);
      setMessage("تم ربط الصفحة بنجاح.");
      load();
    } else {
      const data = await res.json().catch(() => ({}));
      setMessage(data.message ?? "فشل ربط الصفحة");
    }
  }

  async function disconnect(pageId: string) {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/channels/facebook/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId }),
      });
      setMessage(res.ok ? "تمت إزالة ربط الصفحة." : "تعذر إزالة ربط الصفحة — حاول مجددًا.");
    } catch {
      setMessage("تعذر إزالة ربط الصفحة — حاول مجددًا.");
    } finally {
      setDisconnecting(false);
      setConfirmPageId(null);
      load();
    }
  }

  async function testConnection(pageId: string) {
    setTesting(pageId);
    const res = await fetch("/api/channels/facebook/disconnect", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageId }),
    });
    setTesting(null);
    setMessage(res.ok ? "الاتصال سليم." : "فشل اختبار الاتصال");
  }

  return (
    <div className="page-wrap">
      <PageHeader title={t.pages.channelsTitle} description={t.pages.channelsDesc} />
      {message && (
        <GlassCard level="glass-subtle" className="border-brand-500/20 px-4 py-2.5 text-sm font-medium text-brand-700 dark:text-brand-300">
          {message}
        </GlassCard>
      )}

      {pendingPages.length > 0 && (
        <GlassCard className="space-y-2 p-4">
          <h2 className="text-sm font-bold text-ink">اختر الصفحة المرتبطة</h2>
          {pendingPages.map((p) => (
            <button
              key={p.id}
              onClick={() => selectPage(p.id)}
              className="glass-subtle block w-full rounded-xl p-3 text-right text-sm font-medium text-ink transition hover:border-brand-400 hover:shadow-glass"
            >
              {p.name} <span className="num text-xs text-ink-subtle" dir="ltr">({p.id})</span>
            </button>
          ))}
        </GlassCard>
      )}

      <GlassCard className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 text-white shadow-glow">
              <Facebook size={20} />
            </span>
            <div>
              <h2 className="text-sm font-bold text-ink">Facebook Messenger</h2>
              <p className="mt-0.5 text-xs text-ink-muted">ربط صفحة فيسبوك رسميًا عبر Meta Graph API.</p>
            </div>
          </div>
          {oauthConfigured && (
            <a
              href="/api/channels/facebook/connect"
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-gradient-to-b from-brand-400 to-brand-600 px-3.5 text-[13px] font-semibold text-white shadow-xs transition hover:brightness-110"
            >
              <PlugZap size={14} />
              ربط صفحة Facebook
            </a>
          )}
        </div>
        {!oauthConfigured && (
          <p className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300">
            META_APP_ID و META_APP_SECRET غير مضبوطين على الخادم — أضفهما لتفعيل الربط.
          </p>
        )}
      </GlassCard>

      {loading && <Skeleton className="h-36 rounded-2xl" />}
      {connections.map((c) => (
        <GlassCard key={c.channelId} className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold text-ink">{c.pageName ?? "صفحة فيسبوك"}</p>
              <p className="num mt-0.5 text-xs text-ink-subtle" dir="ltr">{c.pageId}</p>
            </div>
            <StatusBadge value={c.status} dot />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-ink-muted md:grid-cols-4">
            <p>آخر Webhook: {c.lastWebhookAt ? new Date(c.lastWebhookAt).toLocaleString("ar") : "—"}</p>
            <p>آخر إرسال: {c.lastSendAt ? new Date(c.lastSendAt).toLocaleString("ar") : "—"}</p>
            <p>حالة التوكن: {c.tokenStatus}</p>
            <p>رُبطت: {c.connectedAt ? new Date(c.connectedAt).toLocaleDateString("ar") : "—"}</p>
          </div>
          <div className="mt-3 flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => testConnection(c.pageId!)} loading={testing === c.pageId} disabled={testing === c.pageId}>
              {testing === c.pageId ? "جارٍ الاختبار…" : "اختبار الاتصال"}
            </Button>
            {c.status === "CONNECTED" && (
              <Button size="sm" variant="ghost" onClick={() => setConfirmPageId(c.pageId!)} className="text-red-600 hover:bg-red-500/10 dark:text-red-400">
                <Unplug size={13} />
                إزالة الربط
              </Button>
            )}
          </div>
        </GlassCard>
      ))}
      {!loading && connections.length === 0 && pendingPages.length === 0 && (
        <GlassCard>
          <EmptyState
            icon={<Facebook size={28} strokeWidth={1.5} />}
            title="لا توجد قنوات مربوطة"
            description="اربط صفحة فيسبوك لبدء استقبال رسائل العملاء."
          />
        </GlassCard>
      )}
      {confirmPageId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" dir="rtl">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900">
            <h2 className="text-base font-bold text-ink">إزالة ربط الصفحة؟</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">
              سيتم إيقاف اتصال هذه الصفحة بالنظام ولن يتم استقبال رسائل جديدة منها. لن يتم حذف المحادثات أو العملاء أو الطلبات السابقة.
            </p>
            <div className="mt-4 flex justify-start gap-2">
              <Button size="sm" variant="secondary" onClick={() => setConfirmPageId(null)} disabled={disconnecting}>
                تراجع
              </Button>
              <Button
                size="sm"
                className="bg-red-600 text-white hover:bg-red-700"
                onClick={() => disconnect(confirmPageId)}
                loading={disconnecting}
                disabled={disconnecting}
              >
                {disconnecting ? "جارٍ إزالة الربط…" : "إزالة الربط"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
