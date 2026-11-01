"use client";

import { useCallback, useEffect, useState } from "react";
import { Megaphone, Plus, Users } from "lucide-react";
import { label, t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { ConfirmDialog, ErrorState } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { SegmentDialog } from "./segment-dialog";

type Segment = { id: string; name: string; isActive: boolean };
type Campaign = {
  id: string;
  name: string;
  channelType: string;
  status: string;
  segmentId: string;
  scheduledAt: string | null;
  ratePerMinute: number;
  completedAt: string | null;
  cancelReason: string | null;
  failReason: string | null;
};
type Runlog = {
  status: string;
  recipients: { pending: number; queued: number; sent: number; failed: number; excluded: number; cancelled: number };
  events: Array<{ type: string; reason: string | null; count: number; createdAt: string }>;
};
type DryRun = {
  dryRun: boolean;
  eligibleCount: number;
  excludedCount: number;
  byReason: Record<string, number>;
  issues: string[];
};

const CAMPAIGN_CHANNELS = ["WHATSAPP", "TELEGRAM"] as const;

export default function CampaignsPage() {
  const [items, setItems] = useState<Campaign[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [runlog, setRunlog] = useState<Runlog | null>(null);
  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Campaign | null>(null);
  const [dryRunForId, setDryRunForId] = useState<string | null>(null);
  const toast = useToast();

  // نموذج إنشاء حملة
  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [channelType, setChannelType] = useState<(typeof CAMPAIGN_CHANNELS)[number]>("WHATSAPP");
  const [text, setText] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateLanguage, setTemplateLanguage] = useState("ar");
  const [ratePerMinute, setRatePerMinute] = useState("30");
  const [formError, setFormError] = useState<string | null>(null);
  const [segmentOpen, setSegmentOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([fetch("/api/campaigns"), fetch("/api/segments")]);
      if (!c.ok || !s.ok) throw new Error();
      setItems((await c.json()).items);
      setSegments((await s.json()).items);
      setError(null);
    } catch {
      setError("تعذّر تحميل الحملات");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openCampaign(id: string) {
    setSelected(id);
    setDryRun(null);
    setDryRunForId(null);
    try {
      const res = await fetch(`/api/campaigns/${id}`);
      if (!res.ok) throw new Error();
      setRunlog((await res.json()).runlog);
    } catch {
      toast.show(t.inbox.actionFailed, "error");
    }
  }

  async function dryRunNow(id: string) {
    setBusy(`dry:${id}`);
    setDryRunForId(id);
    setSelected(id);
    try {
      const res = await fetch(`/api/campaigns/${id}/dry-run`, { method: "POST" });
      if (!res.ok) throw new Error();
      setDryRun((await res.json()).data ?? null);
    } catch {
      setDryRun(null);
      toast.show(t.inbox.actionFailed, "error");
    } finally {
      setBusy(null);
    }
  }

  async function lifecycle(id: string, action: "pause" | "resume" | "cancel") {
    setBusy(`${action}:${id}`);
    try {
      const res = await fetch(`/api/campaigns/${id}/lifecycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(action === "cancel" ? { reason: "MANUAL" } : {}) }),
      });
      if (!res.ok) throw new Error();
      setCancelTarget(null);
      if (selected === id) await openCampaign(id);
      load();
    } catch {
      toast.show(t.inbox.actionFailed, "error");
    } finally {
      setBusy(null);
    }
  }

  async function stageAction(id: string, stage: "validate" | "approve" | "schedule") {
    setBusy(`${stage}:${id}`);
    try {
      const path = stage === "validate" ? "validate" : stage === "approve" ? "approve" : "schedule";
      const res = await fetch(`/api/campaigns/${id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setFormError(j.error ?? "تعذر تنفيذ الإجراء");
      } else {
        setFormError(null);
      }
    } catch {
      setFormError("تعذر تنفيذ الإجراء");
    } finally {
      setBusy(null);
      load();
    }
  }

  async function createCampaign() {
    setCreating(true);
    setFormError(null);
    try {
      const content: Record<string, unknown> = { text };
      if (channelType === "WHATSAPP") {
        if (!templateName.trim()) {
          setFormError("حملات واتساب تتطلب قالبًا معتمدًا (اسم + لغة)");
          setCreating(false);
          return;
        }
        content.templateName = templateName.trim();
        content.templateLanguage = templateLanguage.trim();
      }
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          segmentId,
          channelType,
          ratePerMinute: Number(ratePerMinute) || 30,
          content,
        }),
      });
      if (res.ok) {
        setName("");
        setText("");
        setTemplateName("");
        load();
      } else {
        const j = await res.json().catch(() => ({}));
        setFormError(j.error ?? "تعذر إنشاء الحملة");
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page-wrap">
      <PageHeader
        title="الحملات التسويقية"
        description="خطوتين: اختار مين بدك توصله (شريحة)، وبعدها اكتب الرسالة (حملة). ولا شي بينبعت قبل الفحص والاعتماد."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setSegmentOpen(true)}>
            <Plus size={14} /> شريحة جديدة
          </Button>
        }
      />

      {error && (
        <GlassCard>
          <ErrorState onRetry={load} />
        </GlassCard>
      )}

      {/* شرائح محفوظة */}
      {!error && (
      <GlassCard level="glass-subtle" className="p-4">
        <p className="flex items-center gap-2 text-sm font-bold text-ink">
          <Users size={15} className="text-brand-500" /> ١. الشرائح — مين بدك توصله
        </p>
        {segments.length === 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-[12px] text-ink-subtle">ما في ولا شريحة لسا — ابدأ هون، وبعدها بتقدر تعمل حملة.</p>
            <Button size="sm" onClick={() => setSegmentOpen(true)}><Plus size={13} /> شريحة جديدة</Button>
          </div>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {segments.map((s) => (
              <li key={s.id} className="flex items-center justify-between rounded-xl border border-line/60 px-3 py-2 text-[12px]">
                <span className="font-bold text-ink">{s.name}</span>
                <StatusBadge value={s.isActive ? "ACTIVE" : "PAUSED"} dot />
              </li>
            ))}
          </ul>
        )}
      </GlassCard>
      )}

      {/* إنشاء حملة */}
      {!error && (
      <GlassCard level="glass-subtle" className="space-y-3 p-4">
        <p className="flex items-center gap-2 text-sm font-bold text-ink">
          <Megaphone size={15} className="text-brand-500" /> ٢. حملة جديدة
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم الحملة" aria-label="اسم الحملة" />
          <Select value={segmentId} onChange={(e) => setSegmentId(e.target.value)} aria-label="الشريحة المستهدفة">
            <option value="">{segments.length ? "— اختر الشريحة —" : "أنشئ شريحة أول ↑"}</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
          <Select value={channelType} onChange={(e) => setChannelType(e.target.value as (typeof CAMPAIGN_CHANNELS)[number])} aria-label="القناة">
            {CAMPAIGN_CHANNELS.map((c) => (
              <option key={c} value={c}>{label(c)}</option>
            ))}
          </Select>
          <Input value={ratePerMinute} onChange={(e) => setRatePerMinute(e.target.value)} aria-label="حد الإرسال بالدقيقة" placeholder="30/دقيقة" inputMode="numeric" />
        </div>
        {channelType === "WHATSAPP" && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px]">
            <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="اسم القالب المعتمد في Meta" aria-label="اسم القالب" />
            <Input value={templateLanguage} onChange={(e) => setTemplateLanguage(e.target.value)} placeholder="ar" aria-label="لغة القالب" />
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="نص الرسالة — سيُراجع ويُعتمد قبل الإرسال"
          aria-label="نص الرسالة"
          className="w-full resize-none rounded-xl border border-line/60 bg-surface-2/60 p-3 text-[13px] text-ink outline-none placeholder:text-ink-subtle"
        />
        <p className="text-[11px] text-ink-subtle">
          المسارات المسموحة رسميًا: واتساب (قالب معتمد) وتيليغرام (مشتركو البوت). فيسبوك/إنستغرام/تيكتوك لا تدعم بثًا تسويقيًا مباشرًا — ممنوعة.
        </p>
        {formError && <p className="text-[12px] font-bold text-red-600 dark:text-red-400">{formError}</p>}
        <Button size="sm" onClick={createCampaign} disabled={creating || !name.trim() || !segmentId || !text.trim()} loading={creating}>
          إنشاء مسودة
        </Button>
      </GlassCard>
      )}


      {/* القائمة */}
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}
        </div>
      )}
      {!loading && !error && items.map((c) => (
        <GlassCard key={c.id} className="space-y-2 p-4 transition-colors hover:border-brand-300/80 dark:hover:border-brand-700">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button onClick={() => openCampaign(c.id)} className="truncate text-sm font-bold text-ink hover:text-brand-600">
              {c.name} · {label(c.channelType)}
            </button>
            <StatusBadge value={c.status} dot />
          </div>
          <p className="num text-[11px] text-ink-muted">
            {c.scheduledAt ? `مجدولة: ${new Date(c.scheduledAt).toLocaleString("ar")}` : "غير مجدولة"} · {c.ratePerMinute}/دقيقة
            {c.cancelReason ? ` · سبب الإلغاء: ${c.cancelReason}` : ""}
            {c.failReason ? ` · سبب الفشل: ${c.failReason}` : ""}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {c.status === "DRAFT" && <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `validate:${c.id}`} onClick={() => stageAction(c.id, "validate")}>تحقق</Button>}
            {c.status === "READY" && <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `approve:${c.id}`} onClick={() => stageAction(c.id, "approve")}>اعتماد المحتوى</Button>}
            {c.status === "READY" && <Button size="sm" variant="primary" disabled={busy !== null} loading={busy === `schedule:${c.id}`} onClick={() => stageAction(c.id, "schedule")}>جدولة</Button>}
            {c.status === "RUNNING" && <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `pause:${c.id}`} onClick={() => lifecycle(c.id, "pause")}>إيقاف مؤقت</Button>}
            {c.status === "PAUSED" && <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `resume:${c.id}`} onClick={() => lifecycle(c.id, "resume")}>استئناف</Button>}
            {["DRAFT", "READY", "SCHEDULED", "RUNNING", "PAUSED"].includes(c.status) && (
              <Button size="sm" variant="ghost" onClick={() => setCancelTarget(c)} className="text-red-600 hover:bg-red-500/10 dark:text-red-400">
                إلغاء
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy !== null} loading={busy === `dry:${c.id}`} onClick={() => dryRunNow(c.id)}>معاينة بلا إرسال</Button>
          </div>

          {selected === c.id && dryRunForId === c.id && dryRun && (
            <div className="rounded-xl border border-line/60 bg-surface-2/50 p-3 text-[12px]">
              <p className="font-bold text-ink">معاينة (بلا إرسال وبلا تغيير أي بيانات):</p>
              <p className="num mt-1 text-ink-muted">
                مؤهلون: {dryRun.eligibleCount} · مستبعدون: {dryRun.excludedCount}
                {Object.entries(dryRun.byReason ?? {}).map(([k, v]) => ` · ${k}: ${v}`)}
              </p>
              {dryRun.issues.length > 0 && (
                <p className="mt-1 font-bold text-amber-600 dark:text-amber-400">ملاحظات: {dryRun.issues.join(" · ")}</p>
              )}
              {dryRun.issues.length === 0 && <p className="mt-1 font-bold text-emerald-600 dark:text-emerald-400">لا عوائق — جاهزة للجدولة بعد الاعتماد.</p>}
            </div>
          )}

          {selected === c.id && runlog && (
            <div className="rounded-xl border border-line/60 bg-surface-2/50 p-3 text-[12px]">
              <p className="font-bold text-ink">سجل التنفيذ (أرقام من قاعدة البيانات):</p>
              <p className="num mt-1 text-ink-muted">
                أُرسلت: {runlog.recipients.sent} · فشلت: {runlog.recipients.failed} · مستبعدون: {runlog.recipients.excluded} ·
                متبقون: {runlog.recipients.pending} · ملغاة: {runlog.recipients.cancelled}
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {runlog.events.slice(0, 8).map((e, i) => (
                  <li key={i} className="text-ink-subtle">
                    {e.type}{e.reason ? ` · ${e.reason}` : ""} · {new Date(e.createdAt).toLocaleString("ar")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </GlassCard>
      ))}
      {!loading && !error && items.length === 0 && (
        <GlassCard>
          <EmptyState
            icon={<Megaphone size={28} strokeWidth={1.5} />}
            title="لا حملات بعد"
            description="أنشئ شريحة ثم حملة — لا يُرسل شيء قبل التحقق والاعتماد والجدولة."
            action={
              segments.length === 0 ? (
                <Button size="sm" onClick={() => setSegmentOpen(true)}><Plus size={14} /> شريحة جديدة</Button>
              ) : null
            }
          />
        </GlassCard>
      )}
      <SegmentDialog
        open={segmentOpen}
        onClose={() => setSegmentOpen(false)}
        onCreated={(id) => {
          setSegmentOpen(false);
          setSegmentId(id);
          load();
          toast.show("الشريحة جاهزة — اكتب رسالة الحملة", "success");
        }}
      />
      <ConfirmDialog
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        onConfirm={() => cancelTarget && void lifecycle(cancelTarget.id, "cancel")}
        title={`إلغاء الحملة "${cancelTarget?.name ?? ""}"؟`}
        body="سيتوقف الإرسال فورًا: المستلمون غير المعالجون يُلغون ولا تُرسل لهم رسائل. لا يمكن التراجع."
        confirmLabel="إلغاء الحملة"
        busy={cancelTarget ? busy === `cancel:${cancelTarget.id}` : false}
        danger
      />
    </div>
  );
}