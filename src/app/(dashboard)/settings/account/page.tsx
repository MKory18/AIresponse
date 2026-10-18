"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, KeyRound, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/confirm";
import { Field, Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";

type Me = { id: string; email: string; name: string; isSuperAdmin: boolean };

async function api(path: string, method: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error((data.message as string) ?? (data.error as string) ?? "فشل الطلب");
  return data;
}

function fieldValue(e: React.FormEvent<HTMLFormElement>, field: string): string {
  return String(new FormData(e.currentTarget).get(field) ?? "");
}

/** msg node with success/error tone. */
function Msg({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className={`mt-2 flex items-center gap-1 text-xs ${text.includes("تم") ? "text-emerald-600" : "text-red-600"}`}>
      <Check size={12} /> {text}
    </p>
  );
}

export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMsg, setNameMsg] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const data = (await api("/api/auth/me", "GET")) as { user: Me };
      setMe(data.user);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "فشل التحميل");
    }
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  async function saveName(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setNameBusy(true);
    setEmailMsg("");
    setPwMsg("");
    setNameMsg("");
    try {
      const data = (await api("/api/auth/me", "PATCH", { name: fieldValue(e, "name") })) as { user: Me };
      setMe(data.user);
      setNameMsg("تم حفظ الاسم");
    } catch (err) {
      setNameMsg(err instanceof Error ? err.message : "فشل حفظ الاسم");
    } finally {
      setNameBusy(false);
    }
  }

  async function saveEmail(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEmailBusy(true);
    setNameMsg("");
    setPwMsg("");
    setEmailMsg("");
    try {
      const data = (await api("/api/auth/me", "PATCH", {
        email: fieldValue(e, "email"),
        currentPassword: fieldValue(e, "currentPassword"),
      })) as { user: Me };
      setMe(data.user);
      setEmailMsg("تم تغيير البريد");
      e.currentTarget.reset();
    } catch (err) {
      setEmailMsg(err instanceof Error ? err.message : "فشل تغيير البريد");
    } finally {
      setEmailBusy(false);
    }
  }

  async function savePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPwBusy(true);
    setNameMsg("");
    setEmailMsg("");
    setPwMsg("");
    try {
      await api("/api/auth/me", "PATCH", {
        newPassword: fieldValue(e, "newPassword"),
        currentPassword: fieldValue(e, "currentPassword"),
      });
      setPwMsg("تم تغيير كلمة المرور");
      e.currentTarget.reset();
    } catch (err) {
      setPwMsg(err instanceof Error ? err.message : "فشل تغيير كلمة المرور");
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="page-wrap">
      <PageHeader title="حسابي" description="اسمك، بريدك، وكلمة مرورك. تغيير البريد أو كلمة المرور يتطلب كلمة المرور الحالية." />
      {loadError && <ErrorState description={loadError} onRetry={() => void load()} />}
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : me ? (
        <div className="space-y-3">
          <GlassCard className="p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
              <UserRound size={15} /> الاسم والبريد
            </h2>
            <form onSubmit={saveName} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto]">
              <Field label="الاسم">
                <Input name="name" defaultValue={me.name} required minLength={2} maxLength={100} />
              </Field>
              <Button type="submit" size="sm" loading={nameBusy}>حفظ الاسم</Button>
            </form>
            <Msg text={nameMsg} />
            <form onSubmit={saveEmail} className="mt-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
              <Field label="البريد الإلكتروني" hint="الدخول للمنصة يصبح بهذا البريد.">
                <Input name="email" type="email" defaultValue={me.email} required dir="ltr" maxLength={255} className="num" />
              </Field>
              <Field label="كلمة المرور الحالية">
                <Input name="currentPassword" type="password" required dir="ltr" autoComplete="current-password" className="num" />
              </Field>
              <div className="sm:col-span-2">
                <Button type="submit" size="sm" loading={emailBusy}>تغيير البريد</Button>
              </div>
            </form>
            <Msg text={emailMsg} />
          </GlassCard>

          <GlassCard className="p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
              <KeyRound size={15} /> كلمة المرور
            </h2>
            <form onSubmit={savePassword} className="space-y-3">
              <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
                <Field label="كلمة المرور الحالية">
                  <Input name="currentPassword" type="password" required dir="ltr" autoComplete="current-password" className="num" />
                </Field>
                <Field label="كلمة المرور الجديدة" hint="8 أحرف على الأقل.">
                  <Input name="newPassword" type="password" required minLength={8} maxLength={128} dir="ltr" autoComplete="new-password" className="num" />
                </Field>
              </div>
              <Button type="submit" size="sm" loading={pwBusy}>تغيير كلمة المرور</Button>
            </form>
            <Msg text={pwMsg} />
          </GlassCard>
        </div>
      ) : null}
    </div>
  );
}
