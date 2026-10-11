"use client";

import { useEffect, useState } from "react";
import { Globe2, Link2, Save, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassCard } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { CopyField, RiskWithFix, SectionHead, apiJson } from "./ui";

export interface IntegrationSettings {
  capacityUnansweredWarn: number;
  capacityP50WarnMin: number;
  capacityCriticalMultiplier: number;
  attributionWindowDays: number;
  trustClipperApprovals: boolean;
  serverCostUsdPerDay: string | null;
  agentDoorPaused: boolean;
}

export function SettingsCard({ settings, onSaved }: { settings: IntegrationSettings; onSaved: () => void }) {
  const toast = useToast();
  const [s, setS] = useState(settings);
  const [cost, setCost] = useState(settings.serverCostUsdPerDay ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setS(settings);
    setCost(settings.serverCostUsdPerDay ?? "");
  }, [settings]);

  async function save() {
    const trimmed = cost.trim();
    if (trimmed && !/^\d{1,6}\.\d{2}$/.test(trimmed)) {
      toast.show("كلفة السيرفر بخانتين عشريتين: مثلًا 12.50", "error");
      return;
    }
    setBusy(true);
    try {
      await apiJson("/api/integrations/settings", {
        method: "PATCH",
        json: {
          capacityUnansweredWarn: s.capacityUnansweredWarn,
          capacityP50WarnMin: s.capacityP50WarnMin,
          capacityCriticalMultiplier: s.capacityCriticalMultiplier,
          attributionWindowDays: s.attributionWindowDays,
          trustClipperApprovals: s.trustClipperApprovals,
          serverCostUsdPerDay: trimmed || null,
        },
      });
      toast.show("انحفظت إعدادات الربط");
      onSaved();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل الحفظ", "error");
    } finally {
      setBusy(false);
    }
  }

  const num = (k: keyof IntegrationSettings, v: string, min: number, max: number) =>
    setS((x) => ({ ...x, [k]: Math.min(max, Math.max(min, Number(v) || min)) }));

  return (
    <GlassCard className="space-y-4 p-4 sm:p-5">
      <SectionHead icon={<SlidersHorizontal size={15} />} title="إعدادات الربط" sub="حدود الإنذار والإسناد — نفس الأرقام بتشوفها الأنظمة التانية." tone="sky" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="إنذار: رسائل بلا رد" hint="عدد المحادثات">
          <Input type="number" min={1} max={10000} value={s.capacityUnansweredWarn} onChange={(e) => num("capacityUnansweredWarn", e.target.value, 1, 10000)} dir="ltr" className="num" />
        </Field>
        <Field label="إنذار: وسيط أول رد" hint="بالدقائق">
          <Input type="number" min={1} max={1440} value={s.capacityP50WarnMin} onChange={(e) => num("capacityP50WarnMin", e.target.value, 1, 1440)} dir="ltr" className="num" />
        </Field>
        <Field label="«حرج» = الحد ×" hint="مضاعف">
          <Input type="number" step="0.1" min={1.2} max={10} value={s.capacityCriticalMultiplier} onChange={(e) => setS((x) => ({ ...x, capacityCriticalMultiplier: Math.min(10, Math.max(1.2, Number(e.target.value) || 2)) }))} dir="ltr" className="num" />
        </Field>
        <Field label="نافذة الإسناد" hint="أيام (1–28)">
          <Input type="number" min={1} max={28} value={s.attributionWindowDays} onChange={(e) => num("attributionWindowDays", e.target.value, 1, 28)} dir="ltr" className="num" />
        </Field>
        <Field label="كلفة السيرفر اليومية $" hint="فاضي = ما بتنبعت للمالية" className="col-span-2 md:col-span-1">
          <Input value={cost} onChange={(e) => setCost(e.target.value)} dir="ltr" className="num" placeholder="12.50" inputMode="decimal" />
        </Field>
      </div>
      <label className="flex cursor-pointer items-start gap-2 text-sm font-medium text-ink">
        <input type="checkbox" checked={s.trustClipperApprovals} onChange={(e) => setS((x) => ({ ...x, trustClipperApprovals: e.target.checked }))} className="mt-0.5 h-4 w-4 accent-red-500" />
        <span>
          اعتماد الكليبر يكفي
          <span className="block text-xs font-normal text-ink-muted">حملة إعادة التواصل المعتمدة بالكليبر بتنطلق هون بلا اعتماد تاني منك.</span>
        </span>
      </label>
      {s.trustClipperApprovals && (
        <RiskWithFix
          risk="مؤتمت: رسائل تسويقية بتطلع لزبائنك بلا ما تشوفها"
          detail="أي حملة يعتمدها حدا بالكليبر بتنجدول هون فورًا (للموافقين بس وبقالب واتساب معتمد)."
          fix="خليه مطفي وراجع كل حملة بصفحة الحملات — الاعتماد هناك نقرة وحدة وبيبيّن عدد المستلمين قبل الإرسال."
        />
      )}
      <Button onClick={save} loading={busy} disabled={busy}>
        <Save size={14} />
        حفظ الإعدادات
      </Button>
    </GlassCard>
  );
}

export interface ChannelRow {
  id: string;
  type: string;
  displayName: string;
  status: string;
  market: string | null;
}

const CHANNEL_AR: Record<string, string> = { WHATSAPP: "واتساب", FACEBOOK: "ماسنجر", INSTAGRAM: "إنستغرام", TELEGRAM: "تيليغرام", WEB: "الموقع", TIKTOK: "تيك توك" };
const MARKET_AR: Record<string, string> = { SY: "سوريا", JO: "الأردن" };

export function MarketsCard({ channels, markets, onSaved }: { channels: ChannelRow[]; markets: string[]; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function setMarket(channelId: string, market: string) {
    setBusy(channelId);
    try {
      await apiJson("/api/integrations/channel-markets", { method: "PATCH", json: { channelId, market: market || null } });
      onSaved();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل الحفظ", "error");
    } finally {
      setBusy(null);
    }
  }
  return (
    <GlassCard className="space-y-3 p-4 sm:p-5">
      <SectionHead icon={<Globe2 size={15} />} title="سوق كل قناة" sub="الوكيل الذكي بيسأل «كيف الردود بسوريا؟» — الجواب من قنوات السوق هاد بس." tone="emerald" />
      {channels.length === 0 ? (
        <p className="text-xs text-ink-subtle">ما في قنوات مربوطة لسا.</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {channels.map((ch) => (
            <li key={ch.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0 text-xs">
                <span className="font-semibold text-ink">{ch.displayName}</span>
                <span className="text-ink-muted"> · {CHANNEL_AR[ch.type] ?? ch.type}</span>
              </span>
              <Select value={ch.market ?? ""} onChange={(e) => setMarket(ch.id, e.target.value)} disabled={busy === ch.id} className="h-9 w-36" aria-label={`سوق ${ch.displayName}`}>
                <option value="">بلا سوق</option>
                {markets.map((m) => (
                  <option key={m} value={m}>
                    {MARKET_AR[m] ?? m}
                  </option>
                ))}
              </Select>
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  );
}

export interface Endpoints {
  capacity: string;
  retargetCampaigns: string;
  s1Webhook: string | null;
  agentTools: string;
  agentCall: string;
  health: string;
}

export function EndpointsCard({ endpoints, appUrl }: { endpoints: Endpoints; appUrl: string | null }) {
  return (
    <GlassCard className="space-y-3 p-4 sm:p-5">
      <SectionHead icon={<Link2 size={15} />} title="روابط الاستقبال عندنا" sub="الأنظمة التانية بتنادي هالروابط بتوكناتها (كل نظام بأقل صلاحية)." tone="violet" />
      {!appUrl && (
        <RiskWithFix
          risk="APP_URL مش مضبوط بالخادم — الروابط تحت ناقصة الدومين"
          fix="حط APP_URL=https://دومين-الردود بملف البيئة وأعد التشغيل؛ روابط المراجعة للوكيل ورابط أحداث الـ OMS بيعتمدوا عليه."
        />
      )}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <CopyField label="قدرة الرد — للميديا باير (GET)" value={endpoints.capacity} />
        <CopyField label="حملات إعادة التواصل — للكليبر (POST + Idempotency-Key)" value={endpoints.retargetCampaigns} />
        <CopyField label="دليل أدوات الوكيل (GET)" value={endpoints.agentTools} />
        <CopyField label="نداء أداة الوكيل (POST)" value={endpoints.agentCall} />
        <CopyField label="أحداث سيستم 1 (POST موقّع)" value={endpoints.s1Webhook} />
        <CopyField label="صحة النظام (GET)" value={endpoints.health} />
      </div>
    </GlassCard>
  );
}
