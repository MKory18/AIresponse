"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { AttentionResult } from "@/modules/attention/service";
import { useAttention } from "./use-attention";

/** شريط العطل — سطر وحيد بأعلى كل الصفحات لما في عطل حرج بيوقف الشغل. بيظهر بس لمن بيقدر يصلحه (الخادم بيفلتر). */
export function HealthBannerView({ banner, extra = 0 }: { banner: AttentionResult["banner"]; extra?: number }) {
  if (!banner) return null;
  return (
    <div role="alert" data-health-banner className="flex items-center gap-3 border-b border-danger/40 bg-danger-soft px-4 py-2 text-sm text-ink">
      <AlertTriangle size={16} className="shrink-0 text-danger" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-medium">
        {banner.title}
        {extra > 0 && <span className="ms-2 text-caption text-ink-muted">و{extra} غيره</span>}
      </span>
      <Link href={banner.href} className="shrink-0 rounded-control bg-danger px-3 py-1 text-xs font-semibold text-on-primary hover:opacity-90 focus-visible:outline-2 focus-visible:outline-focus">
        أصلح
      </Link>
    </div>
  );
}

export function HealthBanner() {
  const { data } = useAttention();
  return <HealthBannerView banner={data.banner} extra={Math.max(0, data.counts.critical - 1)} />;
}
