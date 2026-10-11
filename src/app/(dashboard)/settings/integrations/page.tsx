"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bot, Cable, KeyRound } from "lucide-react";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/confirm";
import { Skeleton } from "@/components/ui/skeleton";
import { OmsCard, omsHealth, type OmsView } from "@/components/integrations/oms-card";
import { SystemCard, connHealth, type SystemInfo } from "@/components/integrations/system-card";
import { DeliveriesLog } from "@/components/integrations/deliveries-log";
import { EndpointsCard, MarketsCard, SettingsCard, type ChannelRow, type Endpoints, type IntegrationSettings } from "@/components/integrations/settings-cards";
import { TokenManager, type TokenPreset, type TokenView } from "@/components/integrations/token-manager";
import { HealthPill, SectionHead, apiJson } from "@/components/integrations/ui";

interface Overview {
  appUrl: string | null;
  systems: SystemInfo[];
  oms: { spec: { nameAr: string; summaryAr: string }; view: OmsView };
  settings: IntegrationSettings;
  tokens: TokenView[];
  tokenPresets: TokenPreset[];
  channels: ChannelRow[];
  markets: string[];
  endpoints: Endpoints;
}

/**
 * P12 — «الربط مع الأنظمة»: كل منظومة Zaki بصفحة وحدة — الـ OMS · الميديا
 * باير · الكليبر · المالية · سيستم 1 · الأزمات · المهام · مساحة العمل · جسر
 * Hermes. كل خطر أو أتمتة بالأحمر وتصحيحه بالبرتقالي تحته.
 */
export default function IntegrationsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState(false);
  const [logSystem, setLogSystem] = useState("");
  const [logTick, setLogTick] = useState(0);

  const load = useCallback(async () => {
    setError(false);
    try {
      setData(await apiJson<Overview>("/api/integrations"));
      setLogTick((x) => x + 1);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const header = <PageHeader title="الربط مع الأنظمة" description="نظام الردود جزء من منظومة Zaki: الطلبات للـ OMS، والأرقام للميديا باير والكليبر وHermes — بلا أي بيانات زبون خارج الحاجة." />;

  if (error) {
    return (
      <div className="page-wrap">
        {header}
        <GlassCard className="p-2">
          <ErrorState onRetry={load} description="تأكد إنك مالك المساحة أو عندك صلاحية الإعدادات." />
        </GlassCard>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page-wrap">
        {header}
        <div className="space-y-3">
          <Skeleton className="h-56 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      </div>
    );
  }

  const omsH = omsHealth(data.oms.view);
  const healthy = data.systems.filter((s) => connHealth(s.connection).health === "ok").length + (omsH.health === "ok" ? 1 : 0);
  const failing = data.systems.filter((s) => connHealth(s.connection).health === "error" || s.stats.failed > 0).length + (omsH.health === "error" ? 1 : 0);
  const configured = data.systems.filter((s) => s.connection.configured).length + (data.oms.view.configured ? 1 : 0);

  return (
    <div className="page-wrap">
      {header}

      <GlassCard level="glass-subtle" className="flex flex-wrap items-center gap-2 p-3">
        <HealthPill health="ok">{healthy} شغّال</HealthPill>
        <HealthPill health={failing > 0 ? "error" : "off"}>{failing} فيه مشكلة</HealthPill>
        <HealthPill health="off">{configured} من {data.systems.length + 1} مربوط</HealthPill>
        <Link href="/settings/agents" className="ms-auto inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline dark:text-brand-300">
          <Bot size={13} />
          باب الوكلاء (Hermes)
        </Link>
      </GlassCard>

      <OmsCard view={data.oms.view} appUrl={data.appUrl} onSaved={load} />

      <section className="space-y-3">
        <SectionHead icon={<Cable size={15} />} title="أنظمة المنظومة" sub="الرابط والتوكن والسر لكل نظام — الأسرار مشفّرة وما بترجع للشاشة أبدًا." />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {data.systems.map((s) => (
            <SystemCard
              key={s.key}
              info={s}
              s1WebhookUrl={data.endpoints.s1Webhook}
              onSaved={load}
              onShowLog={(sys) => {
                setLogSystem(sys);
                document.getElementById("deliveries")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            />
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SettingsCard settings={data.settings} onSaved={load} />
        <MarketsCard channels={data.channels} markets={data.markets} onSaved={load} />
      </div>

      <GlassCard className="space-y-3 p-4 sm:p-5">
        <SectionHead icon={<KeyRound size={15} />} title="توكنات الأنظمة الداخلة" sub="الميديا باير بيقرأ القدرة بس · الكليبر بيطلب حملات ويقرأ حالتها بس. توكن Hermes من صفحة باب الوكلاء." tone="amber" />
        <TokenManager tokens={data.tokens} presets={data.tokenPresets} systems={["mediabuyer", "clipper"]} appUrl={data.appUrl} onChange={load} />
      </GlassCard>

      <EndpointsCard endpoints={data.endpoints} appUrl={data.appUrl} />

      <DeliveriesLog systems={data.systems.map((s) => ({ key: s.key, nameAr: s.nameAr }))} focusSystem={logSystem} refreshKey={logTick} />
    </div>
  );
}
