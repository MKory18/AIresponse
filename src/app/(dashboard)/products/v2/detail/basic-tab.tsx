"use client";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Money } from "@/components/ui/formatted";
import { Switch } from "@/components/ui/switch";
import { isLocked } from "../model";
import { PRODUCTS_STRINGS as S } from "../strings";
import type { Draft, ProductDetail } from "./model";
import { DETAIL_STRINGS as D } from "./strings";

/**
 * «الأساسي»: اسم · رمز · سعر · مخزون · أسماء بديلة · أسعار إضافية. لما الـ OMS مربوط: حقوله (اسم · رمز · سعر · مخزون) للقراءة بس
 * وبتيجي منه — اللي بتعدّله هون «شو بيقول الوكيل» والصور. حقل مقفول = `disabled` مع سطر سبب واحد فوق.
 */
export function BasicTab({ product, draft, set }: { product: ProductDetail; draft: Draft; set: (patch: Partial<Draft>) => void }) {
  const oms = product.oms.connected;
  const lock = (f: string) => isLocked(f, oms);
  const tiers = draft.tiers;
  return (
    <div className="space-y-4">
      {oms && (
        <div data-oms-locked className="rounded-card border border-info/40 bg-info-soft px-4 py-3 text-sm text-ink">
          <p>{D.omsLockedRisk}</p>
          <p className="mt-1 text-ink-muted">{D.omsLockedFix}</p>
        </div>
      )}
      <section className="grid grid-cols-1 gap-3 rounded-card border border-line bg-surface-2 p-5 md:grid-cols-2">
        <Field label={D.name}>
          <Input value={draft.name} disabled={lock("name")} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={D.sku}>
          <Input value={draft.sku} disabled={lock("sku")} dir="ltr" className="tabular-nums" onChange={(e) => set({ sku: e.target.value })} />
        </Field>
        <Field label={D.price} hint={D.priceHint}>
          <Input type="number" step="0.01" min="0" value={draft.price} disabled={lock("price")} dir="ltr" className="tabular-nums" onChange={(e) => set({ price: e.target.value })} />
        </Field>
        <Field label={D.compareAt}>
          <Input type="number" step="0.01" min="0" value={draft.compareAtPrice} disabled={lock("compareAtPrice")} dir="ltr" className="tabular-nums" onChange={(e) => set({ compareAtPrice: e.target.value })} />
        </Field>
        <Field label={D.currency}>
          <Input value={draft.currency} maxLength={3} disabled={lock("currency")} dir="ltr" className="tabular-nums" onChange={(e) => set({ currency: e.target.value })} />
        </Field>
        <Field label={D.category}>
          <Input value={draft.category} onChange={(e) => set({ category: e.target.value })} />
        </Field>
        <Field label={D.stock}>
          <Select value={draft.stockStatus} disabled={lock("stockStatus")} onChange={(e) => set({ stockStatus: e.target.value })}>
            {Object.entries(S.stock).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={D.stockQty}>
          <Input type="number" min="0" value={draft.stockQty} disabled={lock("stockQty")} dir="ltr" className="tabular-nums" onChange={(e) => set({ stockQty: e.target.value })} />
        </Field>
        <Field label={D.aliases} hint={D.aliasesHint} className="md:col-span-2">
          <Textarea rows={2} value={draft.aliases} onChange={(e) => set({ aliases: e.target.value })} />
        </Field>
        <Field label={D.tags} hint={D.linesHint} className="md:col-span-2">
          <Textarea rows={2} value={draft.tags} onChange={(e) => set({ tags: e.target.value })} />
        </Field>
        <Switch className="md:col-span-2" label={D.active} description={D.activeHint} checked={draft.isActive} disabled={product.isArchived} onChange={(next) => set({ isActive: next })} />
      </section>

      <section className="space-y-3 rounded-card border border-line bg-surface-2 p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">{D.tiersTitle}</h3>
          <Button size="sm" variant="secondary" type="button" disabled={lock("priceTiers") || tiers.length >= 10} onClick={() => set({ tiers: [...tiers, { label: "", price: "" }] })}>
            {D.addTier}
          </Button>
        </div>
        {tiers.length === 0 ? (
          <p className="text-sm text-ink-muted">{D.noTiers}</p>
        ) : (
          <ul className="space-y-2">
            {tiers.map((t, i) => (
              <li key={i} className="flex items-center gap-2">
                <Input value={t.label} disabled={lock("priceTiers")} placeholder={D.tierLabel} aria-label={`${D.tierLabel} ${i + 1}`} className="flex-1" onChange={(e) => set({ tiers: tiers.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <Input type="number" step="0.01" min="0" value={t.price} disabled={lock("priceTiers")} aria-label={`${D.tierPrice} ${i + 1}`} dir="ltr" className="w-28 shrink-0 tabular-nums" onChange={(e) => set({ tiers: tiers.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} />
                <Button size="sm" variant="ghost" type="button" disabled={lock("priceTiers")} aria-label={`${D.removeTier} ${i + 1}`} onClick={() => set({ tiers: tiers.filter((_, j) => j !== i) })}>
                  {D.removeTier}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {product.variants.length > 0 && (
          <div>
            <h4 className="mb-1 text-xs font-medium text-ink-muted">{D.variants}</h4>
            <ul className="space-y-1">
              {product.variants.map((v) => (
                <li key={v.id} className="flex justify-between rounded-control bg-surface-3 px-3 py-1.5 text-sm text-ink-muted">
                  <span dir="ltr">
                    {v.name} ({v.sku})
                  </span>
                  <span>
                    <Money amount={v.price} currency={product.currency} /> · {v.stockQty}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
