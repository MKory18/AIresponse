"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MessageSquareText } from "lucide-react";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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
    <main className="flex min-h-screen items-center justify-center bg-surface-1 p-4">
      <div className="w-full max-w-md animate-fade-in rounded-xl2 border border-line bg-surface-2 p-8 shadow-card">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-500 text-white shadow-xs">
            <MessageSquareText size={20} />
          </span>
          <div>
            <p className="text-lg font-bold text-ink">{t.app.name}</p>
            <p className="text-xs text-ink-muted">{t.app.tagline}</p>
          </div>
        </div>
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
          <Button type="submit" loading={loading} className="h-10 w-full">
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
    </main>
  );
}