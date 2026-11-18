"use client";

import { useCallback, useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { GlassCard } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { FixNote, RiskNote } from "@/components/integrations/ui";

type View = {
  configured: boolean;
  baseUrl: string | null;
  isActive: boolean;
  autoHandoff: boolean;
  hasToken: boolean;
  lastProductSyncAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
};

type SyncResult = {
  received: number;
  updated: number;
  created: number;
  failed: number;
  deactivated: number;
  deactivationSkipped: "EMPTY" | "PAGE_FULL" | "ALL_FAILED" | null;
};

const SKIP_REASON: Record<string, string> = {
  EMPTY: "الـ OMS رجّع قائمة فاضية — ما وقّفنا ولا منتج",
  PAGE_FULL: "الـ OMS فيه 500 منتج أو أكتر — ما وقّفنا ولا منتج (ممكن في منتجات ما وصلت)",
  ALL_FAILED: "ولا منتج من الـ OMS انحفظ — ما وقّفنا ولا منتج",
};

/**
 * ربط الـ OMS: كل طلب مؤكد بينزل فيه، والمنتجات والأسعار منه.
 * التوكن من الـ OMS: الإعدادات ← التطبيقات ← «توكنات الأنظمة».
 */
export function OmsSection() {
  const [view, setView] = useState<View | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [autoHandoff, setAutoHandoff] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | "sync" | null>(null);
  const [confirmSync, setConfirmSync] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/oms");
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as View;
      setView(data);
      setBaseUrl(data.baseUrl ?? "");
      setIsActive(data.configured ? data.isActive : true);
      setAutoHandoff(data.configured ? data.autoHandoff : true);
    } catch {
      setMessage({ kind: "err", text: "تعذّر تحميل ربط الـ OMS." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy("save");
    setMessage(null);
    try {
      const res = await fetch("/api/settings/oms", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrl.trim(), isActive, autoHandoff, ...(token.trim() ? { token: token.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? "تعذّر الحفظ");
      setView(data as View);
      setToken("");
      setMessage({ kind: "ok", text: "انحفظ — اضغط «اختبر الاتصال» تتأكد." });
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "تعذّر الحفظ" });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setMessage(null);
    try {
      const res = await fetch("/api/settings/oms/test", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string; message?: string };
      setMessage({ kind: res.ok && data.ok ? "ok" : "err", text: data.detail ?? data.message ?? "فشل الاختبار" });
    } finally {
      setBusy(null);
      void load();
    }
  }

  async function sync() {
    setConfirmSync(false);
    setBusy("sync");
    setMessage(null);
    try {
      const res = await fetch("/api/settings/oms/sync", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? "ما زبطت المزامنة");
      const r = data as SyncResult;
      const parts = [
        `وصل ${r.received} منتج من الـ OMS`,
        `تحدّث ${r.updated}`,
        `انضاف ${r.created}`,
        `توقّف ${r.deactivated}`,
        ...(r.failed ? [`فشل ${r.failed}`] : []),
      ];
      const skipped = r.deactivationSkipped ? ` — ${SKIP_REASON[r.deactivationSkipped]}` : "";
      setMessage({ kind: r.failed || r.deactivationSkipped ? "err" : "ok", text: parts.join(" · ") + skipped });
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "ما زبطت المزامنة" });
    } finally {
      setBusy(null);
      void load();
    }
  }

  if (forbidden) return null;
  const ready = Boolean(view?.configured && view.hasToken);

  return (
    <GlassCard className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-300">
              <Boxes size={15} />
            </span>
            ربط الـ OMS
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            كل طلب مؤكد بينزل بالـ OMS، والمنتجات والأسعار والعروض بتيجي منه كل ساعة. التوكن من الـ OMS: الإعدادات ← التطبيقات ← «توكنات الأنظمة».
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs font-semibold text-ink">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
          مفعّل
        </label>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="رابط الـ OMS">
          <Input dir="ltr" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://oms.example.com" />
        </Field>
        <Field label="توكن الـ OMS">
          <PasswordInput
            kind="secret"
            dir="ltr"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={view?.hasToken ? "محفوظ — اتركه فاضي للإبقاء عليه" : "zk1_..."}
            autoComplete="off"
          />
        </Field>
      </div>

      <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-ink">
        <input type="checkbox" checked={autoHandoff} onChange={(e) => setAutoHandoff(e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
        ابعت كل طلب مؤكد للـ OMS تلقائيًا
      </label>
      {autoHandoff && (
        <div className="mt-2 space-y-1.5">
          <RiskNote title="مؤتمت: الطلب بينزل بالـ OMS أول ما يتأكد مع الزبون — بلا مراجعة منك">
            اسم الزبون ورقمه وعنوانه بيروحوا للـ OMS.
          </RiskNote>
          <FixNote>إذا بدك تراجع كل طلب قبل الشحن، طفّي هالخيار وابعت كل طلب من صفحته بزر «ابعته للـ OMS».</FixNote>
        </div>
      )}

      <div className="mt-3 space-y-1.5">
        <RiskNote title="منتجات الردود صارت منتجات الـ OMS">
          المزامنة (كل ساعة، أو بالزر تحت) بتوقّف أي منتج هون مش موجود بالـ OMS — ما بينحذف، بيرجع من صفحته. المنتج اللي إله نفس الرمز أو نفس الاسم بيضل معه صوره وربطه بالصفحات، والجديد بينضاف لكل الصفحات.
        </RiskNote>
        <FixNote>أي منتج جديد ضيفه بالـ OMS أول. منتج جديد ما بدك ياه بصفحة معيّنة: شيله من كتالوجها.</FixNote>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => void save()} loading={busy === "save"} disabled={busy !== null || !baseUrl.trim()}>
          حفظ
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => void test()} loading={busy === "test"} disabled={busy !== null || !ready}>
          اختبر الاتصال
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmSync(true)} loading={busy === "sync"} disabled={busy !== null || !ready}>
          استبدل المنتجات بمنتجات الـ OMS هلأ
        </Button>
      </div>
      {message && (
        <p className={`mt-2 text-xs ${message.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{message.text}</p>
      )}
      <p className="mt-2 text-[11px] text-ink-subtle">
        آخر مزامنة منتجات: {view?.lastProductSyncAt ? new Date(view.lastProductSyncAt).toLocaleString("ar") : "—"}
        {view?.lastError ? ` · آخر خطأ: ${view.lastError}` : ""}
      </p>

      <ConfirmDialog
        open={confirmSync}
        onClose={() => setConfirmSync(false)}
        onConfirm={() => void sync()}
        title="استبدل المنتجات بمنتجات الـ OMS؟"
        body="المنتجات الموجودة بالـ OMS بتتحدّث أو بتنضاف، وأي منتج هون مش بالـ OMS بيتوقّف (ما بينحذف — بيرجع من صفحته)."
        confirmLabel="استبدل هلأ"
        busy={busy === "sync"}
      />
    </GlassCard>
  );
}
