"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

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
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? "حدث خطأ غير متوقع");
        return;
      }
      router.replace("/dashboard");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-50 to-slate-50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-2xl font-bold">
          {mode === "login" ? "تسجيل الدخول" : "إنشاء حساب جديد"}
        </h1>
        <p className="mb-6 text-sm text-slate-500">
          {mode === "login"
            ? "ادخل إلى لوحة تحكم AI Commerce Response Engine"
            : "أنشئ مساحة عملك وابدأ خلال دقيقة"}
        </p>
        <form onSubmit={onSubmit} className="space-y-4">
          {mode === "register" && (
            <>
              <input name="name" required placeholder="الاسم الكامل" className={inputClass} minLength={2} />
              <input name="workspaceName" required placeholder="اسم مساحة العمل / المتجر" className={inputClass} minLength={2} />
            </>
          )}
          <input name="email" type="email" required placeholder="البريد الإلكتروني" dir="ltr" className={inputClass} />
          <input name="password" type="password" required placeholder="كلمة المرور" dir="ltr" className={inputClass} minLength={8} />
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-brand-500 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {loading ? "جارٍ..." : mode === "login" ? "دخول" : "إنشاء الحساب"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-500">
          {mode === "login" ? (
            <>
              ليس لديك حساب؟{" "}
              <Link href="/register" className="font-medium text-brand-600 hover:underline">
                إنشاء حساب
              </Link>
            </>
          ) : (
            <>
              لديك حساب؟{" "}
              <Link href="/login" className="font-medium text-brand-600 hover:underline">
                تسجيل الدخول
              </Link>
            </>
          )}
        </p>
      </div>
    </main>
  );
}
