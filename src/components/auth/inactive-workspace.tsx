"use client";

import { useState } from "react";
import { LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassCard } from "@/components/ui/card";

/**
 * «حسابك مش مفعّل بهالمساحة» (2.2): بدل ما العضو اللي ما إله عضوية فعّالة يشوف القائمة كاملة،
 * بيشوف هالشاشة: يبدّل لمساحة فعّالة عنده، أو يطلع. بلا قشرة ولا قائمة.
 */
export function InactiveWorkspace({
  userName,
  workspaces,
}: {
  userName: string;
  workspaces: { id: string; name: string }[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function switchTo(workspaceId: string) {
    setBusy(workspaceId);
    setError(null);
    try {
      const res = await fetch("/api/auth/switch-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) return setError("تعذّر التبديل لهالمساحة");
      window.location.href = "/dashboard";
    } catch {
      setError("تعذّر الاتصال بالخادم");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4" data-inactive-workspace>
      <GlassCard className="w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
            <ShieldAlert size={18} />
          </span>
          <div>
            <h1 className="text-base font-bold text-ink">حسابك مش مفعّل بهالمساحة</h1>
            <p className="text-[11px] text-ink-subtle">أهلًا {userName} — راجع صاحب المساحة ليفعّل حسابك.</p>
          </div>
        </div>
        {workspaces.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-ink">مساحاتك الفعّالة:</p>
            <ul className="space-y-1.5">
              {workspaces.map((w) => (
                <li key={w.id}>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full justify-start"
                    loading={busy === w.id}
                    disabled={busy !== null}
                    onClick={() => void switchTo(w.id)}
                  >
                    {w.name}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs font-semibold text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        <form action="/api/auth/logout" method="post">
          <Button type="submit" variant="ghost" size="sm" className="w-full">
            <LogOut size={14} /> تسجيل الخروج
          </Button>
        </form>
      </GlassCard>
    </main>
  );
}
