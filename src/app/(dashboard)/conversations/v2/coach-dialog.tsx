"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

interface Suggestion {
  kind?: string;
  reason?: string;
  draftText?: string;
}
interface Coach {
  suggestions?: Suggestion[];
  noOfferReason?: string;
}

const KIND: Record<string, string> = { OBJECTION: "معالجة اعتراض", DISCOUNT: "خصم", CROSS_SELL: "بيع مُكمِّل", OFFER: "عرض" };

/** «اقتراحات رد» (كان «مساعد البيع»): اقتراحات داخلية بس — ما بينبعت شي للعميل تلقائيًا، «أدرج بالمحرر» بيحطها بالمؤلّف. */
export function CoachDialog({ open, conversationId, onClose, onInsert }: { open: boolean; conversationId: string | null; onClose: () => void; onInsert: (text: string) => void }) {
  const [data, setData] = useState<Coach | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    setFailed(false);
    try {
      // body فاضي كان يرجّع INVALID_BODY: المسار schema strict لازم JSON حتى لو {}.
      const r = await api<{ data?: Coach }>(`/api/conversations/${conversationId}/coach`, { method: "POST", json: {} });
      setData(r.data ?? null);
    } catch {
      setData(null);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    setData(null);
    if (open) void load();
  }, [open, load]);

  return (
    <Dialog open={open} onClose={onClose} title="اقتراحات رد" className="max-w-lg">
      <p className="text-xs text-ink-subtle">اقتراحات داخلية فقط — ما بينبعت شي للعميل تلقائيًا.</p>
      {loading ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : failed ? (
        <div role="alert" className="mt-4 space-y-2">
          <p className="text-sm text-danger">تعذّر جلب الاقتراحات</p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            أعد المحاولة
          </Button>
        </div>
      ) : !data || (data.suggestions ?? []).length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">{data?.noOfferReason ? `ما في اقتراح: ${data.noOfferReason}` : "ما في اقتراحات هلأ."}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {(data.suggestions ?? []).map((s, i) => (
            <li key={i} className="rounded-card border border-line bg-surface-3 p-3">
              <p className="text-xs font-semibold text-primary">
                {(s.kind && KIND[s.kind]) || "تلميح رد"}
                {s.reason ? ` · ${s.reason}` : ""}
              </p>
              {s.draftText && (
                <>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink">{s.draftText}</p>
                  <Button size="sm" variant="secondary" className="mt-2" onClick={() => onInsert(s.draftText!)}>
                    أدرج بالمحرر
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-start">
        <Button size="sm" variant="secondary" onClick={onClose}>
          تراجع
        </Button>
      </div>
    </Dialog>
  );
}
