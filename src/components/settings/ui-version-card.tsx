"use client";

import { useEffect, useState } from "react";
import { LayoutTemplate } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassCard } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { UI_VERSION_COOKIE, parseUiVersion, type UiVersion } from "@/lib/ui-version";

function readCookie(): UiVersion | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${UI_VERSION_COOKIE}=([^;]*)`));
  return parseUiVersion(m?.[1]);
}

function writeCookie(v: UiVersion | null) {
  // معاينة شخصية: سنة، لهالمتصفح بس. حذف = رجوع لإعداد المساحة.
  document.cookie = v
    ? `${UI_VERSION_COOKIE}=${v}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
    : `${UI_VERSION_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/**
 * «جرّب الواجهة الجديدة» (2.3ب): معاينة شخصية بكوكي (ما بتأثّر على الفريق) + تفعيلها للمساحة كلها (المالك بس، بإيده).
 */
export function UiVersionCard() {
  const [preview, setPreview] = useState<UiVersion | null>(null);
  const [workspace, setWorkspace] = useState<{ uiVersion: UiVersion; canChange: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(readCookie());
    api<{ uiVersion: UiVersion; canChange: boolean }>("/api/settings/ui-version").then(setWorkspace).catch(() => setWorkspace(null));
  }, []);

  function setPersonal(v: UiVersion | null) {
    writeCookie(v);
    window.location.href = "/settings/account";
  }

  async function setForWorkspace(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ uiVersion: UiVersion }>("/api/settings/ui-version", { method: "PATCH", json: { uiVersion: next ? "v2" : "v1" } });
      setWorkspace((w) => (w ? { ...w, uiVersion: r.uiVersion } : w));
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الحفظ");
    } finally {
      setBusy(false);
    }
  }

  const onNew = preview === "v2";
  return (
    <GlassCard className="space-y-3 p-4" data-ui-version-card>
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
        <LayoutTemplate size={15} aria-hidden /> الواجهة الجديدة
      </h2>
      <p className="text-sm text-ink-muted">شكل جديد للموقع بيتبنى خطوة خطوة. جرّبه لحالك — الفريق ما بيتأثّر.</p>
      <div className="flex flex-wrap gap-2">
        {onNew ? (
          <Button variant="secondary" onClick={() => setPersonal("v1")}>
            ارجع للواجهة الحالية
          </Button>
        ) : (
          <Button onClick={() => setPersonal("v2")}>جرّب الواجهة الجديدة</Button>
        )}
      </div>
      {workspace?.canChange && (
        <div className="space-y-2 border-t border-line pt-3">
          <Switch
            checked={workspace.uiVersion === "v2"}
            onChange={(n) => void setForWorkspace(n)}
            busy={busy}
            label="فعّل الواجهة الجديدة للفريق كله"
            description="بتنطبق على كل الأعضاء. بتقدر ترجّعها بأي وقت."
          />
          <Callout risk="الواجهة الجديدة لسا ما اكتملت — بعض الصفحات بتضل بشكلها الحالي لحد ما تنبني." fix="جرّبها لحالك أول، وفعّلها للفريق لما تطمّن." collapsible />
          {error && (
            <p role="alert" className="text-xs font-semibold text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </GlassCard>
  );
}
