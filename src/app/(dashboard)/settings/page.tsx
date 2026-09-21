import Link from "next/link";

export default function SettingsPage() {
  const sections = [
    { href: "/settings/ai", title: "إعدادات AI", desc: "المزود، النماذج، حرارة التوليد، حدود الثقة، والتشغيل/الإيقاف." },
  ];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">الإعدادات</h1>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {sections.map((s) => (
          <Link key={s.href} href={s.href} className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand-500">
            <p className="text-sm font-bold text-slate-800">{s.title}</p>
            <p className="mt-1 text-xs text-slate-500">{s.desc}</p>
          </Link>
        ))}
      </div>
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
        إعدادات مساحة العمل والفريق والأمان ستُستكمل في المراحل القادمة.
      </div>
    </div>
  );
}
