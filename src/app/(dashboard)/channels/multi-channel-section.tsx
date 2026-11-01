"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageCircle, PlugZap, Send, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard } from "@/components/ui/card";

type ChannelRow = {
  id: string;
  type: string;
  status: string;
  displayName: string | null;
  externalId: string | null;
  hasAccount: boolean;
  tokenExpiring: boolean;
  lastWebhookAt: string | null;
  lastSendAt: string | null;
};

const TYPE_AR: Record<string, { name: string; hint: string; fields: string }> = {
  INSTAGRAM: { name: "إنستغرام", hint: "حساب احترافي + توكن صفحة بصلاحيات المراسلة.", fields: "ig" },
  TELEGRAM: { name: "تيليغرام", hint: "توكن بوت من BotFather. يُولَّد سرّ webhook تلقائيًا.", fields: "bot" },
  WHATSAPP: { name: "واتساب", hint: "رقم تجاري + System User Token. الرد الحر داخل 24 ساعة فقط.", fields: "wa" },
  TIKTOK: { name: "تيك توك", hint: "يتطلب اعتماد Business Messaging — الربط مغلق حتى الاعتماد.", fields: "none" },
};

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

/**
 * Multi-channel section (P5). Read-only overview + credential forms.
 * Tokens are never displayed back (API never returns them). A channel card
 * never claims a working connection it has not proven (status-driven).
 */
export function MultiChannelSection() {
  const [rows, setRows] = useState<ChannelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openForm, setOpenForm] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = (await api("/api/channels", "GET")) as { channels: ChannelRow[] };
      setRows(data.channels.filter((c) => c.type !== "FACEBOOK"));
    } catch {
      setMessage("تعذر تحميل القنوات");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function connect(type: string, form: FormData) {
    setBusy(true);
    try {
      const body: Record<string, unknown> =
        type === "INSTAGRAM"
          ? { igId: form.get("igId"), token: form.get("token") }
          : type === "TELEGRAM"
            ? { botToken: form.get("botToken") }
            : { phoneNumberId: form.get("phoneNumberId"), token: form.get("token") };
      const data = (await api(`/api/channels/${type}`, "POST", body)) as { nextStep?: string | null; webhookUrl?: string | null };
      setMessage(data.nextStep ?? "تم الربط بنجاح.");
      if (data.webhookUrl) setMessage((m) => `${m ?? ""} Webhook: ${data.webhookUrl}`);
      setOpenForm(null);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "فشل الربط");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(type: string, externalId: string | null) {
    if (!window.confirm("فصل هذه القناة؟ ستتوقف الرسائل الجديدة فورًا.")) return;
    setBusy(true);
    try {
      await api(`/api/channels/${type}`, "DELETE", externalId ? { externalId } : {});
      setMessage("تم الفصل.");
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "فشل الفصل");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassCard className="p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary-soft text-primary">
          <MessageCircle size={20} />
        </span>
        <div>
          <h2 className="text-sm font-bold text-ink">قنوات إضافية</h2>
          <p className="mt-0.5 text-xs text-ink-muted">ربط رسمي لكل قناة — بلا جلسات متصفح ولا تحايل.</p>
        </div>
      </div>
      {message && <p className="mb-3 rounded-xl bg-brand-500/10 px-3 py-2 text-xs font-medium text-brand-700 dark:text-brand-300">{message}</p>}
      {loading && <Skeleton className="h-24 rounded-2xl" />}
      {!loading && (
        <div className="space-y-3">
          {Object.entries(TYPE_AR).map(([type, meta]) => {
            const linked = rows.filter((r) => r.type === type);
            return (
              <div key={type} className="rounded-xl border border-line/70 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-ink">{meta.name}</p>
                    <p className="mt-0.5 text-[11px] text-ink-muted">{meta.hint}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {linked.length > 0 && <StatusBadge value={linked[0].status} dot />}
                    {type !== "TIKTOK" && (
                      <Button size="sm" variant="secondary" onClick={() => setOpenForm(openForm === type ? null : type)}>
                        <PlugZap size={13} />
                        ربط {meta.name}
                      </Button>
                    )}
                  </div>
                </div>
                {linked.map((c) => (
                  <div key={c.id} className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2/60 px-2.5 py-2 text-xs dark:bg-white/[0.02]">
                    <span className="font-semibold text-ink">
                      {c.displayName ?? c.externalId ?? "—"}
                      <span className="num ms-2 text-ink-subtle" dir="ltr">{c.externalId ?? ""}</span>
                    </span>
                    <span className="flex items-center gap-2 text-ink-muted">
                      {c.lastSendAt ? `آخر إرسال: ${new Date(c.lastSendAt).toLocaleDateString("ar")}` : "بلا إرسال بعد"}
                      {c.status === "CONNECTED" && (
                        <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-500/10 dark:text-red-400" disabled={busy} onClick={() => disconnect(type, c.externalId)}>
                          <Unplug size={13} />
                          فصل
                        </Button>
                      )}
                    </span>
                  </div>
                ))}
                {openForm === type && (
                  <form
                    className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void connect(type, new FormData(e.currentTarget));
                    }}
                  >
                    {meta.fields === "ig" && (
                      <>
                        <Field label="معرّف حساب إنستغرام (Instagram ID)"><Input name="igId" required dir="ltr" placeholder="123456789" /></Field>
                        <Field label="توكن الصفحة (Page Access Token)"><PasswordInput kind="secret" name="token" required dir="ltr" placeholder="EAA…" /></Field>
                      </>
                    )}
                    {meta.fields === "bot" && (
                      <Field label="توكن البوت (Bot Token من BotFather)">
                        <PasswordInput kind="secret" name="botToken" required dir="ltr" placeholder="123456:ABC-DEF…" />
                      </Field>
                    )}
                    {meta.fields === "wa" && (
                      <>
                        <Field label="معرّف رقم واتساب (Phone Number ID)"><Input name="phoneNumberId" required dir="ltr" placeholder="123456789012345" /></Field>
                        <Field label="توكن مستخدم النظام (System User Token)"><PasswordInput kind="secret" name="token" required dir="ltr" placeholder="EAA…" /></Field>
                      </>
                    )}
                    <div className="flex items-end">
                      <Button type="submit" size="sm" loading={busy} disabled={busy}>
                        <Send size={13} />
                        تحقق واربط
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}
    </GlassCard>
  );
}
