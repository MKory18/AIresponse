"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassCard } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { useCan } from "@/components/auth/permissions";
import { api } from "@/lib/api-client";
import { TIMEZONE_OPTIONS } from "@/lib/timezones";

interface WorkspaceRow {
  id: string;
  timezone?: string;
}

/**
 * «توقيت المتجر» (3.7، L-19): اليوم بالتقارير و«اليوم» بتبدأ بنص ليل **هالتوقيت** مش UTC.
 * الحفظ `PUT /api/workspaces { timezone }` (صلاحية إدارة المساحة)، ومن غيرها بيظهر للقراءة بس.
 */
export function WorkspaceTimezoneCard() {
  const can = useCan();
  const [current, setCurrent] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ workspaces: WorkspaceRow[]; activeWorkspaceId: string }>("/api/workspaces")
      .then((r) => {
        const tz = r.workspaces.find((w) => w.id === r.activeWorkspaceId)?.timezone ?? "UTC";
        setCurrent(tz);
        setValue(tz);
      })
      .catch(() => setCurrent(null));
  }, []);

  if (current === null) return null;
  const options = TIMEZONE_OPTIONS.some(([v]) => v === current) ? TIMEZONE_OPTIONS : [...TIMEZONE_OPTIONS, [current, current] as [string, string]];

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/workspaces", { method: "PUT", json: { timezone: value } });
      setCurrent(value);
      setMessage({ ok: true, text: "انحفظ. التقارير و«اليوم» صاروا على التوقيت الجديد." });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "تعذّر الحفظ" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassCard className="space-y-3 p-4" data-timezone-card>
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
        <Clock size={15} aria-hidden /> توقيت المتجر
      </h2>
      <p className="text-sm text-ink-muted">بداية «اليوم» وتجميع الأرقام حسب هالتوقيت. لو بقي على التوقيت العالمي، طلب الساعة 1:30 بعد منتصف الليل بدمشق بينحسب على اليوم اللي قبله.</p>
      {current === "UTC" && <Callout risk="التوقيت لسا على التوقيت العالمي (UTC)." fix="اختار توقيت متجرك وبعدها احفظ." />}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="توقيت المتجر"
          value={value}
          disabled={!can("workspace.manage") || busy}
          onChange={(e) => setValue(e.target.value)}
          className="rounded-control border border-border-strong bg-surface-2 px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60"
        >
          {options.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        {can("workspace.manage") ? (
          <Button size="sm" onClick={() => void save()} disabled={busy || value === current} loading={busy}>
            حفظ
          </Button>
        ) : (
          <span className="text-caption text-ink-subtle">التغيير لصاحب المتجر أو مديره.</span>
        )}
      </div>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-success" : "text-sm text-danger"}>
          {message.text}
        </p>
      )}
    </GlassCard>
  );
}
