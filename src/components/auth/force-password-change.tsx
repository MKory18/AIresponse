"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { GlassCard } from "@/components/ui/card";

/**
 * شاشة التغيير الإلزامي لكلمة المرور (4.2): الإدارة أعطتك كلمة مؤقتة (إنشاء حساب أو إعادة تعيين)،
 * فقبل أي صفحة لازم تحط كلمة مرور من عندك. بتنعرض من `(dashboard)/layout.tsx` وبس لما
 * `User.mustChangePassword = true`، وبعد النجاح بيتحمّل الموقع من جديد.
 */
export function ForcePasswordChange({ userName }: { userName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    if (newPassword !== confirm) return setError("كلمتا المرور الجديدتان مش متطابقتين.");
    if (newPassword === currentPassword) return setError("اختار كلمة مرور مختلفة عن المؤقتة.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }) });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) return setError(data.message ?? "تعذّر تغيير كلمة المرور");
      window.location.reload();
    } catch {
      setError("تعذّر الاتصال بالخادم");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4" data-force-password-change>
      <GlassCard className="w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <KeyRound size={18} />
          </span>
          <div>
            <h1 className="text-base font-bold text-ink">غيّر كلمة المرور</h1>
            <p className="text-[11px] text-ink-subtle">أهلًا {userName} — كلمة المرور الحالية مؤقتة من الإدارة.</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <Field label="كلمة المرور المؤقتة">
            <PasswordInput name="currentPassword" required autoComplete="current-password" dir="ltr" />
          </Field>
          <Field label="كلمة المرور الجديدة" hint="8 أحرف على الأقل.">
            <PasswordInput name="newPassword" required minLength={8} maxLength={128} autoComplete="new-password" dir="ltr" />
          </Field>
          <Field label="أعد كتابتها">
            <PasswordInput name="confirm" required minLength={8} maxLength={128} autoComplete="new-password" dir="ltr" />
          </Field>
          {error && (
            <p role="alert" className="text-xs font-semibold text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
          <Button type="submit" loading={busy} className="w-full">
            احفظ وكمّل
          </Button>
        </form>
      </GlassCard>
    </main>
  );
}
