"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { GlassCard } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { DateTime } from "@/components/ui/formatted";
import { Field, Input, Select } from "@/components/ui/input";
import { StatusChip, type Tone } from "@/components/ui/status-chip";
import { useToast } from "@/components/ui/toast";

interface TokenView {
  id: string;
  system: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  status: "active" | "expired" | "revoked";
}
interface SystemOption {
  key: string;
  nameAr: string;
  scopes: string[];
}

const SCOPE_LABELS: Record<string, string> = {
  "capacity.read": "قراءة قدرة الرد (محادثات بلا رد · زمن أول رد)",
  "retarget.create": "إنشاء حملات إعادة الاستهداف",
  "retarget.read": "قراءة نتائج الحملات",
};
const STATUS: Record<TokenView["status"], { label: string; tone: Tone }> = {
  active: { label: "شغّال", tone: "success" },
  expired: { label: "منتهي", tone: "warning" },
  revoked: { label: "موقوف", tone: "danger" },
};

/** إنشاء التوكن وعرضه مرة وحدة + قائمة التوكنات (آخر استخدام · الانتهاء · إيقاف). ما في تعديل: التغيير = توكن جديد وإيقاف القديم. */
export function SystemTokensView() {
  const toast = useToast();
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [systems, setSystems] = useState<SystemOption[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [system, setSystem] = useState("mediabuyer");
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ token: string; view: TokenView } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<TokenView | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ tokens: TokenView[]; systems: SystemOption[] }>("/api/settings/system-tokens");
      setTokens(d.tokens);
      setSystems(d.systems);
    } catch (e) {
      if ((e as { status?: number }).status === 403) setForbidden(true);
      else toast.show("تعذّر تحميل التوكنات", "error");
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setCopied(false);
    try {
      const d = await api<{ token: string; view: TokenView }>("/api/settings/system-tokens", {
        method: "POST",
        json: { system, ...(name.trim() ? { name: name.trim() } : {}), expiresInDays: Number(days) },
      });
      setFresh(d);
      setName("");
      void load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذّر إنشاء التوكن", "error");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: TokenView) {
    setBusy(true);
    try {
      await api(`/api/settings/system-tokens/${t.id}/revoke`, { method: "POST" });
      toast.show("وقفنا التوكن — أي نداء فيه هلأ بيرجع 401", "success");
      setRevoking(null);
      void load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذّر الإيقاف", "error");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!fresh) return;
    await navigator.clipboard?.writeText(fresh.token).catch(() => undefined);
    setCopied(true);
  }

  if (forbidden) return <p className="text-sm text-ink-muted">ما عندك صلاحية تدير توكنات الأنظمة.</p>;
  const picked = systems.find((s) => s.key === system);

  return (
    <div className="space-y-4">
      <GlassCard className="space-y-3 p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <KeyRound size={16} aria-hidden /> توكن جديد
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="النظام">
            <Select value={system} onChange={(e) => setSystem(e.target.value)} aria-label="النظام">
              {systems.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.nameAr}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="الاسم (اختياري)" hint="بيساعدك تميّزه لاحقًا">
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={picked?.nameAr} />
          </Field>
          <Field label="صلاحيته">
            <Select value={days} onChange={(e) => setDays(e.target.value)} aria-label="مدة الصلاحية">
              <option value="30">30 يوم</option>
              <option value="90">90 يوم</option>
              <option value="180">180 يوم</option>
              <option value="365">سنة</option>
            </Select>
          </Field>
        </div>
        {picked && (
          <p className="text-xs text-ink-muted">
            الصلاحيات: {picked.scopes.map((s) => SCOPE_LABELS[s] ?? s).join(" · ")}. ما بيقدر يعمل غيرها.
          </p>
        )}
        <Callout
          risk="التوكن بيفتح للنظام اللي بياخده قراءة بيانات من موقعك. ما بنرجّع نصه بعد هالمرة، ولو تسرّب بيقدر أي حدا يستعمله."
          fix="انسخه مباشرة وحطّه بالنظام التاني. إذا تسرّب أو ضاع: أوقفه من القائمة تحت وسوّي واحد جديد."
        />
        <Button onClick={() => void create()} loading={busy} disabled={busy || systems.length === 0}>
          أنشئ التوكن
        </Button>
      </GlassCard>

      {fresh && (
        <GlassCard className="space-y-2 border-success/40 p-4 sm:p-5" data-fresh-token>
          <p className="text-sm font-semibold text-ink">هاد توكن «{fresh.view.name}» — انسخه هلأ، ما رح يظهر مرة تانية</p>
          <div className="flex items-center gap-2">
            <Input readOnly dir="ltr" value={fresh.token} aria-label="التوكن" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
            <Button variant="secondary" onClick={() => void copy()} aria-label="انسخ التوكن">
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
              {copied ? "اننسخ" : "انسخ"}
            </Button>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setFresh(null)}>
            نسخته وخلصت
          </Button>
        </GlassCard>
      )}

      <GlassCard className="p-4 sm:p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">التوكنات</h2>
        {tokens === null ? (
          <p className="text-sm text-ink-muted">بنحمّل…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-ink-muted">ما في توكنات. أنشئ أول توكن للميديا باير من فوق (صلاحية قراءة قدرة الرد).</p>
        ) : (
          <ul className="divide-y divide-line">
            {tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-3" data-token-row={t.id}>
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    {t.name} <StatusChip tone={STATUS[t.status].tone}>{STATUS[t.status].label}</StatusChip>
                  </p>
                  <p className="text-xs text-ink-muted" dir="ltr">
                    {t.prefix}…
                  </p>
                  <p className="text-xs text-ink-muted">{t.scopes.map((s) => SCOPE_LABELS[s]?.split(" (")[0] ?? s).join(" · ")}</p>
                  <p className="text-xs text-ink-subtle">
                    آخر استخدام: {t.lastUsedAt ? <DateTime value={t.lastUsedAt} mode="relative" /> : "ما انستخدم"} · ينتهي: {t.expiresAt ? <DateTime value={t.expiresAt} mode="date" /> : "—"}
                  </p>
                </div>
                {t.status === "active" && (
                  <Button size="sm" variant="secondary" onClick={() => setRevoking(t)}>
                    أوقف
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </GlassCard>

      <ConfirmDialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && void revoke(revoking)}
        title="إيقاف التوكن؟"
        body="النظام اللي بيستعمله بيوقف عن الوصول فورًا. ما بتقدر ترجّعه — بتسوي توكن جديد."
        confirmLabel="أوقفه"
        busy={busy}
        danger
      />
    </div>
  );
}
