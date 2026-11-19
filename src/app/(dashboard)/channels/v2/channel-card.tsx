"use client";

import { useState } from "react";
import Link from "next/link";
import { PlugZap, Trash2, Unplug, Wifi } from "lucide-react";
import { Can } from "@/components/auth/permissions";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { DateTime } from "@/components/ui/formatted";
import { Menu } from "@/components/ui/menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusChip } from "@/components/ui/status-chip";
import { useToast } from "@/components/ui/toast";
import { MARKETS, SEND_MODES, TYPE_META, connectionChip, needsReconnect, type ChannelRow } from "./model";
import { CHANNELS_STRINGS as S } from "./strings";
import type { Option, Setting } from "./use-channels";

const SELECT = "h-10 w-full rounded-control border border-border-strong bg-surface-2 px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      {children}
    </div>
  );
}

/**
 * بطاقة صفحة/قناة (3.6، 03 §5.6): الاسم · القناة · شارة الاتصال · آخر رسالة — و4 إعدادات بس: **الوضع** · **الشخصية** ·
 * **مجموعة المنتجات** · **السوق** (بتنحفظ فورًا). التوكن المنتهي = زر أساسي «أعد الربط». التفاصيل التقنية مطوية.
 */
export function ChannelCard({
  row,
  personas,
  catalogs,
  onSave,
  onReconnect,
  onDisconnect,
  onArchive,
  onTest,
}: {
  row: ChannelRow;
  personas: Option[];
  catalogs: Option[];
  onSave: (id: string, setting: Setting, value: string) => Promise<string | null>;
  onReconnect: (row: ChannelRow) => void;
  onDisconnect: (row: ChannelRow) => void;
  /** شيل صفحة موقوفة من القائمة — السجل بيضل. */
  onArchive: (row: ChannelRow) => void;
  onTest: (row: ChannelRow) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<Setting | null>(null);
  const [pendingCatalog, setPendingCatalog] = useState<string | null>(null);
  const meta = TYPE_META[row.type] ?? { name: row.type, hint: "" };
  const chip = connectionChip(row);
  const reconnect = needsReconnect(row);
  const name = row.displayName || row.externalId || meta.name;

  async function apply(setting: Setting, value: string) {
    setBusy(setting);
    const err = await onSave(row.id, setting, value);
    setBusy(null);
    toast.show(err ?? S.saved, err ? "error" : "success");
  }

  const items = [
    ...(row.type === "FACEBOOK" ? [{ key: "test", label: S.test, icon: <Wifi size={14} aria-hidden />, onSelect: () => onTest(row) }] : []),
    ...(row.status === "CONNECTED" ? [{ key: "disconnect", label: S.disconnect, icon: <Unplug size={14} aria-hidden />, danger: true, onSelect: () => onDisconnect(row) }] : []),
    // لكل صفحة فيسبوك — حتى المربوطة. ⚠️ الصفحة القديمة اللي ميتا سحبت وصولها بتضل CONNECTED عندنا،
    // فلو الخيار كان للمش-مربوطة بس ما في طريقة تشيلها. 🔧 للمربوطة بيطلع تأكيد صريح بيفصلها أول.
    ...(row.type === "FACEBOOK"
      ? [{ key: "archive", label: S.archive, icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: () => onArchive(row) }]
      : []),
  ];

  return (
    <article data-channel={row.id} className="space-y-4 rounded-card border border-line bg-surface-2 p-5 shadow-raised">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-ink">{name}</h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-caption text-ink-muted">
            <span>{meta.name}</span>
            <span>·</span>
            <span>
              {S.lastMessage}: {row.lastWebhookAt ? <DateTime value={row.lastWebhookAt} mode="relative" /> : S.none}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusChip tone={chip.tone}>{chip.text}</StatusChip>
          <Can permission="channels.connect">
            {reconnect &&
              (row.type === "FACEBOOK" ? (
                <a href="/api/channels/facebook/connect" className="inline-flex h-9 items-center gap-1.5 rounded-control bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-focus">
                  <PlugZap size={14} aria-hidden /> {S.reconnect}
                </a>
              ) : (
                <Button size="sm" onClick={() => onReconnect(row)}>
                  <PlugZap size={14} aria-hidden /> {S.reconnect}
                </Button>
              ))}
            {items.length > 0 && <Menu label={`${S.actions}: ${name}`} items={items} />}
          </Can>
        </div>
      </header>

      {!row.catalog && (
        <Callout risk={`«${name}» بلا مجموعة منتجات: الوكيل ما بيعرف ولا منتج لهالصفحة.`} fix="اختار مجموعة منتجات من «مجموعة المنتجات» تحت." />
      )}

      <fieldset className="grid grid-cols-1 gap-4 border-0 p-0 sm:grid-cols-2" aria-label={S.settings}>
        <Can permission="channels.connect" fallback={<p className="text-sm text-ink-muted sm:col-span-2">{S.readOnly}</p>}>
          <Row label={S.mode}>
            <SegmentedControl<string>
              label={`${S.mode}: ${name}`}
              value={row.sendMode}
              options={SEND_MODES}
              onChange={(v) => v !== row.sendMode && busy === null && void apply("mode", v)}
            />
            {row.sendMode === "COLLECTION_ONLY" && <p className="text-caption text-ink-muted">{S.modeCollectOnly}</p>}
          </Row>
          <Row label={S.persona}>
            <select aria-label={`${S.persona}: ${name}`} className={SELECT} value={row.aiPersonaId ?? ""} disabled={busy === "persona"} onChange={(e) => void apply("persona", e.target.value)}>
              <option value="">{S.personaDefault}</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Row>
          <Row label={S.catalog}>
            <select aria-label={`${S.catalog}: ${name}`} className={SELECT} value={row.catalog?.id ?? ""} disabled={busy === "catalog"} onChange={(e) => e.target.value && setPendingCatalog(e.target.value)}>
              <option value="">{S.catalogNone}</option>
              {catalogs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {row.catalog && (
              <Link href={`/catalogs/${row.catalog.id}`} className="text-caption text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus">
                {S.manageCatalog}
              </Link>
            )}
          </Row>
          <Row label={S.market}>
            <SegmentedControl<string>
              label={`${S.market}: ${name}`}
              value={row.market ?? ""}
              options={MARKETS}
              onChange={(v) => v !== (row.market ?? "") && busy === null && void apply("market", v)}
            />
          </Row>
        </Can>
      </fieldset>

      <Can permission="channels.connect">
        <details className="rounded-control border border-line bg-surface-3">
          <summary className="cursor-pointer px-3 py-2 text-sm text-ink-muted focus-visible:outline-2 focus-visible:outline-focus">{S.technical}</summary>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 border-t border-line px-3 py-2 text-caption text-ink-muted sm:grid-cols-2">
            <div className="flex gap-1">
              <dt>{S.techId}:</dt>
              <dd dir="ltr" className="text-ink">{row.externalId ?? "—"}</dd>
            </div>
            <div className="flex gap-1">
              <dt>{S.techToken}:</dt>
              <dd className="text-ink">{S.tokenLabels[row.tokenStatus] ?? row.tokenStatus}</dd>
            </div>
            <div className="flex gap-1">
              <dt>{S.techLastSend}:</dt>
              <dd className="text-ink">{row.lastSendAt ? <DateTime value={row.lastSendAt} mode="relative" /> : S.none}</dd>
            </div>
            <div className="flex gap-1">
              <dt>{S.techConnected}:</dt>
              <dd className="text-ink">{row.connectedAt ? <DateTime value={row.connectedAt} mode="date" /> : "—"}</dd>
            </div>
          </dl>
        </details>
      </Can>

      <ConfirmDialog
        open={pendingCatalog !== null}
        onClose={() => setPendingCatalog(null)}
        onConfirm={() => {
          const id = pendingCatalog;
          setPendingCatalog(null);
          if (id) void apply("catalog", id);
        }}
        title={S.catalogConfirmTitle}
        body={S.catalogConfirmBody}
        confirmLabel={S.catalogConfirm}
        danger
      />
    </article>
  );
}
