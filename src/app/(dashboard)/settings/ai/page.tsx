"use client";

import { useEffect, useState } from "react";

const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500";

type Settings = {
  provider: string;
  classificationModel: string | null;
  extractionModel: string | null;
  responseModel: string | null;
  visionModel: string | null;
  summaryModel: string | null;
  temperature: number;
  maxTokens: number;
  confidenceExecute: number;
  confidenceRespond: number;
  humanHandoffThreshold: number;
  aiEnabled: boolean;
  autoRespond: boolean;
};

export default function AISettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/ai/settings").then(async (res) => {
      if (res.ok) setSettings(await res.json());
    });
  }, []);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    const num = (k: string) => Number(form.get(k));
    const res = await fetch("/api/ai/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: form.get("provider"),
        classificationModel: form.get("classificationModel") || null,
        extractionModel: form.get("extractionModel") || null,
        responseModel: form.get("responseModel") || null,
        visionModel: form.get("visionModel") || null,
        summaryModel: form.get("summaryModel") || null,
        temperature: num("temperature"),
        maxTokens: num("maxTokens"),
        confidenceExecute: num("confidenceExecute"),
        confidenceRespond: num("confidenceRespond"),
        humanHandoffThreshold: num("humanHandoffThreshold"),
        aiEnabled: form.get("aiEnabled") === "on",
        autoRespond: form.get("autoRespond") === "on",
      }),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  if (!settings) return <p className="text-sm text-slate-400">جارٍ التحميل…</p>;

  return (
    <form onSubmit={save} className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">إعدادات AI</h1>
        {saved && <span className="rounded-lg bg-emerald-50 px-3 py-1 text-xs text-emerald-700">تم الحفظ ✓</span>}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold text-slate-700">المزود والنماذج</h2>
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          مفاتيح الـ API تُدار حصراً عبر متغيرات البيئة على الخادم ولا تُعرض أو تُعدّل من هنا.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="text-xs text-slate-500">
            المزود
            <select name="provider" defaultValue={settings.provider} className={input}>
              {["mock", "openai", "openrouter"].map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
          {[
            ["classificationModel", "نموذج التصنيف (رخيص)"],
            ["extractionModel", "نموذج الاستخراج (متوسط)"],
            ["responseModel", "نموذج الرد (الأقوى)"],
            ["visionModel", "نموذج الرؤية"],
            ["summaryModel", "نموذج التلخيص (رخيص)"],
          ].map(([key, label]) => (
            <label key={key} className="text-xs text-slate-500">
              {label}
              <input name={key} defaultValue={(settings as never as Record<string, string | null>)[key] ?? ""} dir="ltr" className={input} />
            </label>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold text-slate-700">التوليد</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <label className="text-xs text-slate-500">Temperature
            <input name="temperature" type="number" step="0.1" min="0" max="2" defaultValue={settings.temperature} className={input} />
          </label>
          <label className="text-xs text-slate-500">Max tokens
            <input name="maxTokens" type="number" min="50" max="4000" defaultValue={settings.maxTokens} className={input} />
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold text-slate-700">الثقة والتحكم</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="text-xs text-slate-500">حد التنفيذ الآمن
            <input name="confidenceExecute" type="number" step="0.05" min="0" max="1" defaultValue={settings.confidenceExecute} className={input} />
          </label>
          <label className="text-xs text-slate-500">حد الرد المحدود
            <input name="confidenceRespond" type="number" step="0.05" min="0" max="1" defaultValue={settings.confidenceRespond} className={input} />
          </label>
          <label className="text-xs text-slate-500">تحويل للموظف تحت
            <input name="humanHandoffThreshold" type="number" step="0.05" min="0" max="1" defaultValue={settings.humanHandoffThreshold} className={input} />
          </label>
        </div>
        <div className="mt-3 flex gap-6">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="aiEnabled" defaultChecked={settings.aiEnabled} /> تشغيل AI
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="autoRespond" defaultChecked={settings.autoRespond} /> الرد الآلي
          </label>
        </div>
      </div>

      <button disabled={saving} className="rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
        {saving ? "جارٍ الحفظ…" : "حفظ الإعدادات"}
      </button>
    </form>
  );
}
