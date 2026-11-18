"use client";

import { useEffect, useState } from "react";
import { PlugZap, Send } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { CONNECT_TYPES, TYPE_META, connectBody, type ConnectType } from "./model";
import { CHANNELS_STRINGS as S } from "./strings";

type Kind = "FACEBOOK" | ConnectType;

/**
 * «أضف صفحة أو قناة»: فيسبوك بالتحويل لـOAuth (رابط مش نموذج)، والباقي بنموذج اعتماد — الخادم بيتحقق منه لحظيًا قبل ما يخزّن
 * (مشفّر). التوكنات بحقول سرّية (`PasswordInput`) وما بترجع للشاشة أبدًا. تيك توك مسكّر لحد الاعتماد.
 */
export function ConnectDialog({
  open,
  initial,
  oauthConfigured,
  onClose,
  onLinked,
}: {
  open: boolean;
  initial: Kind;
  oauthConfigured: boolean;
  onClose: () => void;
  onLinked: (message: string) => void;
}) {
  const C = S.connect;
  const [kind, setKind] = useState<Kind>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKind(initial);
      setError(null);
    }
  }, [open, initial]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (kind === "FACEBOOK") return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ nextStep?: string | null }>(`/api/channels/${kind}`, { method: "POST", json: connectBody(kind, new FormData(e.currentTarget)) });
      onLinked(r.nextStep ?? C.linked);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : C.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={C.title} className="max-w-lg">
      <form onSubmit={submit} className="space-y-3">
        <Field label={C.channel} hint={TYPE_META[kind]?.hint}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="FACEBOOK">{TYPE_META.FACEBOOK!.name}</option>
            {CONNECT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_META[t]!.name}
              </option>
            ))}
            <option value="TIKTOK" disabled>
              {TYPE_META.TIKTOK!.name} — {TYPE_META.TIKTOK!.hint}
            </option>
          </Select>
        </Field>

        {kind === "FACEBOOK" &&
          (oauthConfigured ? (
            <a href="/api/channels/facebook/connect" className="inline-flex h-10 items-center gap-2 rounded-control bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-focus">
              <PlugZap size={15} aria-hidden /> {C.fbButton}
            </a>
          ) : (
            <Callout risk={C.fbMissingRisk} fix={C.fbMissingFix} />
          ))}

        {kind === "INSTAGRAM" && (
          <>
            <Field label={C.igId}>
              <Input name="igId" required dir="ltr" />
            </Field>
            <Field label={C.token}>
              <PasswordInput kind="secret" name="token" required dir="ltr" />
            </Field>
          </>
        )}
        {kind === "TELEGRAM" && (
          <Field label={C.botToken}>
            <PasswordInput kind="secret" name="botToken" required dir="ltr" />
          </Field>
        )}
        {kind === "WHATSAPP" && (
          <>
            <Field label={C.phoneId}>
              <Input name="phoneNumberId" required dir="ltr" />
            </Field>
            <Field label={C.token}>
              <PasswordInput kind="secret" name="token" required dir="ltr" />
            </Field>
          </>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {C.cancel}
          </Button>
          {kind !== "FACEBOOK" && (
            <Button type="submit" loading={busy}>
              <Send size={14} aria-hidden /> {C.submit}
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
