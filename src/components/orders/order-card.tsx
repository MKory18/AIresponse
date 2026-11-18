"use client";

import { useEffect, useState } from "react";
import { Clock, MapPin, MoreHorizontal, Package, Phone, User } from "lucide-react";
import { formatNumber } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { isSealed, orderStatusLabel, reviewReason, settleCountdown, type StatusTone } from "@/lib/order-status";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { RiskWithFix } from "../integrations/ui";
import type { OrderCardData } from "@/modules/orders/reader/card";

/**
 * «بطاقة الطلب» (الحزمة 1.8) — بدل «مسودة طلب» لما `orderMode ≠ LEGACY_DRAFT`.
 * سطر حالة واحد · القيم **كاملة** (الموظف لازم يقدر يتحقق) · العدّاد · أزرار بالكتير:
 * «ثبّت الآن» · «أوقف/أطلق» · «عدّل» — والباقي (إلغاء · أعد القراءة) بقائمة «⋯».
 * أي خطر بالأحمر وتصحيحه بالبرتقالي تحته. مكوّن نظيف بينتقل كما هو للواجهة الجديدة (الحزمة 3.1).
 */
export interface OrderCardCan {
  seal: boolean;
  write: boolean;
  cancel: boolean;
  amend: boolean;
  reply: boolean;
}

const TONE: Record<StatusTone, string> = {
  info: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warn: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  bad: "bg-red-500/10 text-red-700 dark:text-red-300",
  muted: "bg-surface-3 text-ink-muted",
};

const STAGE_AR: Record<string, string> = {
  NONE: "ما في طلب بالمحادثة",
  INTERESTED: "مهتم — لسا ما بدأ الطلب",
  COLLECTING: "قيد التجميع",
  COMPLETE: "البيانات مكتملة",
  CANCELLED: "العميل ألغى",
};
const MISSING_AR: Record<string, string> = { product: "المنتج", quantity: "الكمية", phone: "الهاتف", address: "العنوان", name: "الاسم" };
const KIND_AR: Record<string, string> = {
  READ: "قراءة من المحادثة",
  STAFF_EDIT: "تعديل موظف",
  SEAL: "تثبيت",
  AMEND_REQUEST: "طلب تعديل بعد التثبيت",
  AMEND_APPLIED: "تم التعديل",
  AMEND_REJECTED: "رُفض التعديل",
  CANCEL_REQUEST: "طلب إلغاء بعد التثبيت",
  CANCEL_APPLIED: "تم الإلغاء",
};
const FIELD_AR: Record<string, string> = {
  recipientName: "الاسم",
  recipientPhone: "الهاتف",
  recipientAltPhone: "هاتف إضافي",
  deliveryAddress: "العنوان",
  province: "المحافظة",
  notes: "الملاحظات",
  items: "البنود",
  status: "الحالة",
  hold: "الإيقاف",
  reviewReasons: "أسباب المراجعة",
};

const showVal = (v: unknown): string => {
  if (Array.isArray(v)) return v.length ? `${v.length}` : "—";
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "نعم" : "لا";
  return String(v);
};
const diffText = (diff: Array<{ field: string; from: unknown; to: unknown }>) =>
  diff.map((d) => `${FIELD_AR[d.field] ?? d.field}: ${showVal(d.from)} ← ${showVal(d.to)}`).join(" · ");

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: { message?: string } };
    return res.ok ? { ok: true, message: "تم" } : { ok: false, message: data.message ?? data.error?.message ?? "تعذّر تنفيذ الإجراء" };
  } catch {
    return { ok: false, message: "تعذّر الاتصال بالخادم" };
  }
}

export function OrderCard({ card, can, onChanged }: { card: OrderCardData; can: OrderCardCan; onChanged: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  const order = card.order;
  const reading = card.reading;
  const sealed = order ? isSealed(order) : false;
  const awaiting = !!order && order.status === "NEW" && !order.heldBy;

  // عدّاد التثبيت: tick كل ثانية بس لما في طلب بيستنى.
  useEffect(() => {
    if (!awaiting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [awaiting]);

  async function run(action: () => Promise<{ ok: boolean; message: string }>, okText: string) {
    setBusy(true);
    setMsg(null);
    const r = await action();
    setBusy(false);
    setMenuOpen(false);
    setMsg({ ok: r.ok, text: r.ok ? okText : r.message });
    if (r.ok) onChanged();
  }

  const status = order ? orderStatusLabel(order) : null;
  const countdown = awaiting ? settleCountdown(order!.settleAt, now) : null;
  const statusLine = order
    ? awaiting && countdown
      ? `⏳ يتثبّت خلال ${countdown}`
      : sealed
        ? `${status!.text} · ${order.orderNumber}`
        : status!.text
    : reading
      ? STAGE_AR[reading.stage] ?? reading.stage
      : "ما في طلب بالمحادثة";
  const tone: StatusTone = status ? status.tone : reading && ["COLLECTING", "COMPLETE"].includes(reading.stage) ? "warn" : "muted";

  const items = order ? order.items : reading?.items ?? [];
  const r = reading?.recipient;
  const name = order ? order.recipientName : r?.name ?? null;
  const phone = order ? order.recipientPhone : r?.phone ?? null;
  const alt = order ? order.recipientAltPhone : r?.altPhone ?? null;
  const address = order ? order.deliveryAddress : r?.address ?? null;
  const province = order ? order.province : r?.province ?? null;
  const currency = order ? order.currency : reading?.currency ?? "";
  const total = order ? order.total : items.reduce((s, i) => s + (i.quantity ?? 0) * i.unitPrice, 0);
  const reasons = order && !sealed ? order.reviewReasons : [];
  const missing = !order && reading ? reading.missing : [];
  const failed = reading?.status === "FAILED";

  if (!order && !reading) {
    return (
      <div className="rounded-2xl border border-line bg-surface-2/60 p-3.5 text-[11px] leading-relaxed text-ink-subtle">
        <p className="mb-1 flex items-center gap-1.5 text-xs font-bold text-ink">
          <Package size={13} /> بطاقة الطلب
        </p>
        الوكيل لسا ما قرأ هالمحادثة. أول ما العميل يذكر منتج أو رقم، بتظهر بياناته هون.
      </div>
    );
  }

  return (
    <div className="space-y-2.5 rounded-2xl border border-line bg-surface-2/60 p-3.5" data-order-card>
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-bold text-ink">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <Package size={13} />
          </span>
          بطاقة الطلب
        </p>
        <div className="relative">
          <button
            type="button"
            aria-label="المزيد"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition hover:bg-surface-hover"
          >
            <MoreHorizontal size={15} />
          </button>
          {menuOpen && (
            <div className="absolute end-0 z-20 mt-1 w-40 overflow-hidden rounded-xl border border-line bg-surface-2 py-1 text-xs shadow-lg">
              {can.reply && (
                <button type="button" disabled={busy} className="block w-full px-3 py-2 text-start hover:bg-surface-hover" onClick={() => run(() => call(`/api/conversations/${card.conversationId}/reread`, "POST"), "تم — القراءة بتنعاد خلال لحظات")}>
                  أعد القراءة
                </button>
              )}
              {can.cancel && order && (!sealed || can.cancel) && order.status !== "CANCELLED" && (
                <button type="button" disabled={busy} className="block w-full px-3 py-2 text-start text-red-700 hover:bg-surface-hover dark:text-red-300" onClick={() => { setMenuOpen(false); setCancelOpen(true); }}>
                  {sealed ? "اطلب إلغاء" : "ألغِ الطلب"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <p className={cn("inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-bold", TONE[tone])} aria-live="polite">
        {awaiting && <Clock size={12} />}
        {statusLine}
      </p>
      {sealed && order && order.omsStatus && (
        <p className="text-[10px] text-ink-subtle">حالة الـ OMS: {order.omsStatus}{order.omsShippingStatus ? ` · ${order.omsShippingStatus}` : ""}</p>
      )}

      {failed && (
        <RiskWithFix
          risk="تعذّرت قراءة المحادثة"
          detail={reading?.lastError ?? undefined}
          fix="القراءة بتنعاد لحالها. إذا استمر، افتح الطلب يدويًا من الرسائل أو اضغط «أعد القراءة»."
        />
      )}

      {/* القيم كاملة — الموظف لازم يتحقق منها */}
      <div className="space-y-1 rounded-xl bg-surface-3/50 p-2.5 text-[11px]">
        {items.length === 0 ? (
          <p className="text-ink-subtle">المنتجات: —</p>
        ) : (
          items.map((i, idx) => (
            <p key={`${i.name}-${idx}`} className="flex items-center justify-between gap-2 text-ink">
              <span className="min-w-0 flex-1 truncate">
                {i.name}
                {i.quantity ? ` × ${formatNumber(i.quantity)}` : ""}
              </span>
              <span className="num shrink-0 text-ink-muted" dir="ltr">
                {formatNumber(i.unitPrice)} {currency}
              </span>
            </p>
          ))
        )}
        {(order || items.length > 0) && (
          <p className="flex items-center justify-between border-t border-line pt-1 font-bold text-ink">
            <span>الإجمالي</span>
            <span className="num" dir="ltr">
              {formatNumber(total)} {currency}
            </span>
          </p>
        )}
      </div>

      <div className="space-y-1 text-[11px] text-ink-muted">
        <Field icon={<User size={11} />} label="الاسم" value={name} />
        <Field icon={<Phone size={11} />} label="الهاتف" value={phone} ltr />
        {alt && <Field icon={<Phone size={11} />} label="هاتف إضافي" value={alt} ltr />}
        <Field icon={<MapPin size={11} />} label="العنوان" value={[province, address].filter(Boolean).join(" · ") || null} />
      </div>
      {missing.length > 0 && <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">ينقص: {missing.map((m) => MISSING_AR[m] ?? m).join("، ")}</p>}

      {reasons.slice(0, 3).map((code) => {
        const info = reviewReason(code);
        return <RiskWithFix key={code} risk={info.risk} fix={info.fix} />;
      })}
      {reasons.length > 3 && <p className="text-[10px] text-ink-subtle">+{reasons.length - 3} أسباب تانية</p>}

      {card.pendingChange && (
        <div className="space-y-1.5">
          <RiskWithFix
            risk={card.pendingChange.kind === "CANCEL_REQUEST" ? "في طلب إلغاء بعد التثبيت" : "في طلب تعديل بعد التثبيت"}
            detail={diffText(card.pendingChange.diff)}
            fix={card.pendingChange.omsState === "NOTE_SENT" ? "انبعتت ملاحظة للـ OMS. نفّذه هناك، وبعدين اضغط «تم بالـ OMS»." : "نفّذه بالـ OMS يدويًا، وبعدين اضغط «تم بالـ OMS» أو «مرفوض»."}
          />
          {can.amend && order && (
            <div className="flex gap-1.5">
              <Button size="sm" disabled={busy} onClick={() => run(() => call(`/api/orders/${order.id}/amendments/${card.pendingChange!.version}`, "POST", { decision: "APPLIED" }), "تم تسجيل التنفيذ")}>
                تم بالـ OMS
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => call(`/api/orders/${order.id}/amendments/${card.pendingChange!.version}`, "POST", { decision: "REJECTED" }), "تم تسجيل الرفض")}>
                مرفوض
              </Button>
            </div>
          )}
        </div>
      )}

      {msg && <p className={cn("text-[11px] font-semibold", msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-300")} role="status">{msg.text}</p>}

      {/* أزرار بالكتير: ثبّت الآن · أوقف/أطلق · عدّل */}
      {order && order.status !== "CANCELLED" && (
        <div className="flex flex-wrap gap-1.5">
          {!sealed && can.seal && (
            <Button size="sm" disabled={busy} onClick={() => run(() => sealCall(order.id), "تم التثبيت")}>
              ثبّت الآن
            </Button>
          )}
          {!sealed && can.seal && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => call(`/api/orders/${order.id}/${order.heldBy ? "release" : "hold"}`, "POST"), order.heldBy ? "تم الإطلاق" : "تم الإيقاف")}>
              {order.heldBy ? "أطلق" : "أوقف"}
            </Button>
          )}
          {(sealed ? can.amend : can.write) && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditOpen(true)}>
              {sealed ? "اطلب تعديل" : "عدّل"}
            </Button>
          )}
        </div>
      )}

      {card.timeline.length > 0 && (
        <div>
          <button type="button" className="text-[11px] font-bold text-brand-600 dark:text-brand-300" onClick={() => setLogOpen((v) => !v)} aria-expanded={logOpen}>
            السجل {logOpen ? "▴" : "▾"}
          </button>
          {logOpen && (
            <ol className="mt-1.5 space-y-1 text-[10px] text-ink-muted">
              {card.timeline.map((t) => (
                <li key={t.version}>
                  <span className="font-semibold text-ink">{KIND_AR[t.kind] ?? t.kind}</span>
                  {t.diff.length > 0 && <span> — {diffText(t.diff)}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {order && (
        <>
          <EditDialog open={editOpen} onClose={() => setEditOpen(false)} sealed={sealed} order={order} onSubmit={(fields) => run(() => call(`/api/orders/${order.id}/fields`, "PATCH", fields), sealed ? "تم تسجيل طلب التعديل" : "تم الحفظ")} />
          <ConfirmDialog
            open={cancelOpen}
            onClose={() => setCancelOpen(false)}
            onConfirm={() => {
              setCancelOpen(false);
              void run(() => call(`/api/orders/${order.id}/cancel`, "POST", {}), sealed ? "تم تسجيل طلب الإلغاء" : "تم الإلغاء");
            }}
            title={sealed ? "طلب إلغاء الطلب؟" : "إلغاء الطلب؟"}
            body={sealed ? "الطلب مثبّت: بيتسجّل طلب إلغاء وبيوصل الفريق (وبينبعت للـ OMS كملاحظة إذا انبعت)." : "الطلب ما انبعت لأي مكان، وبيتلغي هون."}
            confirmLabel={sealed ? "اطلب الإلغاء" : "ألغِ الطلب"}
            busy={busy}
            danger
          />
        </>
      )}
    </div>
  );
}

async function sealCall(id: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`/api/orders/${id}/seal`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { sealed?: boolean; reason?: string; message?: string };
    if (!res.ok) return { ok: false, message: data.message ?? "تعذّر التثبيت" };
    if (data.sealed === false) {
      const why: Record<string, string> = {
        BLACKLISTED: "العميل بالقائمة السوداء بالـ OMS — الطلب راح للمراجعة.",
        NOT_SEALABLE: "الطلب ما بينثبّت بهالحالة.",
        RACE_LOST: "الطلب اتغيّر بنفس اللحظة — جرّب مرة ثانية.",
        STALE_READING: "في رسالة جديدة لسا ما انقرأت.",
        ON_HOLD: "الطلب موقوف.",
      };
      return { ok: false, message: why[data.reason ?? ""] ?? "ما انثبّت الطلب" };
    }
    return { ok: true, message: "تم" };
  } catch {
    return { ok: false, message: "تعذّر الاتصال بالخادم" };
  }
}

function Field({ icon, label, value, ltr }: { icon: React.ReactNode; label: string; value: string | null; ltr?: boolean }) {
  return (
    <p className={cn("flex items-start gap-1.5", value ? "text-ink-muted" : "text-amber-700 dark:text-amber-400")}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="shrink-0 font-semibold">{label}:</span>
      <span className="min-w-0 flex-1 break-words" dir={ltr ? "ltr" : undefined}>
        {value ?? "—"}
      </span>
    </p>
  );
}

function EditDialog({
  open,
  onClose,
  sealed,
  order,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  sealed: boolean;
  order: NonNullable<OrderCardData["order"]>;
  onSubmit: (fields: Record<string, string | null>) => void;
}) {
  const initial = {
    recipientName: order.recipientName ?? "",
    recipientPhone: order.recipientPhone ?? "",
    recipientAltPhone: order.recipientAltPhone ?? "",
    province: order.province ?? "",
    deliveryAddress: order.deliveryAddress ?? "",
  };
  const [vals, setVals] = useState(initial);
  useEffect(() => {
    if (open) setVals(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order.id]);

  const fields: Array<[keyof typeof initial, string, boolean]> = [
    ["recipientName", "الاسم", false],
    ["recipientPhone", "الهاتف", true],
    ["recipientAltPhone", "هاتف إضافي", true],
    ["province", "المحافظة", false],
    ["deliveryAddress", "العنوان", false],
  ];
  function submit() {
    const changed: Record<string, string | null> = {};
    for (const [k] of fields) if (vals[k].trim() !== initial[k]) changed[k] = vals[k].trim() || null;
    if (Object.keys(changed).length === 0) return onClose();
    onClose();
    onSubmit(changed);
  }
  return (
    <Dialog open={open} onClose={onClose} title={sealed ? "طلب تعديل (الطلب مثبّت)" : "تعديل الطلب"} className="max-w-md">
      <div className="space-y-2.5">
        {sealed && <p className="text-[11px] text-ink-subtle">الطلب مثبّت: بيتسجّل طلب تعديل وبيتنفّذ بالـ OMS، وما بيتغيّر الطلب هون لحد ما تأكّد «تم بالـ OMS».</p>}
        {fields.map(([k, label, ltr]) => (
          <label key={k} className="block text-xs font-semibold text-ink">
            {label}
            <Input value={vals[k]} dir={ltr ? "ltr" : undefined} onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))} className="mt-1" />
          </label>
        ))}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose}>إلغاء</Button>
          <Button size="sm" onClick={submit}>{sealed ? "أرسل الطلب" : "احفظ"}</Button>
        </div>
      </div>
    </Dialog>
  );
}
