"use client";

import { useState } from "react";
import { KeyRound, Plus, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { CopyField, FixNote, HealthPill, RiskNote, apiJson, fmtDateTime } from "./ui";

export interface TokenView {
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

export interface TokenPreset {
  system: string;
  nameAr: string;
  scopes: string[];
}

const SCOPE_AR: Record<string, string> = {
  "capacity.read": "قراءة قدرة الرد",
  "retarget.create": "إنشاء حملات إعادة تواصل",
  "retarget.read": "قراءة حالة الحملات",
  "agent.read": "أدوات القراءة",
  "agent.draft": "أدوات المسودة",
};

/** أسماء متغيرات البيئة عند كل نظام (من ملفات عقده) لتلصق التوكن مباشرة. */
function envLines(system: string, token: string, appUrl: string | null): string {
  const base = appUrl || "https://<رابط-الردود>";
  if (system === "hermes-bridge") return `REPLIES_URL=${base}\nREPLIES_AGENT_TOKEN=${token}`;
  if (system === "mediabuyer") return `REPLIES_BASE_URL=${base}\nREPLIES_TOKEN=${token}`;
  return `REPLIES_BASE_URL=${base}\nREPLIES_TOKEN=${token}`;
}

export function TokenManager({
  tokens,
  presets,
  systems,
  appUrl,
  onChange,
}: {
  tokens: TokenView[];
  presets: TokenPreset[];
  /** الأنظمة الي بتظهر بهالقسم (مثلًا الجسر بس بصفحة الوكلاء). */
  systems: string[];
  appUrl: string | null;
  onChange: () => void;
}) {
  const toast = useToast();
  const usable = presets.filter((p) => systems.includes(p.system));
  const [system, setSystem] = useState(usable[0]?.system ?? "");
  const [name, setName] = useState("");
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ token: string; system: string } | null>(null);
  const [revoking, setRevoking] = useState<TokenView | null>(null);
  const list = tokens.filter((t) => systems.includes(t.system));
  const nameOf = (s: string) => presets.find((p) => p.system === s)?.nameAr ?? s;

  async function create() {
    setBusy(true);
    try {
      const res = await apiJson<{ token: string }>("/api/integrations/tokens", {
        method: "POST",
        json: { system, ...(name.trim() ? { name: name.trim() } : {}), expiresInDays: days },
      });
      setCreated({ token: res.token, system });
      setName("");
      onChange();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل إنشاء التوكن", "error");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(tok: TokenView) {
    setBusy(true);
    try {
      await apiJson(`/api/integrations/tokens/${tok.id}`, { method: "DELETE" });
      toast.show("انوقف التوكن — أي نداء فيه بينرفض من هلأ");
      onChange();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل الإيقاف", "error");
    } finally {
      setBusy(false);
      setRevoking(null);
    }
  }

  return (
    <div className="space-y-3">
      {list.length === 0 ? (
        <p className="text-xs text-ink-subtle">ما في توكنات لسا.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((t) => (
            <li key={t.id} className="glass-subtle flex flex-wrap items-start justify-between gap-2 rounded-xl p-3">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-1.5 text-xs font-bold text-ink">
                  <KeyRound size={13} className="text-ink-subtle" />
                  {t.name}
                  <HealthPill health={t.status === "active" ? "ok" : t.status === "expired" ? "warn" : "off"}>
                    {t.status === "active" ? "فعّال" : t.status === "expired" ? "منتهي" : "موقوف"}
                  </HealthPill>
                </p>
                <p className="text-[11px] text-ink-muted">
                  {nameOf(t.system)} · <span dir="ltr" className="font-mono">{t.prefix}…</span>
                </p>
                <p className="text-[11px] leading-relaxed text-ink-subtle">{t.scopes.map((s) => SCOPE_AR[s] ?? s).join(" · ")}</p>
                <p className="text-[11px] text-ink-subtle">
                  آخر استخدام: {fmtDateTime(t.lastUsedAt)} · ينتهي: {fmtDateTime(t.expiresAt)}
                </p>
              </div>
              {t.status === "active" && (
                <Button size="sm" variant="danger" onClick={() => setRevoking(t)} disabled={busy}>
                  <ShieldOff size={13} />
                  إيقاف
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {usable.length > 0 && (
        <div className="grid grid-cols-1 gap-2 border-t border-line/60 pt-3 sm:grid-cols-[1fr_1fr_110px_auto] sm:items-end">
          {usable.length > 1 ? (
            <Field label="النظام">
              <Select value={system} onChange={(e) => setSystem(e.target.value)}>
                {usable.map((p) => (
                  <option key={p.system} value={p.system}>
                    {p.nameAr}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="النظام">
              <Input value={usable[0].nameAr} readOnly />
            </Field>
          )}
          <Field label="اسم (اختياري)">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="مثلًا: جسر السيرفر الرئيسي" />
          </Field>
          <Field label="الصلاحية (يوم)">
            <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.min(365, Math.max(1, Number(e.target.value) || 90)))} dir="ltr" className="num" />
          </Field>
          <Button onClick={create} loading={busy} disabled={busy || !system} className="sm:mb-0.5">
            <Plus size={14} />
            توكن جديد
          </Button>
        </div>
      )}

      <Dialog open={Boolean(created)} onClose={() => setCreated(null)} title="انسخ التوكن الآن" className="max-w-lg">
        {created && (
          <div className="space-y-3">
            <RiskNote title="التوكن بيظهر مرة وحدة بس — بعدها ما حدا بيقدر يشوفه (ولا نحنا).">
              أي حدا معه هالتوكن بيقدر يقرأ أرقام الردود حسب صلاحياته — ما تبعته برسالة ولا تحطه بملف عام.
            </RiskNote>
            <FixNote>حطّه بملف الأسرار (.env) عند النظام التاني بس، وإذا انكشف: «إيقاف» هون واعمل واحد جديد.</FixNote>
            <CopyField label="التوكن" value={created.token} />
            <CopyField label="سطور الإعداد الجاهزة" value={envLines(created.system, created.token, appUrl)} />
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setCreated(null)}>
                نسخته
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke(revoking)}
        title={`إيقاف التوكن «${revoking?.name ?? ""}»؟`}
        body="أي نظام بيستخدمه بيترفض فورًا. الإيقاف ما بيرجع — بتعمل توكن جديد بداله."
        confirmLabel="إيقاف التوكن"
        busy={busy}
        danger
      />
    </div>
  );
}
