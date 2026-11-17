"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { RuleView } from "@/modules/delivery-rules/service";
import { DELIVERY_STRINGS as S } from "./strings";

export interface RuleDraft {
  province: string;
  fee: string;
  freeOver: string;
  currency: string;
  isAvailable: boolean;
}

export const emptyDraft = (province = ""): RuleDraft => ({ province, fee: "", freeOver: "", currency: "", isAvailable: true });
export const draftFromRule = (r: RuleView): RuleDraft => ({
  province: r.province,
  fee: String(r.fee),
  freeOver: r.freeOver === null ? "" : String(r.freeOver),
  currency: r.currency ?? "",
  isAvailable: r.isAvailable,
});

/** نموذج إضافة/تعديل منطقة. المحافظة قابلة للاختيار بس عند الإضافة (من الناقصة)، وعند التعديل ثابتة. */
export function RuleDialog({
  open,
  initial,
  choices,
  busy,
  error,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: RuleDraft;
  /** المحافظات المتاحة للإضافة (فاضية = تعديل). */
  choices: readonly string[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (draft: RuleDraft) => void;
}) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);
  const editing = choices.length === 0;
  const valid = draft.province !== "" && draft.fee !== "" && Number(draft.fee) >= 0;
  return (
    <Dialog open={open} onClose={onClose} title={editing ? `${S.edit}: ${draft.province}` : S.add} className="max-w-md">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave(draft);
        }}
      >
        {!editing && (
          <Field label={S.columns.province}>
            <Select value={draft.province} onChange={(e) => setDraft({ ...draft, province: e.target.value })} required>
              <option value="">—</option>
              {choices.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={S.columns.fee}>
            <Input type="number" inputMode="decimal" min="0" step="any" value={draft.fee} onChange={(e) => setDraft({ ...draft, fee: e.target.value })} dir="ltr" required />
          </Field>
          <Field label={S.currency} hint="فاضي = عملة المنتج">
            <Input value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} maxLength={3} placeholder="USD" dir="ltr" />
          </Field>
        </div>
        <Field label={S.columns.freeOver} hint="اتركه فاضي إذا ما في توصيل مجاني">
          <Input type="number" inputMode="decimal" min="0" step="any" value={draft.freeOver} onChange={(e) => setDraft({ ...draft, freeOver: e.target.value })} dir="ltr" />
        </Field>
        <Switch checked={draft.isAvailable} onChange={(v) => setDraft({ ...draft, isAvailable: v })} label={S.columns.available} description="متوقف = الوكيل بيعتذر عن التوصيل لهالمحافظة" />
        {error && (
          <p role="alert" className="text-xs font-semibold text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-start gap-2 pt-1">
          <Button type="submit" loading={busy} disabled={!valid}>
            {S.save}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            {S.undo}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
