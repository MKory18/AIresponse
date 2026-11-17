"use client";

import { Field, Input, Textarea } from "@/components/ui/input";
import { ComplianceCard } from "@/components/products/compliance-card";
import type { Draft, ProductDetail } from "./model";
import { FaqSection } from "./faq-section";
import { DETAIL_STRINGS as D } from "./strings";

/**
 * «شو بيقول الوكيل»: وصف قصير + كامل · فوائد · طريقة الاستعمال · تحذيرات · ردود الاعتراضات · أسئلة شائعة.
 * هاد اللي الوكيل بيجاوب منه — وبيضل قابل للتعديل حتى لما الـ OMS مربوط. «الامتثال» بيظهر مطوي بآخر التبويب.
 */
export function AgentTab({ product, draft, set }: { product: ProductDetail; draft: Draft; set: (patch: Partial<Draft>) => void }) {
  return (
    <div className="space-y-4">
      <section className="grid grid-cols-1 gap-3 rounded-card border border-line bg-surface-2 p-5 md:grid-cols-2">
        <Field label={D.short} hint={D.shortHint} className="md:col-span-2">
          <Input value={draft.shortDescription} maxLength={500} onChange={(e) => set({ shortDescription: e.target.value })} />
        </Field>
        <Field label={D.full} className="md:col-span-2">
          <Textarea rows={4} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field label={D.benefits} hint={D.linesHint}>
          <Textarea rows={4} value={draft.benefits} onChange={(e) => set({ benefits: e.target.value })} />
        </Field>
        <Field label={D.usage}>
          <Textarea rows={4} value={draft.usage} onChange={(e) => set({ usage: e.target.value })} />
        </Field>
        <Field label={D.warnings}>
          <Textarea rows={3} value={draft.warnings} onChange={(e) => set({ warnings: e.target.value })} />
        </Field>
        <Field label={D.objections} hint={D.objectionsHint}>
          <Textarea rows={3} value={draft.objections} onChange={(e) => set({ objections: e.target.value })} />
        </Field>
        <Field label={D.ingredients}>
          <Textarea rows={3} value={draft.ingredients} onChange={(e) => set({ ingredients: e.target.value })} />
        </Field>
        <Field label={D.salesNotes}>
          <Textarea rows={3} value={draft.salesNotes} onChange={(e) => set({ salesNotes: e.target.value })} />
        </Field>
      </section>

      <FaqSection productId={product.id} />

      <details className="rounded-card border border-line bg-surface-2">
        <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-focus">{D.complianceTitle}</summary>
        <div className="border-t border-line p-4">
          <ComplianceCard productId={product.id} />
        </div>
      </details>
    </div>
  );
}
