"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { THEMES, applySchemeToDocument, applyThemeToDocument } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CountBadge } from "@/components/ui/count-badge";
import { Countdown } from "@/components/ui/countdown";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { EvidenceLink } from "@/components/ui/evidence-link";
import { DateTime, Money, Num } from "@/components/ui/formatted";
import { IconButton } from "@/components/ui/icon-button";
import { Menu } from "@/components/ui/menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusChip, TONES } from "@/components/ui/status-chip";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { TERMS } from "@/lib/glossary";

interface Row {
  id: string;
  name: string;
  total: number;
}
const ROWS: Row[] = [
  { id: "1", name: "طلب تجريبي ١", total: 12.5 },
  { id: "2", name: "طلب تجريبي ٢", total: 48 },
];
const COLUMNS: Column<Row>[] = [
  { key: "name", header: "الاسم", cell: (r) => r.name },
  { key: "total", header: "المجموع", align: "end", cell: (r) => <Money amount={r.total} currency="JOD" /> },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-card border border-line bg-surface-2 p-5">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

/** معرض العدّة: يعرض كل مكوّن بحالاته. الثيم والمظهر من الشريط العلوي. */
export function Gallery() {
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState<"all" | "open" | "ended">("all");
  const [view, setView] = useState<"loaded" | "loading" | "empty">("loaded");
  const until = new Date(Date.now() + 8 * 60_000 + 12_000);

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-4 text-ink" data-dev-gallery>
      <header className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface-2 p-4">
        <h1 className="me-auto text-xl font-semibold">معرض المكوّنات — زكي</h1>
        <label className="text-sm text-ink-muted" htmlFor="dev-theme">
          الثيم
        </label>
        <select
          id="dev-theme"
          className="h-10 rounded-control border border-border-strong bg-surface-2 px-2 text-sm text-ink"
          defaultValue="default"
          onChange={(e) => applyThemeToDocument(e.target.value)}
        >
          {THEMES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <Button size="sm" variant="secondary" onClick={() => applySchemeToDocument(false)}>
          فاتح
        </Button>
        <Button size="sm" variant="secondary" onClick={() => applySchemeToDocument(true)}>
          داكن
        </Button>
      </header>

      <Section title="الأزرار — 4 أنواع">
        <div className="flex flex-wrap items-center gap-2">
          <Button>{TERMS.save}</Button>
          <Button variant="secondary">{TERMS.takeOver}</Button>
          <Button variant="ghost">{TERMS.undo}</Button>
          <Button variant="danger">{TERMS.delete}</Button>
          <Button loading>جاري الحفظ</Button>
          <Button disabled>معطّل</Button>
          <IconButton aria-label="تعديل">
            <Pencil size={16} aria-hidden />
          </IconButton>
          <IconButton aria-label="حذف" tone="danger">
            <Trash2 size={16} aria-hidden />
          </IconButton>
        </div>
      </Section>

      <Section title="Switch · SegmentedControl">
        <Switch checked={on} onChange={setOn} label="الوكيل" description="يرد على العملاء تلقائيًا" />
        <Switch checked={false} onChange={() => {}} label="معطّل" disabled />
        <SegmentedControl
          label="حالة المحادثة"
          value={seg}
          onChange={setSeg}
          options={[
            { value: "all", label: "الكل" },
            { value: "open", label: TERMS.conversationOpen },
            { value: "ended", label: TERMS.conversationEnded },
          ]}
        />
      </Section>

      <Section title="StatusChip · CountBadge">
        <div className="flex flex-wrap items-center gap-2">
          {TONES.map((t) => (
            <StatusChip key={t} tone={t}>
              {t}
            </StatusChip>
          ))}
          <CountBadge count={3} />
          <CountBadge count={7} tone="danger" />
          <CountBadge count={240} />
          <CountBadge count={0} showZero />
        </div>
      </Section>

      <Section title="Callout — تنبيه ثم الحل">
        <Callout risk="الوكيل ما بيعرف سعر هالمنتج." fix="أضف السعر من «المتجر» وبيشتغل مباشرة." />
        <Callout risk="تنبيه قابل للطي" collapsible />
      </Section>

      <Section title="Menu · Tooltip · Countdown · EvidenceLink">
        <div className="flex flex-wrap items-center gap-4">
          <Menu
            items={[
              { key: "edit", label: "تعديل", onSelect: () => {} },
              { key: "del", label: "حذف", danger: true, onSelect: () => {} },
            ]}
          />
          <Tooltip content="تلميحة بالمرور والتركيز">
            <Button size="sm" variant="secondary">
              مرّر هون
            </Button>
          </Tooltip>
          <Countdown until={until} />
          <EvidenceLink messageId="demo" />
          <span data-message-id="demo" className="rounded-control px-2 py-1 text-sm text-ink-muted data-[evidence-mark=true]:bg-warning-soft">
            رسالة تجريبية للتعليم
          </span>
        </div>
      </Section>

      <Section title="Money · DateTime · Num">
        <p className="space-x-4 space-x-reverse text-sm">
          <Money amount={12.5} currency="JOD" /> <Money amount={150000} currency="SYP" /> <Num value={1234567} />{" "}
          <DateTime value="2026-11-17T14:30:00Z" timeZone="Asia/Amman" /> <DateTime value={new Date(Date.now() - 5 * 60_000)} mode="relative" />
        </p>
      </Section>

      <Section title="DataTable — تحميل · فراغ · محمّل">
        <SegmentedControl
          label="حالة الجدول"
          value={view}
          onChange={setView}
          options={[
            { value: "loaded", label: "محمّل" },
            { value: "loading", label: "تحميل" },
            { value: "empty", label: "فراغ" },
          ]}
        />
        <DataTable
          caption="طلبات تجريبية"
          columns={COLUMNS}
          rows={view === "empty" ? [] : ROWS}
          rowKey={(r) => r.id}
          loading={view === "loading"}
          total={view === "empty" ? 0 : 40}
          onLoadMore={() => {}}
          onRowClick={() => {}}
          empty={<EmptyState title="ما في طلبات" description="لما يوصل أول طلب بيظهر هون." />}
        />
      </Section>
    </main>
  );
}
