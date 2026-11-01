"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, History, MapPin, MessageSquare, Receipt, Trash2, UserRound } from "lucide-react";
import { label } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";

type OrderDetail = {
  canWrite?: boolean;
  /** حذف الطلبات للمالك فقط (OWNER) — الخادم هو اللي بيقرر. */
  canDelete?: boolean;
  id: string;
  orderNumber: string;
  status: string;
  confirmationStatus: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  subtotal: string;
  discount: string;
  deliveryFee: string;
  total: string;
  currency: string;
  province: string | null;
  deliveryAddress: string | null;
  notes: string | null;
  createdAt: string;
  customer: { id: string; name: string | null; phone: string | null };
  /** المحادثة الي انعمل منها الطلب (إذا في) — منها «افتح المحادثة». */
  conversationId?: string | null;
  items: { id: string; productNameSnapshot: string; skuSnapshot: string; unitPrice: string; quantity: number; subtotal: string }[];
  timeline: { id: string; action: string; metadata: Record<string, unknown>; createdAt: string }[];
};

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  NEW: ["CONFIRMED", "CANCELLED"],
  CONFIRMATION_PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["OUT_FOR_DELIVERY", "CANCELLED"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  DELIVERED: ["RETURNED"],
};

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/orders/${params.id}`);
    if (!res.ok) {
      setError("الطلب غير موجود");
      return;
    }
    setOrder(await res.json());
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function changeStatus(status: string) {
    // الإلغاء قرار حساس — عبر نافذة تأكيد (P11)
    if (status === "CANCELLED") {
      setConfirmCancel(true);
      return;
    }
    setSaving(true);
    const res = await fetch(`/api/orders/${params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "انتقال غير مسموح");
    }
    load();
  }

  async function deleteThisOrder() {
    setSaving(true);
    const res = await fetch(`/api/orders/${params.id}`, { method: "DELETE" });
    if (!res.ok) {
      setSaving(false);
      const data = await res.json().catch(() => ({}));
      setError((data as { message?: string }).message ?? "تعذّر حذف الطلب");
      setConfirmDelete(false);
      return;
    }
    // الطلب انحذف — ما في صفحة نرجع إلها، للقائمة مباشرة.
    router.push("/orders");
  }

  if (error && !order) {
    return (
      <div className="page-wrap">
        <GlassCard className="p-2">
          <EmptyState title="الطلب غير موجود" description={error} action={<Link href="/orders"><Button size="sm" variant="secondary">العودة للطلبات</Button></Link>} />
        </GlassCard>
      </div>
    );
  }
  if (!order) {
    return (
      <div className="page-wrap space-y-3">
        <Skeleton className="h-20 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  const transitions = ALLOWED_TRANSITIONS[order.status] ?? [];

  return (
    <div className="page-wrap">
      <Link href="/orders" className="inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-ink">
        <ArrowRight size={13} aria-hidden /> كل الطلبات
      </Link>
      <PageHeader
        title={`طلب ${order.orderNumber}`}
        description={order.createdAt ? new Date(order.createdAt).toLocaleString("ar") : undefined}
        actions={
          <>
            {transitions.map((next) => (
              <Button
                key={next}
                size="sm"
                variant={next === "CANCELLED" ? "danger" : "secondary"}
                onClick={() => changeStatus(next)}
                disabled={saving}
                loading={saving}
              >
                <ArrowLeft size={13} />
                {label(next)}
              </Button>
            ))}
            {order.canDelete && (
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)} disabled={saving} title="حذف الطلب نهائيًا (المالك فقط)">
                <Trash2 size={13} /> حذف الطلب
              </Button>
            )}
          </>
        }
      />
      {error && (
        <GlassCard level="glass-subtle" className="border-red-500/20 px-4 py-2.5 text-sm text-red-600 dark:text-red-400">{error}</GlassCard>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <GlassCard className="p-4 sm:p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
                <Receipt size={15} />
              </span>
              البنود
            </h2>
            <div className="mt-3 divide-y divide-line/60">
              {order.items.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-bold text-ink">{item.productNameSnapshot}</p>
                    <p className="num mt-0.5 text-xs text-ink-subtle" dir="ltr">{item.skuSnapshot}</p>
                  </div>
                  <div className="num shrink-0 text-end" dir="ltr">
                    <p className="font-semibold text-ink">{Number(item.unitPrice).toLocaleString()} × {item.quantity}</p>
                    <p className="text-xs text-ink-muted">{Number(item.subtotal).toLocaleString()} {order.currency}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="num mt-3 space-y-1.5 rounded-xl bg-surface-3/60 p-3.5 text-sm" dir="ltr">
              <p className="flex justify-between text-ink-muted"><span>المجموع الفرعي</span><span>{Number(order.subtotal).toLocaleString()}</span></p>
              <p className="flex justify-between text-ink-muted"><span>الخصم</span><span>{Number(order.discount).toLocaleString()}</span></p>
              <p className="flex justify-between text-ink-muted"><span>التوصيل</span><span>{Number(order.deliveryFee).toLocaleString()}</span></p>
              <p className="flex justify-between border-t border-line pt-1.5 text-base font-bold text-ink"><span>الإجمالي</span><span>{Number(order.total).toLocaleString()} {order.currency}</span></p>
            </div>
          </GlassCard>

          <GlassCard className="p-4 sm:p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-3 text-ink-muted">
                <History size={15} />
              </span>
              السجل الزمني
            </h2>
            {order.timeline.length === 0 && <p className="mt-2 text-xs text-ink-subtle">لا يوجد سجل.</p>}
            <ol className="relative mt-3 space-y-3 border-s border-line ps-4">
              {order.timeline.map((entry) => (
                <li key={entry.id} className="text-xs">
                  <span aria-hidden className="absolute -start-[5px] mt-1 h-2 w-2 rounded-full bg-brand-500 ring-2 ring-surface-2" />
                  <p className="font-bold text-ink">{label(entry.action) ?? entry.action}</p>
                  <p className="mt-0.5 text-ink-subtle">{new Date(entry.createdAt).toLocaleString("ar")}</p>
                </li>
              ))}
            </ol>
          </GlassCard>
        </div>

        <div className="space-y-4">
          <GlassCard className="p-4 text-sm">
            <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
                <UserRound size={15} />
              </span>
              العميل
            </h2>
            <p className="mt-2.5 font-bold text-ink">{order.customer.name ?? "—"}</p>
            <p className="num mt-0.5 text-xs text-ink-muted" dir="ltr">{order.customer.phone ?? ""}</p>
            <Link
              href={
                order.conversationId
                  ? `/conversations?id=${order.conversationId}`
                  : `/conversations?q=${encodeURIComponent(order.customer.phone ?? order.customer.name ?? "")}`
              }
              className="mt-2.5 inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
            >
              <MessageSquare size={13} aria-hidden /> افتح المحادثة
            </Link>
          </GlassCard>
          <GlassCard className="p-4 text-sm">
            <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
                <MapPin size={15} />
              </span>
              التوصيل
            </h2>
            <p className="mt-2.5 text-xs text-ink-subtle">العنوان</p>
            <p className="font-medium text-ink">{order.deliveryAddress ?? "—"}</p>
            <p className="mt-2 text-xs text-ink-subtle">المحافظة</p>
            <p className="font-medium text-ink">{order.province ?? "—"}</p>
            {order.notes && (
              <>
                <p className="mt-2 text-xs text-ink-subtle">ملاحظات</p>
                <p className="font-medium text-ink">{order.notes}</p>
              </>
            )}
          </GlassCard>
          <GlassCard className="space-y-1.5 p-4 text-xs">
            <h2 className="mb-1 text-sm font-bold text-ink">الحالات</h2>
            <p className="flex items-center justify-between text-ink-muted">الطلب <StatusBadge value={order.status} dot /></p>
            <p className="flex items-center justify-between text-ink-muted">التأكيد <StatusBadge value={order.confirmationStatus} dot /></p>
            <p className="flex items-center justify-between text-ink-muted">الدفع <StatusBadge value={order.paymentStatus} dot /></p>
            <p className="flex items-center justify-between text-ink-muted">التنفيذ <StatusBadge value={order.fulfillmentStatus} dot /></p>
          </GlassCard>
        </div>
      </div>
      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          void (async () => {
            setSaving(true);
            const res = await fetch(`/api/orders/${params.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "CANCELLED" }),
            });
            setSaving(false);
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              setError(data.message ?? "انتقال غير مسموح");
            }
            load();
          })();
        }}
        title={`إلغاء الطلب ${order.orderNumber}؟`}
        body="سيُلغى الطلب نهائيًا وفق انتقالات الحالة المسموحة. لا يمكن التراجع من هذه الواجهة."
        confirmLabel="إلغاء الطلب"
        busy={saving}
        danger
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void deleteThisOrder()}
        title={`حذف الطلب ${order.orderNumber} نهائيًا؟`}
        body="ينحذف الطلب مع كل بنوده من النظام، وما بيرجع. سجل التدقيق بيحفظ العملية (الرقم · المجموع · الحالة) — الإجراء متاح للمالك فقط."
        confirmLabel="حذف نهائي"
        busy={saving}
        danger
      />
    </div>
  );
}
