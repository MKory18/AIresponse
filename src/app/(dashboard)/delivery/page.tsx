"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { Can } from "@/components/auth/permissions";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/formatted";
import { IconButton } from "@/components/ui/icon-button";
import { StatusChip } from "@/components/ui/status-chip";
import { PageHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import type { RuleView } from "@/modules/delivery-rules/service";
import { RuleDialog, draftFromRule, emptyDraft, type RuleDraft } from "./rule-dialog";
import { DELIVERY_STRINGS as S } from "./strings";

interface Payload {
  rules: RuleView[];
  missing: string[];
  partial: boolean;
  provinces: string[];
}

/**
 * «المتجر › التوصيل» (3.4): رسم التوصيل وتوفّره لكل محافظة. `DeliveryRule` كانت بلا واجهة أبدًا.
 * ⚠️ أول منطقة بتنضاف بتخلّي باقي المحافظات «غير متاحة» — الصفحة بتحذّر وبتعرض «اضبط الناقصة برسم واحد».
 */
export default function DeliveryPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ draft: RuleDraft; adding: boolean } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<RuleView | null>(null);
  const [busy, setBusy] = useState(false);
  const [bulkFee, setBulkFee] = useState("");
  const [bulkCurrency, setBulkCurrency] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api<Payload>("/api/delivery-rules"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : S.loadError);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(provinces: string[], draft: Pick<RuleDraft, "fee" | "freeOver" | "currency" | "isAvailable">) {
    setBusy(true);
    setDialogError(null);
    try {
      const next = await api<Payload>("/api/delivery-rules", {
        method: "PUT",
        json: { provinces, fee: Number(draft.fee), isAvailable: draft.isAvailable, freeOver: draft.freeOver === "" ? null : Number(draft.freeOver), currency: draft.currency === "" ? null : draft.currency },
      });
      setData((d) => (d ? { ...d, ...next } : d));
      setDialog(null);
      return true;
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : S.loadError);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: RuleView) {
    setBusy(true);
    try {
      const next = await api<Payload>(`/api/delivery-rules?id=${rule.id}`, { method: "DELETE" });
      setData((d) => (d ? { ...d, ...next } : d));
      setToDelete(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : S.loadError);
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<RuleView>[] = [
    { key: "province", header: S.columns.province, cell: (r) => <span className="font-medium">{r.province}</span> },
    { key: "fee", header: S.columns.fee, align: "end", cell: (r) => <Money amount={r.fee} currency={r.currency} /> },
    { key: "available", header: S.columns.available, cell: (r) => <StatusChip tone={r.isAvailable ? "success" : "danger"}>{r.isAvailable ? S.available : S.unavailable}</StatusChip> },
    { key: "freeOver", header: S.columns.freeOver, align: "end", cell: (r) => (r.freeOver === null ? <span className="text-ink-subtle">{S.free}</span> : <Money amount={r.freeOver} currency={r.currency} />) },
    {
      key: "actions",
      header: "",
      align: "end",
      cell: (r) => (
        <Can permission="products.write">
          <span className="inline-flex gap-1">
            <IconButton aria-label={`${S.edit} ${r.province}`} onClick={() => { setDialogError(null); setDialog({ draft: draftFromRule(r), adding: false }); }}>
              <Pencil size={16} aria-hidden />
            </IconButton>
            <IconButton aria-label={`${S.delete} ${r.province}`} tone="danger" onClick={() => setToDelete(r)}>
              <Trash2 size={16} aria-hidden />
            </IconButton>
          </span>
        </Can>
      ),
    },
  ];

  const missing = data?.missing ?? [];
  const empty = (data?.rules.length ?? 0) === 0;
  return (
    <div data-delivery className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title={S.title}
        description={S.description}
        actions={
          <Can permission="products.write">
            <Button disabled={missing.length === 0} onClick={() => { setDialogError(null); setDialog({ draft: emptyDraft(), adding: true }); }}>
              <Plus size={15} aria-hidden /> {S.add}
            </Button>
          </Can>
        }
      />
      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-card border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-ink">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            {S.retry}
          </Button>
        </div>
      )}
      {data && (data.partial || empty) && (
        <Callout risk={empty ? S.riskEmpty : S.riskPartial} fix={empty ? S.fixEmpty : S.fixPartial} />
      )}
      {data && missing.length > 0 && (
        <Can permission="products.write">
          <form
            className="flex flex-wrap items-end gap-3 rounded-card border border-line bg-surface-2 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (bulkFee !== "") void save(missing, { fee: bulkFee, freeOver: "", currency: bulkCurrency, isAvailable: true });
            }}
          >
            <Field label={`${S.bulkFee} (${missing.length} محافظة)`}>
              <Input type="number" inputMode="decimal" min="0" step="any" value={bulkFee} onChange={(e) => setBulkFee(e.target.value)} dir="ltr" className="w-32" required />
            </Field>
            <Field label={S.currency}>
              <Input value={bulkCurrency} onChange={(e) => setBulkCurrency(e.target.value.toUpperCase())} maxLength={3} placeholder="USD" dir="ltr" className="w-24" />
            </Field>
            <Button type="submit" variant="secondary" loading={busy}>
              {S.bulk}
            </Button>
          </form>
        </Can>
      )}
      <DataTable
        caption={S.title}
        columns={columns}
        rows={data?.rules ?? []}
        rowKey={(r) => r.id}
        loading={!data && !error}
        empty={<EmptyState title={S.empty} description={S.emptyDescription} />}
      />
      <RuleDialog
        open={dialog !== null}
        initial={dialog?.draft ?? emptyDraft()}
        choices={dialog?.adding ? missing : []}
        busy={busy}
        error={dialogError}
        onClose={() => setDialog(null)}
        onSave={(d) => void save([d.province], d)}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && void remove(toDelete)}
        title={S.deleteTitle}
        body={S.deleteBody}
        confirmLabel={S.delete}
        busy={busy}
        danger
      />
    </div>
  );
}
