"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronUp, Clock, Database, Inbox,
  MessagesSquare, Plus, RefreshCw, Save, Settings2, ShieldOff, Sparkles, Trash2, UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { EmptyNext, EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { cn } from "@/lib/cn";

type Percentiles = { p50: number | null; p95: number | null; samples: number };

type Snapshot = {
  pages: { id: string; displayName: string; type: string; status: string }[];
  stats: {
    collectionPages: number;
    conversations: number;
    customersWithIntel: number;
    pendingAnalysis: number;
    failedAnalysis: number;
    lastInboundAt: string | null;
  };
  performance: {
    queueWaitMs: Percentiles;
    extractionMs: Percentiles;
    totalMs: Percentiles;
    failures24h: number;
    runs24h: number;
    stuckQueued: number;
  };
};

type FieldKind = "TEXT" | "PHONE" | "NUMBER" | "LIST";

type FieldSetting = {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  enabled: boolean;
  sortOrder: number;
  isCustom: boolean;
};

type Progress = { filled: number; required: number; missing: string[] };

type ConversationRow = {
  id: string;
  customer: { id: string; name: string | null };
  page: { id: string; displayName: string };
  lastInbound: { text: string | null; at: string | null };
  progress: Progress;
  intel: {
    status: string;
    confidence: number;
    extractedAt: string | null;
    reviewedAt: string | null;
    lastError: string | null;
    highlights: string[];
  } | null;
};

type Detail = {
  id: string;
  page: { id: string; displayName: string };
  customer: { id: string; name: string | null };
  fieldDefs: FieldSetting[];
  progress: Progress;
  messages: {
    id: string; senderType: string; direction: string; type: string; text: string | null;
    mediaUrl: string | null; deliveryStatus: string | null; createdAt: string;
  }[];
  intel: {
    status: string;
    confidence: number;
    lastError: string | null;
    extractedAt: string | null;
    reviewedAt: string | null;
    data: Record<string, unknown>;
    fields: Record<string, { status: string; sources: string[]; conflicts?: string[] }>;
  } | null;
};

const KIND_LABEL: Record<FieldKind, string> = {
  TEXT: "نص",
  PHONE: "رقم هاتف",
  NUMBER: "رقم",
  LIST: "قائمة",
};

const FIELD_STATUS: Record<string, { label: string; tone: string }> = {
  MISSING: { label: "غير متوفر", tone: "CLOSED" },
  EXTRACTED: { label: "مستخرج ويحتاج مراجعة", tone: "PENDING" },
  CONFIRMED: { label: "مؤكد من موظف", tone: "CONFIRMED" },
  CONFLICT: { label: "متعارض بين رسالتين", tone: "FAILED" },
};

const INTEL_STATUS: Record<string, { label: string; tone: string }> = {
  PENDING: { label: "بانتظار التحليل", tone: "PROCESSING" },
  READY: { label: "جاهز", tone: "DONE" },
  NEEDS_REVIEW: { label: "يحتاج مراجعة", tone: "PENDING" },
  FAILED: { label: "فشل التحليل", tone: "FAILED" },
};

const INTENT: Record<string, string> = {
  high: "عالية",
  medium: "متوسطة",
  low: "منخفضة",
  unknown: "غير واضحة",
};

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ar-JO", { dateStyle: "short", timeStyle: "short", hourCycle: "h23" });
}

function fieldText(data: Record<string, unknown> | undefined, key: string): string | null {
  const v = data?.[key];
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? v.join(" · ") : null;
  if (typeof v === "string" && v.trim() === "") return null;
  if (typeof v === "string" && v === "unknown") return null;
  if (key === "purchaseIntent") return INTENT[String(v)] ?? String(v);
  return String(v);
}

function newCustomKey(): string {
  return `custom_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export default function IntelligenceLabPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string>("all");
  const [rows, setRows] = useState<ConversationRow[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [channels, setChannels] = useState<{ id: string; displayName: string | null; type: string; sendMode: string }[]>([]);

  // البيانات المطلوب تجميعها
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [fieldDefs, setFieldDefs] = useState<FieldSetting[] | null>(null);
  const [draft, setDraft] = useState<FieldSetting[]>([]);
  const [fieldsDirty, setFieldsDirty] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newKind, setNewKind] = useState<FieldKind>("TEXT");
  const [fieldsNotice, setFieldsNotice] = useState<string | null>(null);

  const loadSnapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/intelligence/overview", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setSnapshot(await res.json());
      setError(null);
    } catch {
      setError("تعذّر تحميل إحصائيات المختبر. أعد المحاولة.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadChannels = useCallback(async () => {
    try {
      const res = await fetch("/api/channels", { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      setChannels((json.channels ?? []).filter((c: { type: string }) => c.type === "FACEBOOK"));
    } catch {
      /* القائمة اختيارية — لا تعطّل المختبر */
    }
  }, []);

  const loadFields = useCallback(async () => {
    try {
      const res = await fetch("/api/intelligence/fields", { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      const fields = (json.fields ?? []) as FieldSetting[];
      setFieldDefs(fields);
      setDraft(fields);
      setFieldsDirty(false);
    } catch {
      /* الافتراضي يكفي للعرض */
    }
  }, []);

  const loadRows = useCallback(async (page: string) => {
    setListLoading(true);
    try {
      const qs = page === "all" ? "" : `?channelId=${encodeURIComponent(page)}`;
      const res = await fetch(`/api/intelligence/conversations${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      setRows(json.conversations ?? []);
    } catch {
      setRows([]);
      setError("تعذّر تحميل المحادثات.");
    } finally {
      setListLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/intelligence/conversations/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setDetail(await res.json());
    } catch {
      setDetail(null);
      setNotice("تعذّر تحميل المحادثة.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSnapshot();
    void loadChannels();
    void loadFields();
  }, [loadSnapshot, loadChannels, loadFields]);

  useEffect(() => {
    void loadRows(pageId);
  }, [pageId, loadRows]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const selectedPage = useMemo(
    () => channels.find((c) => c.id === pageId) ?? null,
    [channels, pageId]
  );

  const enabledFields = useMemo(() => (fieldDefs ?? []).filter((f) => f.enabled), [fieldDefs]);
  const requiredFields = useMemo(() => enabledFields.filter((f) => f.required), [enabledFields]);

  async function setMode(id: string, mode: "AUTO_REPLY" | "COLLECTION_ONLY") {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/channels/by-id/${id}/send-mode`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sendMode: mode }),
      });
      if (!res.ok) {
        setNotice(res.status === 403 ? "ما عندك صلاحية تغيير وضع الصفحة." : "تعذّر تغيير وضع الصفحة.");
        return;
      }
      setNotice(mode === "COLLECTION_ONLY" ? "تم تفعيل وضع التجميع — لن يُرسل أي رد آلي لهذه الصفحة." : "رجعنا الصفحة للرد الآلي.");
      await Promise.all([loadSnapshot(), loadChannels()]);
      await loadRows(pageId);
    } catch {
      setNotice("تعذّر تغيير وضع الصفحة.");
    } finally {
      setBusy(false);
    }
  }

  async function reanalyze() {
    if (!selectedId) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/intelligence/conversations/${selectedId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reanalyze" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice("تعذّرت إعادة التحليل.");
        return;
      }
      setNotice(
        json.status === "DONE"
          ? "تم التحليل من جديد."
          : json.status === "DUPLICATE"
            ? "هذه الرسالة محللة مسبقًا."
            : json.status === "FAILED"
              ? `فشل التحليل (${json.errorCode ?? "خطأ"}). الرسالة الأصلية محفوظة.`
              : "لا توجد رسالة واردة لتحليلها."
      );
      await Promise.all([loadDetail(selectedId), loadSnapshot(), loadRows(pageId)]);
    } catch {
      setNotice("تعذّرت إعادة التحليل.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmField(key: string) {
    if (!selectedId || !detail) return;
    const label = fieldDefs?.find((f) => f.key === key)?.label ?? key;
    const current = fieldText(detail.intel?.data, key) ?? "";
    const value = window.prompt(`القيمة المؤكدة لـ «${label}»`, current);
    if (value === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/intelligence/conversations/${selectedId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", key, value: value.trim() ? value.trim() : null }),
      });
      if (!res.ok) {
        setNotice("تعذّر حفظ التأكيد.");
        return;
      }
      setNotice("تم تأكيد الحقل — لن يستبدله تحليل لاحق.");
      await loadDetail(selectedId);
      await loadRows(pageId);
    } catch {
      setNotice("تعذّر حفظ التأكيد.");
    } finally {
      setBusy(false);
    }
  }

  function updateDraft(key: string, patch: Partial<FieldSetting>) {
    setDraft((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
    setFieldsDirty(true);
  }

  function addCustomField() {
    const label = newLabel.trim();
    if (!label) {
      setFieldsNotice("اكتب اسم الحقل أولًا.");
      return;
    }
    if (draft.length >= 30) {
      setFieldsNotice("الحد الأقصى 30 حقلًا.");
      return;
    }
    setDraft((prev) => [
      ...prev,
      { key: newCustomKey(), label: label.slice(0, 40), kind: newKind, required: true, enabled: true, sortOrder: prev.length, isCustom: true },
    ]);
    setNewLabel("");
    setNewKind("TEXT");
    setFieldsDirty(true);
    setFieldsNotice(null);
  }

  function removeCustomField(key: string) {
    setDraft((prev) => prev.filter((f) => f.key !== key));
    setFieldsDirty(true);
  }

  async function saveFields() {
    setBusy(true);
    setFieldsNotice(null);
    try {
      const res = await fetch("/api/intelligence/fields", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: draft.map((f) => ({
            key: f.key,
            label: f.label,
            kind: f.kind,
            required: f.required,
            enabled: f.enabled,
          })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFieldsNotice(
          json.error === "NO_ENABLED_FIELDS"
            ? "لازم يضل حقل واحد مفعّل على الأقل."
            : json.error === "DUPLICATE_KEY" || json.error === "INVALID_KEY"
              ? "المفتاح غير صالح أو مكرر."
              : "تعذّر حفظ الإعدادات."
        );
        return;
      }
      const fields = (json.fields ?? []) as FieldSetting[];
      setFieldDefs(fields);
      setDraft(fields);
      setFieldsDirty(false);
      setFieldsNotice("تم الحفظ — التحليل القادم بيجمع هالحقول بس.");
      await Promise.all([loadRows(pageId), selectedId ? loadDetail(selectedId) : Promise.resolve()]);
    } catch {
      setFieldsNotice("تعذّر حفظ الإعدادات.");
    } finally {
      setBusy(false);
    }
  }

  const pages = snapshot?.pages ?? [];

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="مختبر التجميع"
        description="مراقبة رسائل العملاء الواردة من صفحات فيسبوك وجمع معلوماتهم — بدون أي رد آلي على العميل."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => { void loadSnapshot(); void loadRows(pageId); }} disabled={loading}>
              <RefreshCw size={14} /> تحديث
            </Button>
            <Link href="/channels" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 dark:text-brand-400">
              إدارة القنوات <ArrowLeft size={13} />
            </Link>
          </div>
        }
      />

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {/* إحصائيات حقيقية */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {loading && !snapshot
          ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-2xl" />)
          : (
            <>
              <StatCard label="صفحات في وضع التجميع" value={snapshot?.stats.collectionPages ?? 0} icon={<ShieldOff size={18} />} tone="brand" hint="الرد الآلي معطّل عليها" />
              <StatCard label="محادثات مستلمة" value={snapshot?.stats.conversations ?? 0} icon={<MessagesSquare size={18} />} tone="sky" />
              <StatCard label="عملاء جُمعت عنهم معلومات" value={snapshot?.stats.customersWithIntel ?? 0} icon={<UserRound size={18} />} tone="emerald" />
              <StatCard label="رسائل تنتظر التحليل" value={snapshot?.stats.pendingAnalysis ?? 0} icon={<Clock size={18} />} tone="amber" />
              <StatCard label="حالات فشل التحليل" value={snapshot?.stats.failedAnalysis ?? 0} icon={<AlertTriangle size={18} />} tone="red" />
              <StatCard label="آخر رسالة واردة" value={fmtDate(snapshot?.stats.lastInboundAt)} icon={<Inbox size={18} />} tone="sky" />
            </>
          )}
      </div>

      {/* شريط اختيار الصفحات — بالمعرّف الفعلي */}
      <GlassCard className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setPageId("all")}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
              pageId === "all" ? "bg-brand-600 text-white" : "bg-surface-3 text-ink-muted hover:text-ink"
            )}
          >
            كل صفحات التجميع
          </button>
          {pages.map((p) => (
            <button
              key={p.id}
              onClick={() => setPageId(p.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                pageId === p.id ? "bg-brand-600 text-white" : "bg-surface-3 text-ink-muted hover:text-ink"
              )}
            >
              {p.displayName}
            </button>
          ))}
          {pages.length === 0 && !loading && (
            <span className="text-xs text-ink-muted">ما في صفحات بوضع التجميع بعد.</span>
          )}
          <div className="ms-auto flex items-center gap-2">
            <span className="text-[11px] text-ink-subtle">تفعيل وضع التجميع لصفحة:</span>
            <Select
              aria-label="تفعيل وضع التجميع لصفحة"
              value=""
              disabled={busy}
              onChange={(e) => {
                if (e.target.value) void setMode(e.target.value, "COLLECTION_ONLY");
              }}
              className="h-8 w-56 text-xs"
            >
              <option value="">اختر صفحة فيسبوك…</option>
              {channels
                .filter((c) => c.sendMode !== "COLLECTION_ONLY")
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.displayName ?? c.id}</option>
                ))}
            </Select>
            {selectedPage && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void setMode(selectedPage.id, "AUTO_REPLY")}>
                <Settings2 size={14} /> إرجاع للرد الآلي
              </Button>
            )}
          </div>
        </div>
        {notice && <p className="mt-2 text-[11px] font-medium text-brand-700 dark:text-brand-300">{notice}</p>}
      </GlassCard>

      {/* البيانات المطلوب تجميعها */}
      <GlassCard className="overflow-hidden">
        <button
          onClick={() => setFieldsOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-start"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Settings2 size={15} className="text-brand-600 dark:text-brand-400" />
            <h2 className="text-sm font-bold text-ink">البيانات المطلوب تجميعها</h2>
            {fieldDefs && (
              <Badge tone="DONE">
                {requiredFields.length} مطلوبة من {enabledFields.length} مفعّلة
              </Badge>
            )}
            {fieldsDirty && <Badge tone="PENDING">تغييرات غير محفوظة</Badge>}
          </div>
          {fieldsOpen ? <ChevronUp size={16} className="text-ink-muted" /> : <ChevronDown size={16} className="text-ink-muted" />}
        </button>
        {fieldsOpen && (
          <div className="border-t border-line px-4 py-3">
            <p className="mb-3 text-[11px] leading-5 text-ink-muted">
              فعّل الحقول اللي بدك تجمعها من المحادثة، وحدّد «مطلوب» للحقول اللي بتوقف عليها نسبة الاكتمال.
              التحليل القادم بيطلب هالحقول بس، وأي معلومة بتتجمّع بتنحفظ تلقائيًا.
            </p>
            <div className="space-y-1.5">
              {draft.map((f) => (
                <div key={f.key} className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-3 px-3 py-2">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={f.enabled}
                      onChange={(e) => updateDraft(f.key, { enabled: e.target.checked, required: e.target.checked ? f.required : false })}
                      className="h-3.5 w-3.5 accent-brand-600"
                      aria-label={`تفعيل ${f.label}`}
                    />
                    <span className={cn("truncate text-xs font-semibold", f.enabled ? "text-ink" : "text-ink-subtle line-through")}>
                      {f.label}
                    </span>
                    <span className="rounded bg-surface-1 px-1.5 py-0.5 text-[10px] text-ink-subtle">{KIND_LABEL[f.kind]}</span>
                    {f.isCustom && <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">خاص</span>}
                  </label>
                  <button
                    onClick={() => updateDraft(f.key, { required: !f.required })}
                    disabled={!f.enabled}
                    className={cn(
                      "rounded-md px-2 py-1 text-[10px] font-bold transition-colors disabled:opacity-40",
                      f.required
                        ? "bg-brand-600 text-white"
                        : "bg-surface-1 text-ink-muted hover:text-ink"
                    )}
                    aria-pressed={f.required}
                  >
                    {f.required ? "مطلوب" : "اختياري"}
                  </button>
                  {f.isCustom && (
                    <button
                      onClick={() => removeCustomField(f.key)}
                      className="rounded-md p-1 text-ink-subtle transition-colors hover:text-red-600"
                      aria-label={`حذف ${f.label}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-line px-3 py-2.5">
              <div className="flex-1">
                <label className="mb-1 block text-[10px] font-semibold text-ink-muted">حقل خاص جديد</label>
                <Input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="مثال: المقاس · اللون · الشركة"
                  maxLength={40}
                  className="h-8 text-xs"
                />
              </div>
              <Select
                aria-label="نوع الحقل الخاص"
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as FieldKind)}
                className="h-8 w-28 text-xs"
              >
                <option value="TEXT">نص</option>
                <option value="PHONE">رقم هاتف</option>
                <option value="NUMBER">رقم</option>
                <option value="LIST">قائمة</option>
              </Select>
              <Button variant="secondary" size="sm" onClick={addCustomField} disabled={busy}>
                <Plus size={14} /> إضافة
              </Button>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-ink-subtle">
                {fieldsNotice ?? (fieldsDirty ? "احفظ التغييرات ليشتغل التحليل القادم عليها." : "الإعدادات محفوظة.")}
              </p>
              <Button size="sm" onClick={() => void saveFields()} disabled={busy || !fieldsDirty}>
                <Save size={14} /> حفظ البيانات المطلوبة
              </Button>
            </div>
          </div>
        )}
      </GlassCard>

      <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
        {/* قائمة المحادثات */}
        <GlassCard className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
            <h2 className="text-xs font-bold text-ink">المحادثات</h2>
            <span className="text-[11px] text-ink-muted">{rows?.length ?? 0}</span>
          </div>
          <div className="max-h-[560px] overflow-y-auto">
            {listLoading && !rows && (
              <div className="space-y-2 p-3">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
              </div>
            )}
            {!listLoading && rows?.length === 0 && (
              <EmptyState
                title="لا محادثات بعد"
                description="أول ما توصل رسالة على صفحة بوضع التجميع، بتظهر هون."
                action={<EmptyNext href="/channels">اربط صفحة</EmptyNext>}
              />
            )}
            {rows?.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={cn(
                  "block w-full border-b border-line px-3 py-2.5 text-start transition-colors",
                  selectedId === r.id ? "bg-brand-50 dark:bg-brand-950/40" : "hover:bg-surface-3"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-bold text-ink">{r.customer.name || "عميل"}</span>
                  <span className="num shrink-0 text-[10px] text-ink-subtle">{fmtDate(r.lastInbound.at)}</span>
                </div>
                <p className="mt-0.5 truncate text-[10px] text-ink-muted">{r.page.displayName}</p>
                <p className="mt-1 line-clamp-1 text-[11px] text-ink-muted">{r.lastInbound.text || "—"}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {r.intel ? (
                    <Badge tone={INTEL_STATUS[r.intel.status]?.tone}>{INTEL_STATUS[r.intel.status]?.label ?? r.intel.status}</Badge>
                  ) : (
                    <Badge tone="CLOSED">ما تحلّلت بعد</Badge>
                  )}
                  {r.progress.required > 0 && (
                    <Badge tone={r.progress.missing.length === 0 ? "CONFIRMED" : "PENDING"}>
                      {r.progress.filled} / {r.progress.required}
                    </Badge>
                  )}
                  {r.intel?.highlights.slice(0, 2).map((h) => (
                    <span key={h} className="truncate rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-muted">{h}</span>
                  ))}
                  {r.intel?.reviewedAt && <Badge tone="CONFIRMED">مراجَعة</Badge>}
                </div>
              </button>
            ))}
          </div>
        </GlassCard>

        {/* التفاصيل */}
        <div className="space-y-4">
          {!selectedId && (
            <GlassCard className="p-8">
              <EmptyState
                title="اختر محادثة"
                description="بتشوف الرسائل الأصلية، ومعلومات العميل المستخرجة مع مصدر كل معلومة."
                icon={<Sparkles size={20} />}
              />
            </GlassCard>
          )}
          {selectedId && detailLoading && <Skeleton className="h-64 rounded-2xl" />}
          {selectedId && detail && (
            <>
              <GlassCard className="p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-bold text-ink">{detail.customer.name || "عميل"}</h2>
                    <p className="text-[11px] text-ink-muted">{detail.page.displayName}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {detail.intel && (
                      <Badge tone={INTEL_STATUS[detail.intel.status]?.tone}>
                        {INTEL_STATUS[detail.intel.status]?.label ?? detail.intel.status}
                      </Badge>
                    )}
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void reanalyze()}>
                      <RefreshCw size={14} /> إعادة تحليل
                    </Button>
                  </div>
                </div>
                {detail.intel?.lastError && (
                  <p className="mb-2 rounded-md bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">
                    آخر فشل: {detail.intel.lastError} — الرسالة الأصلية محفوظة ويمكن إعادة التحليل.
                  </p>
                )}
                <div className="max-h-[320px] space-y-2 overflow-y-auto pe-1">
                  {detail.messages.map((m) => (
                    <div key={m.id} className={cn("flex", m.direction === "INBOUND" ? "justify-start" : "justify-end")}>
                      <div
                        className={cn(
                          "max-w-[85%] rounded-lg px-3 py-2 text-xs leading-6",
                          m.direction === "INBOUND"
                            ? "bg-surface-3 text-ink"
                            : "bg-brand-600 text-white"
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words">{m.text || (m.mediaUrl ? "📎 مرفق" : "—")}</p>
                        <p className={cn("mt-1 text-[10px]", m.direction === "INBOUND" ? "text-ink-subtle" : "text-white/70")}>
                          {m.senderType === "CUSTOMER" ? "العميل" : m.senderType === "AI" ? "الرد الآلي" : m.senderType === "HUMAN" ? "موظف" : "النظام"}
                          {" · "}
                          {fmtDate(m.createdAt)}
                          {m.deliveryStatus ? ` · ${m.deliveryStatus}` : ""}
                        </p>
                      </div>
                    </div>
                  ))}
                  {detail.messages.length === 0 && <p className="text-xs text-ink-muted">لا رسائل محفوظة.</p>}
                </div>
              </GlassCard>

              <GlassCard className="overflow-hidden">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                  <div>
                    <h2 className="text-sm font-bold text-ink">معلومات العميل المستخرجة</h2>
                    <p className="text-[11px] text-ink-muted">
                      آخر تحديث: {fmtDate(detail.intel?.extractedAt)} · الثقة: {Math.round((detail.intel?.confidence ?? 0) * 100)}%
                    </p>
                  </div>
                  <Badge tone="AI_ACTIVE"><Database size={11} /> مستخرجة بالذكاء</Badge>
                </div>

                <div className="border-b border-line px-4 py-3">
                  <div className="mb-1.5 flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-ink">
                      البيانات المطلوبة: {detail.progress.filled} من {detail.progress.required}
                    </span>
                    <span className="text-ink-subtle">
                      {detail.progress.required === 0
                        ? "ما في حقول مطلوبة"
                        : detail.progress.missing.length === 0
                          ? "مكتمل ✅"
                          : `${detail.progress.missing.length} ناقص`}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        detail.progress.missing.length === 0 ? "bg-emerald-500" : "bg-brand-600"
                      )}
                      style={{
                        width: `${detail.progress.required > 0 ? Math.round((detail.progress.filled / detail.progress.required) * 100) : 0}%`,
                      }}
                    />
                  </div>
                </div>

                {!detail.intel && (
                  <div className="p-4">
                    <EmptyState title="ما في معلومات مستخرجة بعد" description="الرسالة محفوظة، والتحليل يصير بالخلفية. إذا فشل، اضغط «إعادة تحليل»." />
                  </div>
                )}
                {detail.intel && (
                  <div className="divide-y divide-line">
                    {(detail.fieldDefs ?? []).filter((f) => f.enabled).map((f) => {
                      const meta = detail.intel?.fields?.[f.key];
                      const status = meta?.status ?? "MISSING";
                      const text = fieldText(detail.intel?.data, f.key);
                      const st = FIELD_STATUS[status] ?? FIELD_STATUS.MISSING;
                      return (
                        <div key={f.key} className="flex items-start gap-3 px-4 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[11px] font-semibold text-ink-muted">{f.label}</span>
                              {f.required && <span className="text-[10px] font-bold text-brand-600 dark:text-brand-400">مطلوب</span>}
                              <Badge tone={st.tone}>{st.label}</Badge>
                            </div>
                            <p className={cn("mt-1 text-xs", text ? "font-medium text-ink" : "text-ink-subtle")}>
                              {text ?? "غير متوفر"}
                            </p>
                            {meta?.conflicts?.length ? (
                              <p className="mt-1 text-[10px] text-red-600 dark:text-red-300">
                                قيم متعارضة: {meta.conflicts.join(" · ")}
                              </p>
                            ) : null}
                            {meta?.sources?.length ? (
                              <p className="mt-1 text-[10px] text-ink-subtle">
                                المصدر: {meta.sources.slice(-3).map((s) => `…${s.slice(-6)}`).join(" · ")}
                              </p>
                            ) : null}
                          </div>
                          <button
                            onClick={() => void confirmField(f.key)}
                            disabled={busy}
                            className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold text-brand-700 transition-colors hover:bg-brand-50 disabled:opacity-50 dark:text-brand-300 dark:hover:bg-brand-950/40"
                          >
                            <Check size={12} /> تأكيد
                          </button>
                        </div>
                      );
                    })}
                    {(detail.fieldDefs ?? []).filter((f) => f.enabled).length === 0 && (
                      <p className="px-4 py-3 text-xs text-ink-muted">ما في حقول مفعّلة — فعّل الحقول من لوحة «البيانات المطلوب تجميعها».</p>
                    )}
                  </div>
                )}
              </GlassCard>
            </>
          )}
        </div>
      </div>

      {/* قياسات الأداء الحقيقية من سجل التحليل — تقنية، فمطوية افتراضيًا. */}
      <details className="glass rounded-2xl p-4">
        <summary className="cursor-pointer select-none text-sm font-bold text-ink">أداء التحليل (تفاصيل تقنية)</summary>
        <div className="mb-3 mt-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="sr-only">أداء التحليل</h2>
          <span className="text-[11px] text-ink-subtle">
            آخر {snapshot?.performance.totalMs.samples ?? 0} تحليل ناجح · زمن المزوّد منفصل عن زمن الطابور
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <PerfCell label="انتظار في الطابور (P50 / P95)" p={snapshot?.performance.queueWaitMs} />
          <PerfCell label="زمن استخراج AI (P50 / P95)" p={snapshot?.performance.extractionMs} />
          <PerfCell label="الإجمالي حتى ظهور المعلومة (P50 / P95)" p={snapshot?.performance.totalMs} />
          <div className="rounded-lg bg-surface-3 px-3 py-2">
            <p className="num text-sm font-bold text-ink">
              {snapshot ? `${snapshot.performance.failures24h} / ${snapshot.performance.runs24h}` : "—"}
            </p>
            <p className="mt-1 text-[11px] text-ink-muted">فشل / إجمالي آخر 24 ساعة</p>
            <p className="mt-0.5 text-[10px] text-ink-subtle">عالقة بالطابور: {snapshot?.performance.stuckQueued ?? 0}</p>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-ink-subtle">P50 = الوقت المعتاد · P95 = أبطأ ٥٪ من المرات.</p>
      </details>
    </div>
  );
}

function PerfCell({ label, p }: { label: string; p?: Percentiles }) {
  return (
    <div className="rounded-lg bg-surface-3 px-3 py-2">
      <p className="num text-sm font-bold text-ink">
        {p?.p50 === null || p?.p50 === undefined ? "—" : `${p.p50} / ${p.p95 ?? "—"} ms`}
      </p>
      <p className="mt-1 text-[11px] text-ink-muted">{label}</p>
    </div>
  );
}
