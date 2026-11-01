"use client";

import { useCallback, useEffect, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { GlassCard } from "@/components/ui/card";

type Settings = {
  enabled: boolean;
  chatId: string | null;
  topicId: string | null;
  hasToken: boolean;
};

/**
 * P19 — ربط بوت تيليجرام الذي يستقبل الطلبات الجاهزة.
 *
 * ⚠️ عند التفعيل تُرسل بيانات الطلب (اسم/هاتف/عنوان) إلى مجموعة تيليجرام —
 * لازم تكون مجموعة خاصة وبيد المالك. لذلك التفعيل يتطلب موافقة صريحة هنا،
 * والتوكن لا يُعاد للواجهة أبدًا.
 */
export function TelegramOrderSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [chatId, setChatId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [token, setToken] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/telegram-orders");
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as Settings;
      setSettings(data);
      setEnabled(data.enabled);
      setChatId(data.chatId ?? "");
      setTopicId(data.topicId ?? "");
    } catch {
      setMessage({ kind: "err", text: "تعذّر تحميل إعدادات تيليجرام." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (enabled && !consent) {
      setMessage({ kind: "err", text: "لتفعيل الإرسال لازم توافق على إرسال بيانات الطلب إلى تيليجرام." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/telegram-orders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          chatId: chatId.trim() || null,
          topicId: topicId.trim() || null,
          ...(token.trim() ? { botToken: token.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? "تعذّر الحفظ");
      setSettings(data as Settings);
      setToken("");
      setMessage({ kind: "ok", text: enabled ? "تم التفعيل — الطلبات الجاهزة رح توصل لتيليجرام." : "تم الحفظ (الإرسال متوقف)." });
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "تعذّر الحفظ" });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setTesting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/telegram-orders/test", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? "فشل الاختبار");
      setMessage({
        kind: "ok",
        text: `تم الإرسال ✅${data.botUsername ? ` (البوت: @${data.botUsername})` : ""} — شوف المجموعة/التوبيك.`,
      });
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "فشل الاختبار" });
    } finally {
      setTesting(false);
    }
  }

  if (forbidden) return null;

  return (
    <GlassCard className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-300">
              <Send size={15} />
            </span>
            إرسال الطلبات الجاهزة إلى تيليجرام
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            كل مسودة طلب تكتمل بياناتها (حسب إعداد الصفحة) تُرسل تلقائيًا لمجموعة تيليجرام — مجموعة وتوبيك تحدّدهم هنا.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs font-semibold text-ink">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-primary)]"
          />
          مفعّل
        </label>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="توكن بوت تيليجرام" className="md:col-span-2">
          <PasswordInput
            kind="secret"
            dir="ltr"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={settings?.hasToken ? "محفوظ — اتركه فارغًا للإبقاء عليه" : "123456789:AA..."}
            autoComplete="off"
          />
        </Field>
        <Field label="معرّف المجموعة (chat_id)">
          <Input dir="ltr" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-1001234567890" />
        </Field>
        <Field label="معرّف التوبيك (topic_id — اختياري)">
          <Input dir="ltr" value={topicId} onChange={(e) => setTopicId(e.target.value)} placeholder="مثال: 42" />
        </Field>
      </div>

      <label className="mt-3 flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-800 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-primary)]"
        />
        <span>
          أوافق على إرسال بيانات الطلب (اسم الزبون · هاتفه · عنوانه) إلى مجموعة تيليجرام المحددة. تأكد أن المجموعة
          خاصة وبيد فريقك فقط.
        </span>
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => void save()} loading={busy} disabled={busy}>
          حفظ إعدادات تيليجرام
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void test()}
          loading={testing}
          disabled={testing || (!settings?.hasToken && !token.trim())}
        >
          إرسال رسالة اختبار
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
