"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bot, Cable, KeyRound, Pause, Play, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, ErrorState } from "@/components/ui/confirm";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { CopyField, FixNote, HealthPill, InfoNote, RiskNote, SectionHead, apiJson } from "@/components/integrations/ui";
import { TokenManager, type TokenPreset, type TokenView } from "@/components/integrations/token-manager";
import type { SystemInfo } from "@/components/integrations/system-card";
import type { Endpoints, IntegrationSettings } from "@/components/integrations/settings-cards";
import { DraftsQueue } from "@/components/agents/drafts-queue";
import { CallLog } from "@/components/agents/call-log";
import { ExternalAgentRisk } from "@/components/agents/external-agent-risk";

interface Overview {
  appUrl: string | null;
  systems: SystemInfo[];
  settings: IntegrationSettings;
  tokens: TokenView[];
  tokenPresets: TokenPreset[];
  endpoints: Endpoints;
}

const BRIDGE_YAML = (appUrl: string | null) => `# zaki-bridge/config/systems.yaml
  replies:
    url_env: REPLIES_URL            # ${appUrl ?? "https://<رابط-الردود>"}
    token_env: REPLIES_AGENT_TOKEN  # توكن الجسر من هالصفحة
    events_secret_env: REPLIES_EVENTS_SECRET  # سر «جسر الوكيل الذكي» من صفحة الربط
    enabled: true`;

/**
 * P12 — «باب الوكلاء»: الوكيل الذكي بيقرأ أرقام الردود ويجهّز مسودات عبر
 * agent-door/v1 (بلا بيانات شخصية)، والمالك بيقرّر هون: المسودات · التوكن ·
 * زر الإيقاف · سجل كل نداء.
 */
export default function AgentsPage() {
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState(false);
  const [provider, setProvider] = useState<{ provider: string; fallbackProvider: string | null } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [confirmPause, setConfirmPause] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      setData(await apiJson<Overview>("/api/integrations"));
      setTick((x) => x + 1);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    // رابط المراجعة من الوكيل: /settings/agents?draft=<id> — بلا useSearchParams (بدون Suspense بالبناء).
    const id = new URLSearchParams(window.location.search).get("draft");
    if (id && /^[A-Za-z0-9_-]{1,64}$/.test(id)) setHighlight(id);
    apiJson<{ provider: string; fallbackProvider: string | null }>("/api/ai/settings")
      .then(setProvider)
      .catch(() => setProvider(null));
  }, [load]);

  async function setPaused(paused: boolean) {
    setBusy(true);
    try {
      await apiJson("/api/integrations/settings", { method: "PATCH", json: { agentDoorPaused: paused } });
      toast.show(paused ? "باب الوكلاء موقوف — كل نداء بيترفض" : "باب الوكلاء شغّال");
      await load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل", "error");
    } finally {
      setBusy(false);
      setConfirmPause(false);
    }
  }

  const header = (
    <PageHeader
      title="باب الوكلاء"
      description="الوكيل الذكي بيقرأ أرقام الردود ويجهّز مسودات قوالب وحملات — بلا أي اسم أو رقم زبون، وكل مسودة بتستنى قرارك هون."
    />
  );
  if (error) {
    return (
      <div className="page-wrap">
        {header}
        <GlassCard className="p-2">
          <ErrorState onRetry={load} description="الصفحة لمالك المساحة أو صاحب صلاحية الإعدادات." />
        </GlassCard>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page-wrap">
        {header}
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  const paused = data.settings.agentDoorPaused;
  const bridge = data.systems.find((s) => s.key === "bridge");
  const activeAgentTokens = data.tokens.filter((t) => t.system === "hermes-bridge" && t.status === "active").length;

  return (
    <div className="page-wrap">
      {header}

      {provider && (provider.provider === "hermes" || provider.fallbackProvider === "hermes") && (
        <ExternalAgentRisk asFallback={provider.provider !== "hermes"} />
      )}

      <GlassCard className="space-y-4 p-4 sm:p-5">
        <SectionHead
          icon={<Bot size={15} />}
          title="حالة الباب"
          sub="العقد agent-door/v1 · 11 أداة (8 للردود + 3 قياسية) · قراءة ومسودة بس — ولا أداة تنفيذ ولا مال ولا إرسال."
          action={
            <HealthPill health={paused ? "error" : activeAgentTokens > 0 ? "ok" : "warn"}>
              {paused ? "موقوف" : activeAgentTokens > 0 ? "شغّال" : "بلا توكن"}
            </HealthPill>
          }
        />
        <div className="flex flex-wrap gap-2">
          {paused ? (
            <Button onClick={() => setPaused(false)} loading={busy} disabled={busy} variant="success">
              <Play size={14} />
              شغّل الباب
            </Button>
          ) : (
            <Button onClick={() => setConfirmPause(true)} disabled={busy} variant="danger">
              <Pause size={14} />
              زر الإيقاف
            </Button>
          )}
          <Link href="/settings/integrations" className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold text-ink-muted transition hover:bg-surface-3 hover:text-ink">
            <Cable size={14} />
            الربط مع الأنظمة
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <CopyField label="دليل الأدوات (GET)" value={data.endpoints.agentTools} />
          <CopyField label="نداء أداة (POST)" value={data.endpoints.agentCall} />
        </div>
        <RiskNote title="مؤتمت: الوكيل الذكي بيسأل الأرقام لحاله ويعمل مسودات (لحد 20 باليوم)">
          ولا مسودة بتأثر على زبون قبل اعتمادك، والحملة المعتمدة بتستنى اعتماد إرسال تاني بصفحة الحملات.
        </RiskNote>
        <FixNote>بدك توقف كل شي فورًا؟ «زر الإيقاف» فوق (بلا ما ينحذف التوكن) — أو «إيقاف» التوكن تحت إذا انكشف.</FixNote>
      </GlassCard>

      <DraftsQueue highlightId={highlight} refreshKey={tick} />

      <GlassCard className="space-y-3 p-4 sm:p-5">
        <SectionHead icon={<KeyRound size={15} />} title="توكن الجسر (zaki-bridge)" sub="قراءة + مسودة · 60 طلب بالدقيقة · 20 مسودة باليوم · 90 يوم ثم تجديد." tone="amber" />
        <TokenManager tokens={data.tokens} presets={data.tokenPresets} systems={["hermes-bridge"]} appUrl={data.appUrl} onChange={load} />
      </GlassCard>

      <GlassCard className="space-y-3 p-4 sm:p-5">
        <SectionHead icon={<Server size={15} />} title="إعداد الجسر zaki-bridge" sub="الردود نظام من عشرة بالجسر — هيك بيتعرّف عليه." tone="sky" />
        <CopyField label="systems.yaml" value={BRIDGE_YAML(data.appUrl)} />
        {bridge && !bridge.connection.configured && (
          <InfoNote>
            لإنذار القدرة للوكيل: من «الربط مع الأنظمة» ← «جسر الوكيل الذكي» حط رابط أحداث الجسر وولّد سر التوقيع، وانسخه للجسر كـ REPLIES_EVENTS_SECRET.
          </InfoNote>
        )}
      </GlassCard>

      <CallLog refreshKey={tick} />

      <ConfirmDialog
        open={confirmPause}
        onClose={() => setConfirmPause(false)}
        onConfirm={() => setPaused(true)}
        title="إيقاف باب الوكلاء؟"
        body="كل نداء من الوكيل بيرجع 401 لحد ما تشغّله — الوكيل بيكتب «الردود مش متاحة» بموجزه. المسودات الموجودة بتضل بانتظارك."
        confirmLabel="أوقف الباب"
        busy={busy}
        danger
      />
    </div>
  );
}
