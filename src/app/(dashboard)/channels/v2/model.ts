/**
 * نموذج «الصفحات والقنوات» (3.6) — دوال صرفة: وسم الاتصال · هل بدها إعادة ربط · الصفحات المعلّقة بعد OAuth · جسم الربط لكل قناة.
 */
import type { Tone } from "@/components/ui/status-chip";

export interface ChannelRow {
  id: string;
  type: string;
  status: string;
  displayName: string | null;
  externalId: string | null;
  aiPersonaId: string | null;
  sendMode: "AUTO_REPLY" | "COLLECTION_ONLY" | string;
  market: string | null;
  catalog: { id: string; name: string; isActive: boolean } | null;
  hasAccount: boolean;
  tokenStatus: "VALID" | "EXPIRED" | "LONG_LIVED" | string;
  connectedAt: string | null;
  lastWebhookAt: string | null;
  lastSendAt: string | null;
}

export const TYPE_META: Record<string, { name: string; hint: string }> = {
  FACEBOOK: { name: "فيسبوك", hint: "ربط صفحة فيسبوك رسميًا (Meta)." },
  INSTAGRAM: { name: "إنستغرام", hint: "حساب احترافي + توكن صفحة بصلاحيات المراسلة." },
  TELEGRAM: { name: "تيليغرام", hint: "توكن بوت من BotFather." },
  WHATSAPP: { name: "واتساب", hint: "رقم تجاري + توكن مستخدم النظام. الرد الحر داخل 24 ساعة بس." },
  TIKTOK: { name: "تيك توك", hint: "الربط مسكّر لحد اعتماد المراسلة." },
  WEB: { name: "الموقع", hint: "" },
};

export const SEND_MODES = [
  { value: "AUTO_REPLY", label: "رد آلي" },
  { value: "COLLECTION_ONLY", label: "قراءة فقط" },
] as const;

/** سوق القناة (بيحكم صيغة الهاتف والمحافظات). القيمة الفاضية = غير محدد. */
export const MARKETS = [
  { value: "SY", label: "سوريا" },
  { value: "JO", label: "الأردن" },
  { value: "", label: "غير محدد" },
] as const;

/** اتصال القناة بنص ونبرة (النبرة + النص، مش اللون بس). */
export function connectionChip(c: Pick<ChannelRow, "status" | "tokenStatus">): { text: string; tone: Tone } {
  if (c.tokenStatus === "EXPIRED") return { text: "التوكن منتهي", tone: "danger" };
  switch (c.status) {
    case "CONNECTED":
      return { text: "مربوطة", tone: "success" };
    case "CONNECTING":
      return { text: "عم تنربط", tone: "info" };
    case "ERROR":
      return { text: "فيها خطأ", tone: "danger" };
    default:
      return { text: "مفصولة", tone: "neutral" };
  }
}

/** «أعد الربط»: التوكن منتهي، أو القناة بخطأ/مفصولة وإلها حساب سابق (بيانات الربط محفوظة). */
export function needsReconnect(c: Pick<ChannelRow, "status" | "tokenStatus" | "hasAccount">): boolean {
  return c.tokenStatus === "EXPIRED" || c.status === "ERROR" || (c.status === "DISCONNECTED" && c.hasAccount);
}

export interface PendingPage {
  id: string;
  name: string;
}

export type ConnectType = "INSTAGRAM" | "TELEGRAM" | "WHATSAPP";
export const CONNECT_TYPES: readonly ConnectType[] = ["INSTAGRAM", "TELEGRAM", "WHATSAPP"];

/** جسم طلب الربط حسب القناة (الخادم بيتحقق من الاعتماد لحظيًا قبل ما يخزّن شي). */
export function connectBody(type: ConnectType, f: { get(name: string): FormDataEntryValue | null }): Record<string, unknown> {
  const s = (k: string) => String(f.get(k) ?? "").trim();
  if (type === "INSTAGRAM") return { igId: s("igId"), token: s("token") };
  if (type === "TELEGRAM") return { botToken: s("botToken") };
  return { phoneNumberId: s("phoneNumberId"), token: s("token") };
}

/**
 * صفحات فيسبوك المربوطة عندنا بس ما رجعت بقائمة فيسبوك لهالدورة.
 *
 * ⚠️ فيسبوك بيعطي التطبيق بس الصفحات اللي علّمها المالك بشاشة الموافقة — ولو علّم صفحة وحدة،
 * ممكن يسحب الوصول من القديمة. فتوكنها بيموت وهي لسا CONNECTED عندنا: بلا ما تستقبل ولا ترد.
 * 🔧 منحذّر بأسمائها قبل ما المالك يكمّل، وبيقدر يشيلها (بتأكيد) إذا ما بدّه إياها.
 */
export function pagesAtRisk(pending: readonly PendingPage[], rows: readonly ChannelRow[]): ChannelRow[] {
  const returned = new Set(pending.map((p) => p.id));
  return rows.filter((r) => r.type === "FACEBOOK" && r.status === "CONNECTED" && r.externalId !== null && !returned.has(r.externalId));
}

export interface ConnectSelectedResult {
  linked: string[];
  failed: Array<{ id: string; message: string }>;
}

/**
 * ربط الصفحات المحدّدة وحدة ورا وحدة. فشل وحدة ما بيوقّف الباقي — وإلا صفحة بطيئة بتحرم كل اللي بعدها.
 * ما بيرمي أبدًا: النتيجة بتحكي شو انربط وشو فشل وليش.
 */
export async function connectSelected(ids: readonly string[], connectOne: (id: string) => Promise<unknown>): Promise<ConnectSelectedResult> {
  const result: ConnectSelectedResult = { linked: [], failed: [] };
  for (const id of ids) {
    try {
      await connectOne(id);
      result.linked.push(id);
    } catch (e) {
      result.failed.push({ id, message: e instanceof Error && e.message ? e.message : "فشل ربط الصفحة" });
    }
  }
  return result;
}
