"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowLeft, Check, Clock, Database, Inbox, MessagesSquare,
  RefreshCw, Settings2, ShieldOff, Sparkles, UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { EmptyNext, EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
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

type ConversationRow = {
  id: string;
  customer: { id: string; name: string | null };
  page: { id: string; displayName: string };
  lastInbound: { text: string | null; at: string | null };
  intel: {
    status: string;
    confidence: number;
    extractedAt: string | null;
    reviewedAt: string | null;
    lastError: string | null;
    highlights: string[];
  } | null;
};

type FieldKey =
  | "customerName" | "phone" | "city" | "address" | "products" | "quantity"
  | "budget" | "purchaseIntent" | "needs" | "notes";

type Detail = {
  id: string;
  page: { id: string; displayName: string };
  customer: { id: string; name: string | null };
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
    fields: Record<FieldKey, { status: string; sources: string[]; conflicts?: string[] }>;
  } | null;
};

const FIELD_DEFS: { key: FieldKey; label: string }[] = [
  { key: "customerName", label: "الاسم" },
  { key: "phone", label: "رقم الهاتف" },
  { key: "city", label: "المدينة" },
  { key: "address", label: "العنوان" },
  { key: "products", label: "المنتجات" },
  { key: "quantity", label: "الكمية" },
  { key: "budget", label: "الميزانية / السعر المذكور" },
  { key: "purchaseIntent", label: "نية الشراء" },
  { key: "needs", label: "الأسئلة والاحتياجات" },
  { key: "notes", label: "ملاحظات مستخرجة" },
];

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

function fieldText(data: Record<string, unknown> | undefined, key: FieldKey): string | null {
  const v = data?.[key];
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? v.join(" · ") : null;
  if (typeof v === "string" && v.trim() === "") return null;
  if (key === "purchaseIntent") return INTENT[String(v)] ?? String(v);
  return String(v);
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
  }, [loadSnapshot, loadChannels]);

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

  async function confirmField(key: FieldKey) {
    if (!selectedId || !detail) return;
    const current = fieldText(detail.intel?.data, key) ?? "";
    const value = window.prompt(`القيمة المؤكدة لـ «${FIELD_DEFS.find((f) => f.key === key)?.label ?? key}»`, current);
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
    } catch {
      setNotice("تعذّر حفظ التأكيد.");
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
                  <Badge tone="AI_ACTIVE"><Database size={11} /> OpenRouter</Badge>
                </div>
                {!detail.intel && (
                  <div className="p-4">
                    <EmptyState title="ما في معلومات مستخرجة بعد" description="الرسالة محفوظة، والتحليل يصير بالخلفية. إذا فشل، اضغط «إعادة تحليل»." />
                  </div>
                )}
                {detail.intel && (
                  <div className="divide-y divide-line">
                    {FIELD_DEFS.map((f) => {
                      const meta = detail.intel?.fields?.[f.key];
                      const status = meta?.status ?? "MISSING";
                      const text = fieldText(detail.intel?.data, f.key);
                      const st = FIELD_STATUS[status] ?? FIELD_STATUS.MISSING;
                      return (
                        <div key={f.key} className="flex items-start gap-3 px-4 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[11px] font-semibold text-ink-muted">{f.label}</span>
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
                  </div>
                )}
              </GlassCard>
            </>
          )}
        </div>
      </div>

      {/* قياسات الأداء الحقيقية من سجل التحليل */}
      <GlassCard className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-ink">أداء التحليل (قياس فعلي)</h2>
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
      </GlassCard>
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
