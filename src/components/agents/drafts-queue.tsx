"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, FileText, Megaphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassCard } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { FixNote, HealthPill, RiskNote, SectionHead, apiJson, fmtDateTime, type Health } from "@/components/integrations/ui";

interface DraftView {
  id: string;
  source: string;
  kind: string;
  title: string;
  status: string;
  payload: Record<string, any>;
  resultRef: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string | null;
  createdAt: string;
  ageHours: number;
}

const STATUS: Record<string, { health: Health; label: string }> = {
  PENDING: { health: "warn", label: "بانتظارك" },
  DECIDING: { health: "warn", label: "عم تنقرر" },
  APPROVED: { health: "ok", label: "معتمدة" },
  EDITED: { health: "ok", label: "معتمدة بتعديل" },
  REJECTED: { health: "off", label: "مرفوضة" },
  EXPIRED: { health: "off", label: "انتهت" },
};

const SEGMENT_AR: Record<string, string> = {
  messaged_no_order: "راسلوا وما طلبوا",
  cancelled_before_shipping: "ألغوا قبل الشحن",
  repeat_product: "وقت إعادة الشراء",
};

function ReplyTemplateBody({ d, edits, setEdits, editable }: { d: DraftView; edits: { question: string; answer: string }; setEdits: (e: { question: string; answer: string }) => void; editable: boolean }) {
  const p = d.payload;
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-ink-muted">
        الموضوع: {p.topic ?? "—"}
        {p.productCode ? ` · المنتج ${p.productCode}` : " · عام"}
        {p.dialect ? ` · اللهجة ${p.dialect}` : ""}
      </p>
      {editable ? (
        <>
          <Field label="السؤال">
            <Input value={edits.question} onChange={(e) => setEdits({ ...edits, question: e.target.value })} maxLength={500} />
          </Field>
          <Field label="الجواب">
            <Textarea rows={3} value={edits.answer} onChange={(e) => setEdits({ ...edits, answer: e.target.value })} maxLength={2000} />
          </Field>
        </>
      ) : (
        <div className="rounded-xl bg-surface-3/60 p-3 text-xs leading-relaxed">
          <p className="font-bold text-ink">{p.question}</p>
          <p className="mt-1 text-ink-muted">{p.answer}</p>
        </div>
      )}
      {editable && (
        <>
          <RiskNote title="السؤال والجواب كتبهم الموديل — بعد الاعتماد بيصيروا جواب فعّال بيستخدمه الذكاء بردوده على الزبائن (مؤتمت)" />
          <FixNote>اقرأ الجواب كلمة كلمة وعدّله هون قبل «اعتماد» — الحارس بيرفض أرقام الهواتف والادعاءات الممنوعة من سيستم 1 بس، مش الأسعار أو الوعود الغلط.</FixNote>
        </>
      )}
    </div>
  );
}

function RetargetBody({ d }: { d: DraftView }) {
  const spec = d.payload.spec ?? {};
  const seg = spec.segment ?? {};
  return (
    <div className="space-y-2 text-xs">
      <ul className="grid grid-cols-1 gap-1 text-ink-muted sm:grid-cols-2">
        <li>الشريحة: <span className="font-semibold text-ink">{SEGMENT_AR[seg.kind] ?? seg.kind}</span>{Array.isArray(seg.days) ? ` (${seg.days[0]}–${seg.days[1]} يوم)` : ""}</li>
        <li>القالب: <span dir="ltr" className="font-mono text-ink">{spec.templateRef}</span></li>
        <li>سقف التكرار: رسالة كل {spec.frequencyCapDays ?? 7} يوم للشخص</li>
        <li>المؤهلين وقت المسودة: <span className="num font-semibold text-ink">{d.payload.eligibleCount ?? "—"}</span></li>
        {d.payload.productCode && (
          <li>
            المنتج: <span className="font-semibold text-ink">{d.payload.productCode}</span>
            {seg.kind === "messaged_no_order" ? " (رمز كليبر لهالمنتج بس)" : " (طلبات فيها هالمنتج بس)"}
          </li>
        )}
      </ul>
      {d.payload.offerNote && (
        <>
          <RiskNote title="ملاحظة العرض كتبها الموديل">
            <span className="font-normal">{String(d.payload.offerNote)}</span>
          </RiskNote>
          <FixNote>راجعها قبل الاعتماد — العرض الفعلي هو نص قالب واتساب المعتمد، مش هالملاحظة.</FixNote>
        </>
      )}
      <RiskNote title="حملة رسائل لزبائن — بعد اعتماد إرسالها بصفحة الحملات بتطلع لحالها (مؤتمت)" />
      <FixNote>الاعتماد هون بيعمل حملة «جاهزة» بس، ولا رسالة بتطلع قبل اعتمادها بصفحة الحملات (للموافقين على الرسائل فقط وبقالب واتساب معتمد) — راجع الجمهور والقالب هناك.</FixNote>
    </div>
  );
}

export function DraftsQueue({ highlightId, refreshKey }: { highlightId: string | null; refreshKey: number }) {
  const toast = useToast();
  const [tab, setTab] = useState("PENDING");
  const [drafts, setDrafts] = useState<DraftView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, { question: string; answer: string }>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const q = tab === "ALL" ? "" : `?status=${tab}`;
      const rows = await apiJson<DraftView[]>(`/api/agent-drafts${q}`);
      setDrafts(rows);
      setEdits((prev) => {
        const next = { ...prev };
        for (const d of rows) if (d.kind === "reply_template" && !next[d.id]) next[d.id] = { question: String(d.payload.question ?? ""), answer: String(d.payload.answer ?? "") };
        return next;
      });
    } catch {
      setDrafts([]);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!highlightId || !drafts) return;
    document.getElementById(`draft-${highlightId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightId, drafts]);

  async function decide(d: DraftView, decision: "approve" | "reject") {
    setBusy(d.id);
    try {
      const e = edits[d.id];
      const changed =
        d.kind === "reply_template" && e && (e.question.trim() !== String(d.payload.question) || e.answer.trim() !== String(d.payload.answer));
      await apiJson(`/api/agent-drafts/${d.id}`, {
        method: "POST",
        json: {
          decision,
          ...(notes[d.id]?.trim() ? { note: notes[d.id].trim() } : {}),
          ...(decision === "approve" && changed ? { edits: { question: e!.question.trim(), answer: e!.answer.trim() } } : {}),
        },
      });
      toast.show(decision === "approve" ? (d.kind === "retarget_campaign" ? "انعملت حملة جاهزة — اعتمد الإرسال من صفحة الحملات" : "صار سؤال شائع فعّال") : "انرفضت المسودة");
      await load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل القرار", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <GlassCard className="space-y-3 p-4 sm:p-5">
      <SectionHead icon={<FileText size={15} />} title="مسودات الوكيل الذكي" sub="«المسودة مسودة»: ولا أثر برّا قبل قرارك. المسودة بتنتهي بعد 7 أيام بلا قرار." tone="violet" />
      <Tabs
        items={[
          { key: "PENDING", label: "بانتظارك" },
          { key: "ALL", label: "الكل" },
        ]}
        activeKey={tab}
        onSelect={setTab}
      />
      {drafts === null ? (
        <p className="text-xs text-ink-subtle">جارٍ التحميل…</p>
      ) : drafts.length === 0 ? (
        <p className="text-xs text-ink-subtle">{tab === "PENDING" ? "ما في شي بانتظارك." : "ما في مسودات لسا."}</p>
      ) : (
        <ul className="space-y-3">
          {drafts.map((d) => {
            const st = STATUS[d.status] ?? { health: "off" as Health, label: d.status };
            const pending = d.status === "PENDING";
            return (
              <li
                key={d.id}
                id={`draft-${d.id}`}
                className={`glass-subtle space-y-2.5 rounded-xl p-3.5 ${highlightId === d.id ? "ring-2 ring-brand-500/60" : ""}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="flex min-w-0 items-start gap-1.5 text-xs font-bold text-ink">
                    {d.kind === "retarget_campaign" ? <Megaphone size={14} className="mt-0.5 shrink-0 text-ink-subtle" /> : <FileText size={14} className="mt-0.5 shrink-0 text-ink-subtle" />}
                    <span className="break-words">{d.title}</span>
                  </p>
                  <HealthPill health={st.health}>{st.label}</HealthPill>
                </div>
                <p className="text-[11px] text-ink-subtle">
                  مصدرها الوكيل الذكي · قبل {d.ageHours} ساعة{pending && d.expiresAt ? ` · بتنتهي ${fmtDateTime(d.expiresAt)}` : ""}
                  {d.decidedAt ? ` · القرار ${fmtDateTime(d.decidedAt)}` : ""}
                </p>
                {d.kind === "reply_template" ? (
                  <ReplyTemplateBody d={d} edits={edits[d.id] ?? { question: "", answer: "" }} setEdits={(e) => setEdits((x) => ({ ...x, [d.id]: e }))} editable={pending} />
                ) : (
                  <RetargetBody d={d} />
                )}
                {pending && (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <Field label="ملاحظة (اختياري)" className="flex-1">
                      <Input value={notes[d.id] ?? ""} onChange={(e) => setNotes((x) => ({ ...x, [d.id]: e.target.value }))} maxLength={500} />
                    </Field>
                    <div className="flex gap-2">
                      <Button size="sm" variant="success" onClick={() => decide(d, "approve")} loading={busy === d.id} disabled={busy !== null}>
                        <Check size={13} />
                        اعتماد
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => decide(d, "reject")} disabled={busy !== null}>
                        <X size={13} />
                        رفض
                      </Button>
                    </div>
                  </div>
                )}
                {d.decisionNote && <p className="text-[11px] text-ink-muted">ملاحظة القرار: {d.decisionNote}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </GlassCard>
  );
}
