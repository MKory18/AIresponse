"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { GlassCard } from "@/components/ui/card";
import { FixNote, HealthPill, InfoNote, SectionHead } from "@/components/integrations/ui";

type State = {
  configId: string | null;
  envConfigured: boolean;
  source: "workspace" | "env" | "none";
};

const SOURCE_LABEL: Record<State["source"], { health: "ok" | "warn" | "off"; text: string }> = {
  workspace: { health: "ok", text: "من إعدادات الموقع" },
  env: { health: "warn", text: "من الخادم (احتياط)" },
  none: { health: "off", text: "بلا إعداد — بنطلب الصلاحيات مباشرة" },
};

/**
 * «ربط ميتا» — رقم إعداد تسجيل الدخول (config_id) لتطبيق ميتا نوع Business.
 * محفوظ لكل مساحة بقاعدة البيانات؛ بيغلب `META_LOGIN_CONFIG_ID` من الخادم.
 * زر «اختبر» بيفتح شاشة موافقة فيسبوك بالرقم المحفوظ (من مسار الربط نفسه).
 */
export function MetaLoginSection() {
  const [state, setState] = useState<State | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/meta-login");
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as State;
      setState(data);
      setValue(data.configId ?? "");
    } catch {
      setMessage({ kind: "err", text: "تعذّر تحميل إعدادات ربط ميتا." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = (state?.configId ?? "") !== value.trim();

  async function save(): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/meta-login", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configId: value.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? "تعذّر الحفظ");
      setState(data as State);
      setValue((data as State).configId ?? "");
      setMessage({ kind: "ok", text: value.trim() ? "تم حفظ رقم الإعداد." : "تم المسح." });
      return true;
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "تعذّر الحفظ" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (dirty && !(await save())) return;
    // نفس مسار «ربط صفحة Facebook» — بيفتح شاشة موافقة فيسبوك بتبويب جديد.
    window.open("/api/channels/facebook/connect", "_blank", "noopener");
  }

  if (forbidden) return null;
  const src = SOURCE_LABEL[state?.source ?? "none"];

  return (
    <GlassCard className="p-4 sm:p-5">
      <SectionHead
        icon={<Link2 size={15} />}
        tone="sky"
        title="ربط ميتا"
        sub="رقم إعداد تسجيل الدخول لتطبيق ميتا نوع Business — بدونه ميتا بترجّع صفر صفحات بعد الموافقة."
        action={state ? <HealthPill health={src.health}>{src.text}</HealthPill> : undefined}
      />

      <div className="mt-3 grid grid-cols-1 gap-3">
        <Field label="رقم إعداد تسجيل الدخول (config_id)">
          <Input
            dir="ltr"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="مثال: 2372832796853310"
            autoComplete="off"
          />
        </Field>
        <InfoNote>
          بتلاقيه من لوحة تطبيق ميتا ← Facebook Login for Business ← Configurations. اتركه فاضي إذا تطبيقك
          عادي (Consumer).
        </InfoNote>
        {state?.envConfigured && state.source !== "workspace" && (
          <FixNote>
            في رقم إعداد محفوظ على الخادم وهو المستعمل هلق — أي رقم بتحفظه هون بيغلبه، ومسحه بيرجّع قيمة الخادم.
          </FixNote>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => void save()} loading={busy} disabled={busy || !dirty}>
          حفظ
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void test()}
          disabled={busy || (!value.trim() && state?.source !== "env")}
        >
          اختبر
        </Button>
        {message && (
          <span className={`text-xs ${message.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
            {message.text}
          </span>
        )}
      </div>
    </GlassCard>
  );
}
