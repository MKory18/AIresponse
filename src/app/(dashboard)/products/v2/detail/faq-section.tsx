"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Can } from "@/components/auth/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RowToggle } from "../row-toggle";
import { useToast } from "@/components/ui/toast";
import { DETAIL_STRINGS as D } from "./strings";

interface Faq {
  id: string;
  question: string;
  answer: string;
  isActive: boolean;
}

/** أسئلة المنتج الشائعة: بتنحفظ فورًا (مش جزء من حفظ الصفحة). القائمة كاملة (الشغّال والمتوقف). */
export function FaqSection({ productId }: { productId: string }) {
  const toast = useToast();
  const [items, setItems] = useState<Faq[]>([]);
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Faq[] }>(`/api/faqs?productId=${productId}`)).items);
    } catch {
      /* القسم اختياري: الفشل ما بيوقف الصفحة */
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!q.trim() || !a.trim()) return;
    setBusy(true);
    try {
      await api("/api/faqs", { method: "POST", json: { question: q.trim(), answer: a.trim(), productId } });
      setQ("");
      setA("");
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذّر الحفظ", "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(f: Faq, next: boolean) {
    setItems((prev) => prev.map((x) => (x.id === f.id ? { ...x, isActive: next } : x)));
    try {
      await api(`/api/faqs/${f.id}`, { method: "PATCH", json: { isActive: next } });
    } catch (e) {
      setItems((prev) => prev.map((x) => (x.id === f.id ? { ...x, isActive: f.isActive } : x)));
      toast.show(e instanceof Error ? e.message : "تعذّر الحفظ", "error");
    }
  }

  return (
    <section className="space-y-3 rounded-card border border-line bg-surface-2 p-5" data-faq>
      <div>
        <h3 className="text-sm font-semibold text-ink">{D.faqTitle}</h3>
        <p className="text-caption text-ink-muted">{D.faqHint}</p>
      </div>
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((f) => (
            <li key={f.id} className="flex items-start justify-between gap-3 rounded-control bg-surface-3 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{f.question}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">{f.answer}</p>
              </div>
              <Can permission="knowledge.write" fallback={<span className="shrink-0 text-xs text-ink-muted">{f.isActive ? D.faqOn : D.faqOff}</span>}>
                <RowToggle checked={f.isActive} label={`${f.question}: ${D.faqOn}`} onChange={(next) => void toggle(f, next)} />
              </Can>
            </li>
          ))}
        </ul>
      )}
      <Can permission="knowledge.write">
        <div className="grid gap-2 border-t border-line pt-3 sm:grid-cols-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={D.faqQuestion} aria-label={D.faqQuestion} />
          <Input value={a} onChange={(e) => setA(e.target.value)} placeholder={D.faqAnswer} aria-label={D.faqAnswer} />
          <div className="sm:col-span-2">
            <Button size="sm" variant="secondary" type="button" onClick={() => void add()} loading={busy} disabled={!q.trim() || !a.trim()}>
              {D.faqAdd}
            </Button>
          </div>
        </div>
      </Can>
    </section>
  );
}
