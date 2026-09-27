import Link from "next/link";
import { ArrowLeft, Bot, Package } from "lucide-react";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { enforcePermission } from "@/components/empty-section";
import { t } from "@/lib/i18n";

export default async function Page() {
  await enforcePermission("analytics.read");
  const cards = [
    { href: "/analytics/ai", title: "استخدام AI", desc: "الاستدعاءات والنماذج والتكلفة وزمن الاستجابة.", icon: Bot },
    { href: "/analytics/products", title: "تحليلات المنتجات", desc: "الكميات والإيرادات حسب المنتج من snapshots الطلبات.", icon: Package },
    { href: "/dashboard", title: t.nav.dashboard, desc: "نظرة شاملة على المحادثات والطلبات والأتمتة.", icon: ArrowLeft },
  ];
  return (
    <div className="page-wrap">
      <PageHeader title={t.pages.analyticsTitle} description={t.pages.analyticsDesc} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {cards.map((c) => (
          <Link key={c.href} href={c.href}>
            <GlassCard className="group flex h-full items-start gap-3 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glass">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500/20 to-violet-500/20 text-brand-600 dark:text-brand-300">
                <c.icon size={18} />
              </span>
              <span className="min-w-0">
                <span className="text-sm font-bold text-ink">{c.title}</span>
                <span className="mt-1 block text-xs leading-relaxed text-ink-muted">{c.desc}</span>
              </span>
            </GlassCard>
          </Link>
        ))}
      </div>
    </div>
  );
}
