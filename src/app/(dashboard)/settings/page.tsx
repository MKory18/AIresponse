import Link from "next/link";
import { ArrowLeft, Bot, Cable, Network, Settings as SettingsIcon, Users } from "lucide-react";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { t } from "@/lib/i18n";

export default function SettingsPage() {
  const sections = [
    { href: "/settings/ai", title: "إعدادات AI", desc: "المزود، النماذج، حرارة التوليد، حدود الثقة، والتشغيل/الإيقاف.", icon: Bot },
    { href: "/settings/team", title: "الفريق والصلاحيات", desc: "الأعضاء، الدعوات، الأدوار، التعليق، وإعدادات مساحة العمل.", icon: Users },
    { href: "/settings/integrations", title: "الربط مع الأنظمة", desc: "الـ OMS · الميديا باير · الكليبر · المالية · سيستم 1 · الأزمات · المهام · مساحة العمل — الروابط والتوكنات وسجل الصادر.", icon: Cable },
    { href: "/settings/agents", title: "باب الوكلاء", desc: "مسودات الوكيل الذكي بانتظار قرارك · توكن الجسر · زر الإيقاف · سجل كل نداء.", icon: Network },
  ];
  return (
    <div className="page-wrap">
      <PageHeader title={t.pages.settingsTitle} description={t.pages.settingsDesc} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {sections.map((s) => (
          <Link key={s.href} href={s.href}>
            <GlassCard className="group flex items-start gap-3 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glass">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary">
                <s.icon size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-sm font-bold text-ink">
                  {s.title}
                  <ArrowLeft size={13} className="text-ink-subtle transition-all group-hover:-translate-x-0.5 group-hover:text-brand-500" />
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-ink-muted">{s.desc}</span>
              </span>
            </GlassCard>
          </Link>
        ))}
      </div>
      <GlassCard level="glass-subtle" className="flex items-start gap-2.5 p-4 text-sm leading-relaxed text-ink-muted">
        <SettingsIcon size={16} className="mt-0.5 shrink-0 text-ink-subtle" />
        إعدادات الأمان المتقدمة ستُستكمل في المراحل القادمة.
      </GlassCard>
    </div>
  );
}
