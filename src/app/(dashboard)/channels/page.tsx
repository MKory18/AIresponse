"use client";

import { useCallback, useEffect, useState } from "react";

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

const input = "rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500";

export default function ChannelsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [oauthConfigured, setOauthConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingPages, setPendingPages] = useState<{ id: string; name: string }[]>([]);
  const [selectionToken, setSelectionToken] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

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
      setMessage("تم ربط الصفحة بنجاح ✓");
      load();
    } else {
      const data = await res.json().catch(() => ({}));
      setMessage(data.message ?? "فشل ربط الصفحة");
    }
  }

  async function disconnect(pageId: string) {
    await fetch("/api/channels/facebook/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageId }),
    });
    setMessage("تم فصل الصفحة.");
    load();
  }

  async function testConnection(pageId: string) {
    setTesting(pageId);
    const res = await fetch("/api/channels/facebook/disconnect", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageId }),
    });
    setTesting(null);
    setMessage(res.ok ? "الاتصال سليم ✓" : "فشل اختبار الاتصال");
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">القنوات</h1>
      {message && <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">{message}</p>}

      {pendingPages.length > 0 && (
        <section className="rounded-xl border border-brand-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-bold text-slate-700">اختر الصفحة المرتبطة</h2>
          {pendingPages.map((p) => (
            <button
              key={p.id}
              onClick={() => selectPage(p.id)}
              className="block w-full rounded-lg border border-slate-200 p-3 text-right text-sm hover:border-brand-500"
            >
              {p.name} <span className="text-xs text-slate-400" dir="ltr">({p.id})</span>
            </button>
          ))}
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-slate-700">Facebook Messenger</h2>
            <p className="text-xs text-slate-500">ربط صفحة فيسبوك رسميًا عبر Meta Graph API.</p>
          </div>
          {oauthConfigured && (
            <a
              href="/api/channels/facebook/connect"
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
            >
              ربط صفحة Facebook
            </a>
          )}
        </div>
        {!oauthConfigured && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
           META_APP_ID و META_APP_SECRET غير مضبوطين على الخادم — أضفهما لتفعيل الربط.
          </p>
        )}
      </section>

      {loading && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}
      {connections.map((c) => (
        <div key={c.channelId} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold text-slate-800">{c.pageName ?? "صفحة فيسبوك"}</p>
              <p className="text-xs text-slate-400" dir="ltr">{c.pageId}</p>
            </div>
            <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${c.status === "CONNECTED" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
              {c.status}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-500 md:grid-cols-4">
            <p>آخر Webhook: {c.lastWebhookAt ? new Date(c.lastWebhookAt).toLocaleString("ar") : "—"}</p>
            <p>آخر إرسال: {c.lastSendAt ? new Date(c.lastSendAt).toLocaleString("ar") : "—"}</p>
            <p>حالة التوكن: {c.tokenStatus}</p>
            <p>رُبطت: {c.connectedAt ? new Date(c.connectedAt).toLocaleDateString("ar") : "—"}</p>
          </div>
          <div className="mt-3 flex gap-1.5">
            <button onClick={() => testConnection(c.pageId!)} disabled={testing === c.pageId} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50 disabled:opacity-50">
              {testing === c.pageId ? "جارٍ الاختبار…" : "اختبار الاتصال"}
            </button>
            {c.status === "CONNECTED" && (
              <button onClick={() => disconnect(c.pageId!)} className="rounded-lg border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50">
                فصل
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
