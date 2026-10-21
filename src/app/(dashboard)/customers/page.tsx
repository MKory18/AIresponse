"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Phone, Search, Users } from "lucide-react";
import { formatNumber, label, t, timeAgo } from "@/lib/i18n";
import { Avatar } from "@/components/ui/avatar";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { EmptyNext, EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { SkeletonTable } from "@/components/ui/skeleton";

type Customer = {
  id: string;
  name: string | null;
  phone: string | null;
  status: string;
  tags: string[];
  lastContactAt: string | null;
  createdAt: string;
  identities: { id: string; channelType: string }[];
};

const STATUSES = ["NEW_LEAD", "INTERESTED", "CONSIDERING", "READY_TO_BUY", "ORDERED", "REPEAT_CUSTOMER", "AT_RISK", "BLOCKED"];

export default function CustomersPage() {
  const [items, setItems] = useState<Customer[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    const res = await fetch(`/api/customers?${params}`);
    if (!res.ok) {
      setError("تعذّر تحميل العملاء، حاول مجددًا.");
      return;
    }
    setItems(((await res.json()) as { items: Customer[] }).items);
    setError(null);
  }, [q]);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => {
      load().finally(() => setLoading(false));
    }, q ? 350 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  const visible = status ? items.filter((c) => c.status === status) : items;

  return (
    <div className="page-wrap">
      <PageHeader
        title={t.pages.customersTitle}
        description={t.pages.customersDesc}
        actions={
          <Badge tone="NEW">
            <Users size={11} />
            <span className="num">{formatNumber(items.length)}</span>
            {t.nav.customers}
          </Badge>
        }
      />

      <GlassCard level="glass-subtle" className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-52 flex-1">
          <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${t.common.search} بالاسم أو الهاتف…`} aria-label={t.common.search} className="ps-9" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t.common.status} className="w-44">
          <option value="">{t.common.all} — الحالات</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{label(s)}</option>
          ))}
        </Select>
      </GlassCard>

      {error && (
        <GlassCard className="p-2">
          <EmptyState title="تعذّر تحميل العملاء" description={error} action={<Button size="sm" variant="secondary" onClick={load}>{t.common.retry}</Button>} />
        </GlassCard>
      )}
      {loading && (
        <GlassCard className="p-4">
          <SkeletonTable rows={6} />
        </GlassCard>
      )}

      {!loading && visible.length > 0 && (
        <>
          <GlassCard className="hidden overflow-hidden md:block">
            <table className="data-table">
              <thead>
                <tr>
                  <th>العميل</th>
                  <th>{t.customer.phone}</th>
                  <th>{t.common.status}</th>
                  <th>{t.customer.identities}</th>
                  <th>{t.customer.lastActivity}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={c.name ?? c.phone} size="sm" />
                        <span className="min-w-0">
                          <Link href={`/conversations?q=${encodeURIComponent(c.phone ?? c.name ?? "")}`} className="block truncate font-bold text-ink hover:text-brand-600">
                            {c.name ?? "بدون اسم"}
                          </Link>
                          {c.tags.slice(0, 2).map((tag) => (
                            <span key={tag} className="me-1 text-[10px] text-ink-subtle">#{tag}</span>
                          ))}
                        </span>
                      </span>
                    </td>
                    <td className="num whitespace-nowrap text-ink-muted">{c.phone ?? "—"}</td>
                    <td><StatusBadge value={c.status} dot /></td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        {c.identities.length === 0 ? <span className="text-ink-subtle">—</span> : c.identities.map((i) => (
                          <Badge key={i.id} tone="OPEN">{label(i.channelType)}</Badge>
                        ))}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-xs text-ink-muted">{timeAgo(c.lastContactAt ?? c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassCard>

          <div className="grid gap-3 sm:grid-cols-2 md:hidden">
            {visible.map((c) => (
              <GlassCard key={c.id} className="p-4 transition-all active:scale-[0.99]">
                <div className="flex items-center gap-2.5">
                  <Avatar name={c.name ?? c.phone} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-ink">{c.name ?? "بدون اسم"}</p>
                    {c.phone && (
                      <p className="num mt-0.5 flex items-center gap-1 text-xs text-ink-muted" dir="ltr">
                        <Phone size={11} /> {c.phone}
                      </p>
                    )}
                  </div>
                  <StatusBadge value={c.status} dot />
                </div>
                <p className="mt-2 text-[11px] text-ink-subtle">{t.customer.lastActivity}: {timeAgo(c.lastContactAt ?? c.createdAt)}</p>
              </GlassCard>
            ))}
          </div>
        </>
      )}

      {!loading && visible.length === 0 && !error && (
        <GlassCard>
          <EmptyState
            icon={<Users size={28} strokeWidth={1.5} />}
            title="لا يوجد عملاء بعد"
            description="سيظهر العملاء هنا بمجرد وصول أول رسالة من قنواتك."
            action={<EmptyNext href="/channels">اربط قناة</EmptyNext>}
          />
        </GlassCard>
      )}
    </div>
  );
}
