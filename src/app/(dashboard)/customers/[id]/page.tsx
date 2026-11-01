"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Check, MessageSquare, Phone, Save, Sparkles, UserRound } from "lucide-react";
import { formatNumber, label, t, timeAgo } from "@/lib/i18n";
import { Avatar } from "@/components/ui/avatar";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

// ── الأنواع (مطابقة لِـ getCustomerDetail + IntelligenceSnapshot) ────────────
type IntelFieldValue = string | number | string[] | null;
type IntelStatus = "MISSING" | "EXTRACTED" | "CONFIRMED" | "CONFLICT";
type IntelMeta = { status: IntelStatus; sources: string[]; conflicts?: string[] };

type IntelSnapshot = {
  conversationId: string;
  status: string;
  data: Record<string, IntelFieldValue>;
  fieldMeta: Record<string, IntelMeta>;
  confidence: number;
  lastMessageId: string | null;
  extractedAt: string | null;
  reviewedAt: string | null;
};

type CustomerDetail = {
  canWrite: boolean;
  canConfirm: boolean;
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  province: string | null;
  address: string | null;
  notes: string | null;
  status: string;
  tags: string[];
  lastContactAt: string | null;
  createdAt: string;
  aiSummary: string | null;
  identities: { id: string; channelType: string; displayName: string | null }[];
  orders: { id: string; orderNumber: string; status: string; total: string; currency: string; createdAt: string }[];
  conversations: { id: string; status: string; aiState: string; summary: string | null; updatedAt: string }[];
  intel: IntelSnapshot[];
  fieldHistory?: FieldHistoryEntry[];
};

/** P15 — سجل تعديل حقل: القيمة قبل وبعد + من عدّل + متى. */
type FieldHistoryEntry = {
  id: string;
  userId: string | null;
  createdAt: string;
  metadata: {
    fieldName?: string;
    beforeValue?: IntelFieldValue;
    afterValue?: IntelFieldValue;
    scope?: string;
    customerField?: string | null;
  };
};

/** تسميات حقول الاستخراج — مطابقة لـ INTEL_FIELD_CATALOG في الخادم. */
const INTEL_LABELS: Record<string, string> = {
  customerName: "الاسم",
  phone: "رقم الهاتف",
  city: "المدينة",
  address: "العنوان",
  order: "الطلبية",
  products: "المنتج",
  quantity: "الكمية",
  budget: "الميزانية / السعر المذكور",
  purchaseIntent: "نية الشراء",
  needs: "الاحتياجات",
  notes: "ملاحظات مستخرجة",
};

/** تسميات أعمدة ملف العميل (تعديل الأساسيات). */
const CUSTOMER_LABELS: Record<string, string> = {
  name: "الاسم",
  phone: "رقم الهاتف",
  email: "البريد الإلكتروني",
  city: "المدينة",
  province: "المحافظة",
  address: "العنوان",
  language: "اللغة",
  notes: "ملاحظات",
  status: "الحالة",
  tags: "الوسوم",
};

function displayValue(v: IntelFieldValue): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.length ? v.join("، ") : "—";
  return String(v);
}

function isEmpty(v: IntelFieldValue): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

/** سطر معلومة واحد موحّد من أي محادثة مرتبطة. */
type Fact = {
  key: string;
  value: IntelFieldValue;
  status: IntelStatus;
  sources: string[];
  conflicts: string[];
  conversationId: string;
};

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ name: "", phone: "", city: "", province: "", address: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/customers/${params.id}`);
    if (!res.ok) {
      setError("العميل غير موجود");
      setLoading(false);
      return;
    }
    const data = (await res.json()) as CustomerDetail;
    setCustomer(data);
    setDraft({
      name: data.name ?? "",
      phone: data.phone ?? "",
      city: data.city ?? "",
      province: data.province ?? "",
      address: data.address ?? "",
    });
    setError(null);
    setLoading(false);
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  // تجميع الحقائق عبر المحادثات (بلا دمج قيم متعارضة — كل حقيقة بمصدرها).
  const facts: Fact[] = useMemo(() => {
    if (!customer) return [];
    const out: Fact[] = [];
    for (const snap of customer.intel) {
      for (const [key, value] of Object.entries(snap.data ?? {})) {
        if (key === "purchaseIntent" && value === "unknown") continue;
        if (isEmpty(value)) continue;
        const meta = snap.fieldMeta?.[key];
        out.push({
          key,
          value,
          status: meta?.status ?? "EXTRACTED",
          sources: meta?.sources ?? [],
          conflicts: meta?.conflicts ?? [],
          conversationId: snap.conversationId,
        });
      }
    }
    return out;
  }, [customer]);

  const confirmed = facts.filter((f) => f.status === "CONFIRMED");
  const review = facts.filter((f) => f.status === "EXTRACTED");
  const conflicts = facts.filter((f) => f.status === "CONFLICT");

  async function saveBasics() {
    setSaving(true);
    const res = await fetch(`/api/customers/${params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: draft.name || null,
        phone: draft.phone || null,
        city: draft.city || null,
        province: draft.province || null,
        address: draft.address || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "تعذّر الحفظ (تحقق من الصلاحية أو الرقم المكرر)");
      return;
    }
    load();
  }

  async function confirmFact(fact: Fact, value: string) {
    const res = await fetch(`/api/intelligence/conversations/${fact.conversationId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm", key: fact.key, value }),
    });
    if (!res.ok) {
      setError("تعذّر التأكيد (تحقق من الصلاحية)");
      return;
    }
    load();
  }

  if (loading) {
    return (
      <div className="page-wrap">
        <GlassCard className="p-4"><Skeleton className="h-40 w-full" /></GlassCard>
      </div>
    );
  }
  if (!customer) {
    return (
      <div className="page-wrap">
        <GlassCard>
          <EmptyState icon={<UserRound size={28} strokeWidth={1.5} />} title="العميل غير موجود" description={error ?? ""} action={<Button size="sm" variant="secondary" onClick={load}>{t.common.retry}</Button>} />
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="page-wrap">
      <PageHeader
        title={customer.name ?? "بدون اسم"}
        description={`${label(customer.status)} · ${t.customer.lastActivity}: ${timeAgo(customer.lastContactAt ?? customer.createdAt)}`}
        actions={
          <Link href="/customers" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
            <ArrowLeft size={15} /> {t.pages.customersTitle}
          </Link>
        }
      />

      {error && (
        <GlassCard className="p-2">
          <p className="px-2 text-xs text-amber-700 dark:text-amber-400">{error}</p>
        </GlassCard>
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        {/* Basics + editable */}
        <GlassCard level="glass-subtle" className="space-y-3 p-4 lg:col-span-1">
          <div className="flex items-center gap-3">
            <Avatar name={customer.name ?? customer.phone} size="lg" ring />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-ink">{customer.name ?? customer.phone ?? t.inbox.unknownCustomer}</p>
              <div className="mt-1"><StatusBadge value={customer.status} dot /></div>
            </div>
          </div>

          <p className="section-title">{t.customer.panelTitle}</p>
          <div className="space-y-2">
            {customer.canWrite ? (
              <>
                <LabelledInput label="الاسم" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
                <LabelledInput label={t.customer.phone} value={draft.phone} onChange={(v) => setDraft({ ...draft, phone: v })} dir="ltr" />
                <LabelledInput label="المدينة" value={draft.city} onChange={(v) => setDraft({ ...draft, city: v })} />
                <LabelledInput label={t.customer.province} value={draft.province} onChange={(v) => setDraft({ ...draft, province: v })} />
                <LabelledInput label={t.customer.address} value={draft.address} onChange={(v) => setDraft({ ...draft, address: v })} />
                <Button size="sm" onClick={saveBasics} disabled={saving}><Save size={14} /> {t.common.save}</Button>
              </>
            ) : (
              <div className="space-y-1 text-xs text-ink-muted">
                <p className="num flex items-center gap-1.5" dir="ltr"><Phone size={12} /> {customer.phone ?? "—"}</p>
                <p>المدينة: {customer.city ?? "—"}</p>
                <p>{t.customer.province}: {customer.province ?? "—"}</p>
                <p>{t.customer.address}: {customer.address ?? "—"}</p>
              </div>
            )}
          </div>

          {customer.identities.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {customer.identities.map((i) => (
                <Badge key={i.id} tone="OPEN">{i.displayName ?? i.channelType}</Badge>
              ))}
            </div>
          )}
        </GlassCard>

        {/* Extracted / confirmed / review / conflicts */}
        <div className="space-y-3 lg:col-span-2">
          <IntelSection title="معلومات مؤكدة" tone="ok" facts={confirmed} canConfirm={customer.canConfirm} onConfirm={confirmFact} empty="ما في معلومة مؤكدة بعد." />
          <IntelSection title="معلومات بانتظار المراجعة" tone="warn" facts={review} canConfirm={customer.canConfirm} onConfirm={confirmFact} empty="ما في معلومات مستخرجة بانتظار المراجعة." />
          {conflicts.length > 0 && (
            <IntelSection title="تعارضات (تحتاج حسمًا يدويًا)" tone="danger" facts={conflicts} canConfirm={customer.canConfirm} onConfirm={confirmFact} empty="" />
          )}

          {/* P15 — سجل تعديلات الحقول (قبل/بعد) — للقراءة فقط */}
          {(customer.fieldHistory ?? []).length > 0 && (
            <GlassCard level="glass-subtle" className="p-4">
              <p className="mb-2 text-xs font-bold text-ink">سجل التعديلات ({formatNumber((customer.fieldHistory ?? []).length)})</p>
              <div className="space-y-1.5">
                {(customer.fieldHistory ?? []).map((entry) => {
                  const meta = entry.metadata ?? {};
                  const fieldName = meta.fieldName ?? "";
                  const fieldLabel =
                    meta.scope === "customer"
                      ? CUSTOMER_LABELS[fieldName] ?? fieldName
                      : INTEL_LABELS[fieldName] ?? fieldName;
                  return (
                    <div key={entry.id} className="rounded-lg border border-line/60 px-2.5 py-1.5 text-[11px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-ink-muted">{fieldLabel}</span>
                        <span className="text-[10px] text-ink-subtle">
                          {entry.userId ? `بواسطة ${entry.userId.slice(0, 8)}` : "تلقائي"} · {timeAgo(entry.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-ink">
                        من: {displayValue(meta.beforeValue ?? null)} · إلى: {displayValue(meta.afterValue ?? null)}
                      </p>
                    </div>
                  );
                })}
              </div>
            </GlassCard>
          )}

          {/* Linked conversations */}
          <GlassCard level="glass-subtle" className="p-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-ink">
              <MessageSquare size={13} /> {t.nav.conversations} ({formatNumber(customer.conversations.length)})
            </p>
            {customer.conversations.length === 0 ? (
              <p className="text-[11px] text-ink-subtle">ما في محادثات مرتبطة.</p>
            ) : (
              <div className="space-y-1">
                {customer.conversations.map((c) => (
                  <Link key={c.id} href={`/conversations?id=${c.id}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-[11px] transition hover:bg-surface-3/70">
                    <StatusBadge value={c.status} />
                    <span className="truncate text-ink-muted">{c.summary ?? label(c.aiState)}</span>
                    <span className="whitespace-nowrap text-ink-subtle">{timeAgo(c.updatedAt)}</span>
                  </Link>
                ))}
              </div>
            )}
          </GlassCard>

          {/* Orders (read-only link) */}
          <GlassCard level="glass-subtle" className="p-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-ink">
              <Sparkles size={13} /> {t.customer.recentOrders}
            </p>
            {customer.orders.length === 0 ? (
              <p className="text-[11px] text-ink-subtle">{t.customer.noOrders}</p>
            ) : (
              <div className="space-y-1">
                {customer.orders.map((o) => (
                  <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-[11px] transition hover:bg-surface-3/70">
                    <span className="num font-bold text-ink">{o.orderNumber}</span>
                    <StatusBadge value={o.status} />
                    <span className="num text-ink-muted">{formatNumber(o.total)}</span>
                  </Link>
                ))}
              </div>
            )}
          </GlassCard>
        </div>
      </div>
    </div>
  );
}

function LabelledInput({ label, value, onChange, dir }: { label: string; value: string; onChange: (v: string) => void; dir?: "ltr" | "rtl" }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold text-ink-muted">{label}</span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} dir={dir} />
    </label>
  );
}

function IntelSection({
  title, tone, facts, canConfirm, onConfirm, empty,
}: {
  title: string;
  tone: "ok" | "warn" | "danger";
  facts: Fact[];
  canConfirm: boolean;
  onConfirm: (fact: Fact, value: string) => void;
  empty: string;
}) {
  if (facts.length === 0 && !empty) return null;
  const tones: Record<string, string> = {
    ok: "text-emerald-700 dark:text-emerald-400",
    warn: "text-amber-700 dark:text-amber-400",
    danger: "text-rose-700 dark:text-rose-400",
  };
  return (
    <GlassCard level="glass-subtle" className="p-4">
      <p className={`mb-2 text-xs font-bold ${tones[tone]}`}>{title} ({formatNumber(facts.length)})</p>
      {facts.length === 0 ? (
        <p className="text-[11px] text-ink-subtle">{empty}</p>
      ) : (
        <div className="space-y-2">
          {facts.map((f, i) => (
            <FactRow key={`${f.conversationId}-${f.key}-${i}`} fact={f} canConfirm={canConfirm} onConfirm={onConfirm} />
          ))}
        </div>
      )}
    </GlassCard>
  );
}

function FactRow({ fact, canConfirm, onConfirm }: { fact: Fact; canConfirm: boolean; onConfirm: (fact: Fact, value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(Array.isArray(fact.value) ? fact.value.join("، ") : String(fact.value ?? ""));
  return (
    <div className="rounded-lg border border-line/60 px-2.5 py-2 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold text-ink-muted">{INTEL_LABELS[fact.key] ?? fact.key}</span>
        {canConfirm && !editing && (
          <button className="flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-300" onClick={() => setEditing(true)}>
            <Check size={12} /> تأكيد/تصحيح
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-1.5 flex items-center gap-2">
          <Input value={value} onChange={(e) => setValue(e.target.value)} />
          <Button size="sm" onClick={() => { onConfirm(fact, value); setEditing(false); }}>{t.common.save}</Button>
        </div>
      ) : (
        <p className="mt-1 text-ink">{displayValue(fact.value)}</p>
      )}
      <p className="mt-1 text-[10px] text-ink-subtle">
        المصدر: {fact.sources.length ? fact.sources.join("، ") : fact.conversationId.slice(0, 10)}
        {fact.conflicts.length > 0 && ` · قيم متعارضة: ${fact.conflicts.join("، ")}`}
      </p>
    </div>
  );
}
