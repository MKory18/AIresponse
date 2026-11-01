"use client";

import { useCallback, useEffect, useState } from "react";
import { Facebook, PlugZap, Unplug } from "lucide-react";
import { MultiChannelSection } from "./multi-channel-section";
import { CatalogPageSection } from "./catalog-page-section";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { ConfirmDialog, ErrorState } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";

type Connection = {
  channelId: string;
  pageId: string | null;
  pageName: string | null;
  status: string;
  aiPersonaId: string | null;
  connectedAt: string | null;
  lastWebhookAt: string | null;
  lastSendAt: string | null;
  tokenStatus: string;
};

type PersonaOption = { id: string; name: string };

export default function ChannelsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [personas, setPersonas] = useState<PersonaOption[]>([]);
  const [personaDrafts, setPersonaDrafts] = useState<Record<string, string>>({});
  const [savingPersona, setSavingPersona] = useState<string | null>(null);
  const [oauthConfigured, setOauthConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingPages, setPendingPages] = useState<{ id: string; name: string }[]>([]);
  const [selectionToken, setSelectionToken] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [confirmPageId, setConfirmPageId] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // أخطاء تظهر بخطورة حمراء، نجاحات بلون العلامة — لا خلط بينهما (P11).
  const [messageIsError, setMessageIsError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [connRes, personaRes] = await Promise.all([
        fetch("/api/channels/facebook"),
        fetch("/api/personas"),
      ]);
      if (connRes.ok) {
        const data = await connRes.json();
        setConnections(data.connections);
        setOauthConfigured(data.oauthConfigured);
      } else {
        setError("تعذّر تحميل القنوات المربوطة");
      }
      if (personaRes.ok) {
        const data = await personaRes.json();
        const list = (data.items ?? data.personas ?? []) as PersonaOption[];
        setPersonas(list.map((p) => ({ id: p.id, name: p.name })));
      }
    } catch {
      setError("تعذّر تحميل القنوات المربوطة");
    } finally {
      setLoading(false);
    }
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
      setMessageIsError(false);
      setMessage("تم ربط الصفحة بنجاح.");
      load();
    } else {
      const data = await res.json().catch(() => ({}));
      setMessageIsError(true);
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
      setMessageIsError(!res.ok);
      setMessage(res.ok ? "تمت إزالة ربط الصفحة." : "تعذر إزالة ربط الصفحة — حاول مجددًا.");
    } catch {
      setMessageIsError(true);
      setMessage("تعذر إزالة ربط الصفحة — حاول مجددًا.");
    } finally {
      setDisconnecting(false);
      setConfirmPageId(null);
      load();
    }
  }

  async function savePersona(pageId: string) {
    const aiPersonaId = personaDrafts[pageId] ?? "";
    setSavingPersona(pageId);
    const res = await fetch("/api/channels/facebook", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageId, aiPersonaId: aiPersonaId || null }),
    });
    setSavingPersona(null);
    setMessageIsError(!res.ok);
    setMessage(res.ok ? "تم حفظ شخصية الذكاء الاصطناعي للصفحة." : "تعذّر حفظ الشخصية — تحقق من الصلاحيات وحاول مجددًا.");
    if (res.ok) load();
  }

  async function testConnection(pageId: string) {
    setTesting(pageId);
    const res = await fetch("/api/channels/facebook/disconnect", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageId }),
    });
    setTesting(null);
    setMessageIsError(!res.ok);
    setMessage(res.ok ? "الاتصال سليم." : "فشل اختبار الاتصال — قد يكون التوكن منتهيًا أو الصفحة غير متاحة.");
  }

  return (
    <div className="page-wrap">
      <PageHeader title={t.pages.channelsTitle} description={t.pages.channelsDesc} />
      {message && (
        <GlassCard
          level="glass-subtle"
          className={
            messageIsError
              ? "border-red-500/25 bg-red-500/[0.06] px-4 py-2.5 text-sm font-medium text-red-700 dark:text-red-300"
              : "border-brand-500/20 px-4 py-2.5 text-sm font-medium text-brand-700 dark:text-brand-300"
          }
          role="status"
        >
          {message}
        </GlassCard>
      )}
      {error && !loading && (
        <GlassCard>
          <ErrorState onRetry={load} />
        </GlassCard>
      )}

      {pendingPages.length > 0 && (
        <GlassCard className="space-y-2 p-4">
          <h2 className="text-sm font-bold text-ink">اختر الصفحة المرتبطة</h2>
          {pendingPages.map((p) => (
            <button
              key={p.id}
              onClick={() => selectPage(p.id)}
              className="glass-subtle block w-full rounded-xl p-3 text-start text-sm font-medium text-ink transition hover:border-brand-400 hover:border-brand-300/80"
            >
              {p.name} <span className="num text-xs text-ink-subtle" dir="ltr">({p.id})</span>
            </button>
          ))}
        </GlassCard>
      )}

      <GlassCard className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-white">
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
              className="inline-flex h-11 items-center gap-1.5 rounded-2xl bg-primary px-4 text-sm font-semibold text-white transition hover:bg-primary-hover"
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
      <MultiChannelSection />
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
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-surface-2/60 p-2.5 dark:bg-white/[0.02]">
            <label className="text-xs font-bold text-ink">{t.inbox.aiPersonaLabel}</label>
            <select
              value={personaDrafts[c.pageId!] ?? c.aiPersonaId ?? ""}
              onChange={(e) => setPersonaDrafts((prev) => ({ ...prev, [c.pageId!]: e.target.value }))}
              className="h-9 min-w-40 flex-1 rounded-xl border border-line bg-surface px-2.5 text-xs font-medium text-ink outline-none focus:border-brand-400"
              aria-label={t.inbox.aiPersonaLabel}
            >
              <option value="">الافتراضية للمساحة</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => savePersona(c.pageId!)}
              loading={savingPersona === c.pageId}
              disabled={savingPersona === c.pageId}
            >
              {t.common.save}
            </Button>
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
          <CatalogPageSection channelId={c.channelId} pageName={c.pageName} />
        </GlassCard>
      ))}
      {!loading && !error && connections.length === 0 && pendingPages.length === 0 && (
        <GlassCard>
          <EmptyState
            icon={<Facebook size={28} strokeWidth={1.5} />}
            title="ما في صفحة فيسبوك مربوطة"
            description="اربطها من زر «ربط صفحة Facebook» فوق — أو اربط واتساب أو تيليغرام أو إنستغرام من «قنوات إضافية»."
            action={
              oauthConfigured ? (
                // <a> مش Link: مسار ربط (توجيه لفيسبوك) مش صفحة.
                <a href="/api/channels/facebook/connect" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-white transition hover:bg-primary-hover">
                  <PlugZap size={14} /> ربط صفحة Facebook
                </a>
              ) : null
            }
          />
        </GlassCard>
      )}
      <ConfirmDialog
        open={confirmPageId !== null}
        onClose={() => setConfirmPageId(null)}
        onConfirm={() => confirmPageId && void disconnect(confirmPageId)}
        title="إزالة ربط الصفحة؟"
        body="سيتم إيقاف اتصال هذه الصفحة بالنظام ولن يتم استقبال رسائل جديدة منها. لن يتم حذف المحادثات أو العملاء أو الطلبات السابقة."
        confirmLabel="إزالة الربط"
        busy={disconnecting}
        danger
      />
    </div>
  );
}
