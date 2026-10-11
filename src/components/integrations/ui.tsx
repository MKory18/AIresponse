"use client";

import { useState } from "react";
import { AlertTriangle, Check, Copy, Wrench } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * P12 — قطع واجهة الربط المشتركة.
 * قاعدة المالك: أي خطر أو شي مؤتمت بيظهر بالأحمر مع ملاحظة، والتصحيح تحته
 * بالبرتقالي — ما منلغي الخيار، منعلّمه.
 */

export function RiskNote({ title, children, className }: { title: string; children?: React.ReactNode; className?: string }) {
  return (
    <div
      role="note"
      className={cn(
        "rounded-xl border border-red-500/30 bg-red-500/[0.07] px-3.5 py-2.5 text-xs leading-relaxed text-red-800 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-200",
        className
      )}
    >
      <p className="flex items-start gap-1.5 font-bold">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>{title}</span>
      </p>
      {children && <div className="mt-1 ps-5">{children}</div>}
    </div>
  );
}

export function FixNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      role="note"
      className={cn(
        "rounded-xl border border-orange-500/30 bg-orange-500/[0.08] px-3.5 py-2.5 text-xs leading-relaxed text-orange-800 dark:border-orange-400/30 dark:bg-orange-500/10 dark:text-orange-200",
        className
      )}
    >
      <p className="flex items-start gap-1.5">
        <Wrench size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          <span className="font-bold">التصحيح: </span>
          {children}
        </span>
      </p>
    </div>
  );
}

/** خطر بالأحمر وتصحيحه بالبرتقالي تحته مباشرة. */
export function RiskWithFix({ risk, detail, fix, className }: { risk: string; detail?: React.ReactNode; fix: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <RiskNote title={risk}>{detail}</RiskNote>
      <FixNote>{fix}</FixNote>
    </div>
  );
}

export function InfoNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("rounded-xl bg-sky-500/10 px-3 py-2 text-xs leading-relaxed text-sky-800 ring-1 ring-inset ring-sky-500/25 dark:text-sky-200", className)}>
      {children}
    </p>
  );
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // متصفحات بلا صلاحية الحافظة (http محلي): تحديد يدوي كبديل.
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** قيمة جاهزة للنسخ (رابط · توكن · سطر إعداد) — بعرض الشاشة وبلا تمرير أفقي. */
export function CopyField({ label, value, hint, mono = true }: { label: string; value: string | null | undefined; hint?: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <span className="block text-[11px] font-semibold text-ink-muted">{label}</span>
      <div className="flex items-stretch gap-1.5">
        <code
          dir="ltr"
          className={cn(
            "min-w-0 flex-1 break-all rounded-xl border border-line bg-surface-3/60 px-3 py-2 text-start text-[11.5px] leading-relaxed text-ink",
            mono ? "font-mono" : ""
          )}
        >
          {value || "—"}
        </code>
        <button
          type="button"
          disabled={!value}
          onClick={async () => {
            if (!value) return;
            if (await copyText(value)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
          className="glass-subtle flex w-10 shrink-0 items-center justify-center rounded-xl text-ink-muted transition hover:text-brand-600 disabled:opacity-40"
          aria-label={`نسخ ${label}`}
        >
          {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
        </button>
      </div>
      {hint && <span className="block text-[11px] leading-relaxed text-ink-subtle">{hint}</span>}
    </div>
  );
}

export type Health = "ok" | "warn" | "error" | "off";

const HEALTH_STYLE: Record<Health, string> = {
  ok: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  warn: "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300",
  error: "bg-red-500/10 text-red-700 ring-red-500/25 dark:text-red-300",
  off: "bg-slate-500/10 text-slate-500 ring-slate-500/20 dark:text-slate-400",
};

export function HealthPill({ health, children }: { health: Health; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-5 ring-1 ring-inset", HEALTH_STYLE[health])}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

export function SectionHead({ icon, title, sub, tone = "brand", action }: { icon: React.ReactNode; title: string; sub?: string; tone?: "brand" | "sky" | "emerald" | "amber" | "violet" | "slate"; action?: React.ReactNode }) {
  const tones: Record<string, string> = {
    brand: "bg-brand-500/10 text-brand-600 dark:text-brand-300",
    sky: "bg-sky-500/10 text-sky-600 dark:text-sky-300",
    emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-300",
    violet: "bg-violet-500/10 text-violet-600 dark:text-violet-300",
    slate: "bg-surface-3 text-ink-muted",
  };
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", tones[tone])}>{icon}</span>
        <div className="min-w-0">
          <h2 className="text-sm font-bold leading-7 text-ink">{title}</h2>
          {sub && <p className="text-xs leading-relaxed text-ink-muted">{sub}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ar", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** نداء JSON موحّد للصفحات: يرجّع البيانات أو يرمي رسالة عربية مفهومة. */
export async function apiJson<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { message?: string; error?: string }).message ?? (data as { error?: string }).error ?? `خطأ ${res.status}`;
    throw new Error(res.status === 403 ? "ما عندك صلاحية لهالإجراء" : msg);
  }
  return data as T;
}
