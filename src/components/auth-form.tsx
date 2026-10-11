"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bot, MessagesSquare, ShieldCheck, ShoppingBag, Sparkles, TrendingUp } from "lucide-react";
import { t } from "@/lib/i18n";
import { BrandLogo } from "./brand-logo";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const HIGHLIGHTS = [
  { icon: MessagesSquare, title: "رد آلي ذكي", desc: "الوكيل الذكي يرد على عملائك لحظيًا على مدار الساعة" },
  { icon: ShoppingBag, title: "طلبات بلا أخطاء", desc: "استخراج البيانات وتأكيد الطلبات تلقائيًا" },
  { icon: TrendingUp, title: "نمو تقيسه", desc: "تحليلات المبيعات والأداء لحظة بلحظة" },
];

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const form = new FormData(e.currentTarget);
    const payload = Object.fromEntries(form.entries());
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // Non-JSON failure (proxy 502 HTML, network) must surface — not kill the form.
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? data?.error ?? `تعذر ${mode === "login" ? "تسجيل الدخول" : "إنشاء الحساب"} (${res.status}) — حاول مجددًا`);
        return;
      }
      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("تعذر الاتصال بالخادم — تحقق من الشبكة وحاول مجددًا");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-surface-1 lg:grid lg:grid-cols-[1.05fr_1fr]">
      {/* ── Showcase panel (desktop) ─────────────────────────── */}
      <div className="relative hidden overflow-hidden bg-gradient-to-bl from-blue-950 via-brand-600 to-sky-500 lg:flex lg:flex-col lg:justify-between lg:p-10">
        {/* decorative glows + dot pattern */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute -top-24 -start-24 h-96 w-96 rounded-full bg-sky-300/25 blur-3xl" />
          <div className="absolute bottom-0 end-0 h-[28rem] w-[28rem] rounded-full bg-blue-950/40 blur-3xl" />
          <div
            className="absolute inset-0 opacity-[0.15]"
            style={{ backgroundImage: "radial-gradient(rgb(255 255 255 / 0.9) 1px, transparent 1px)", backgroundSize: "22px 22px" }}
          />
        </div>

        <div className="relative flex items-center gap-3">
          <span className="rounded-2xl bg-white/15 p-0.5 ring-1 ring-white/40 backdrop-blur">
            <BrandLogo size="lg" />
          </span>
          <div>
            <p className="text-xl font-bold leading-7 text-white">
              Zaki <span className="text-sky-200">response</span>
            </p>
            <p className="text-xs text-sky-100/90">{t.app.tagline}</p>
          </div>
        </div>

        <div className="relative space-y-6">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/12 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/25 backdrop-blur">
            <Sparkles size={13} />
            مساعد المبيعات الذكي لمتجرك
          </div>
          <h1 className="max-w-md text-3xl font-bold leading-[1.6] text-white xl:text-4xl">
            حوّل محادثات عملائك إلى طلبات مؤكدة — تلقائيًا
          </h1>
          <ul className="space-y-3.5">
            {HIGHLIGHTS.map(({ icon: Icon, title, desc }) => (
              <li key={title} className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/12 text-white ring-1 ring-white/25 backdrop-blur">
                  <Icon size={17} />
                </span>
                <span>
                  <span className="block text-sm font-bold text-white">{title}</span>
                  <span className="block text-xs leading-5 text-sky-100/90">{desc}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex items-center gap-2 text-xs text-sky-100/80">
          <ShieldCheck size={14} />
          حماية الأسعار والطلبات وتسليم ذكي للموظفين — دائمًا
        </div>
      </div>

      {/* ── Form side ────────────────────────────────────────── */}
      <div className="flex min-h-screen items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-md animate-fade-in">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <BrandLogo size="lg" />
            <div>
              <p className="text-lg font-bold text-ink">
                Zaki <span className="bg-gradient-to-l from-brand-600 to-sky-500 bg-clip-text text-transparent">response</span>
              </p>
              <p className="text-xs text-ink-muted">{t.app.tagline}</p>
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-surface-2 p-7 shadow-[0_20px_50px_-20px_rgb(37_99_235/0.35)] sm:p-8">
            <span className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-brand-500/[0.08] px-3 py-1 text-[11px] font-bold text-brand-700 ring-1 ring-inset ring-brand-500/20 dark:text-brand-300">
              <Bot size={12} />
              {mode === "login" ? "مرحبًا بعودتك" : "ابدأ مجانًا"}
            </span>
            <h1 className="text-xl font-bold text-ink">
              {mode === "login" ? "تسجيل الدخول" : "إنشاء حساب جديد"}
            </h1>
            <p className="mb-6 mt-1 text-sm text-ink-muted">
              {mode === "login"
                ? "ادخل إلى لوحة التحكم لإدارة المحادثات والطلبات"
                : "أنشئ مساحة عملك وابدأ خلال دقيقة"}
            </p>
            <form onSubmit={onSubmit} className="space-y-3.5">
              {mode === "register" && (
                <>
                  <Input name="name" required placeholder="الاسم الكامل" className="h-10" minLength={2} aria-label="الاسم الكامل" />
                  <Input name="workspaceName" required placeholder="اسم مساحة العمل / المتجر" className="h-10" minLength={2} aria-label="اسم مساحة العمل" />
                </>
              )}
              <Input name="email" type="email" required placeholder="البريد الإلكتروني" dir="ltr" autoComplete="email" className="h-10" aria-label="البريد الإلكتروني" />
              <Input name="password" type="password" required placeholder="كلمة المرور" dir="ltr" autoComplete={mode === "login" ? "current-password" : "new-password"} className="h-10" minLength={8} aria-label="كلمة المرور" />
              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950 dark:text-red-400" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" loading={loading} size="lg" className="w-full shadow-[0_10px_24px_-8px_rgb(37_99_235/0.7)]">
                {loading ? t.common.loading : mode === "login" ? "دخول" : "إنشاء الحساب"}
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-ink-muted">
              {mode === "login" ? (
                <>
                  ليس لديك حساب؟{" "}
                  <Link href="/register" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                    إنشاء حساب
                  </Link>
                </>
              ) : (
                <>
                  لديك حساب؟{" "}
                  <Link href="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                    تسجيل الدخول
                  </Link>
                </>
              )}
            </p>
          </div>
          <p className="mt-5 text-center text-[11px] text-ink-subtle">
            Zaki response — محادثات أكثر، مبيعات أكثر
          </p>
        </div>
      </div>
    </main>
  );
}
