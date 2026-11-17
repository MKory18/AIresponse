/**
 * بناء النص المرقّم للقارئ (02-ORDER-FLOW §7.2) — نقي، بلا قاعدة بيانات.
 *
 * - بيدخل: رسائل العميل + ردود الوكيل + ردود الموظف. بتنشال: الملاحظات
 *   الداخلية (`isNote`) · المحذوفة · رسائل النظام.
 * - الترميز `m1…mN` محليًا مع خريطة لمعرّفات الرسائل الحقيقية — الموديل ما
 *   بيشوف cuid.
 * - الحد: 80 رسالة و12,000 حرف (الأحدث بيضل، القص من الأقدم) · كل رسالة ≤ 600.
 * - الوسائط: `[صورة]` · `[صوت]` … بلا محتوى.
 */
export type ReaderRole = "CUSTOMER" | "AGENT" | "HUMAN";

export interface RawTranscriptMessage {
  id: string;
  senderType: "CUSTOMER" | "AI" | "HUMAN" | "SYSTEM";
  type?: string | null;
  text?: string | null;
  createdAt: Date | string;
  isNote?: boolean | null;
  deletedAt?: Date | string | null;
}

export interface ReaderMessage {
  /** المعرّف المحلي: m1…mN */
  localId: string;
  /** المعرّف الحقيقي بالقاعدة */
  id: string;
  role: ReaderRole;
  text: string;
  at: Date;
}

export interface Transcript {
  messages: ReaderMessage[];
  /** سطور `<m …>` جاهزة للبرومبت. */
  lines: string[];
  /** محلي ← حقيقي. */
  idMap: Record<string, string>;
  /** صحيح لما انقصّ من الأقدم. */
  truncated: boolean;
}

export interface TranscriptOptions {
  maxMessages?: number;
  maxChars?: number;
  perMessageChars?: number;
  /** افتراضي UTC. */
  timeZone?: string;
}

const MEDIA_LABEL: Record<string, string> = {
  IMAGE: "[صورة]",
  VIDEO: "[فيديو]",
  AUDIO: "[صوت]",
  DOCUMENT: "[ملف]",
  LOCATION: "[موقع]",
  STICKER: "[ملصق]",
};

const ROLE_LABEL: Record<ReaderRole, string> = { CUSTOMER: "العميل", AGENT: "الوكيل", HUMAN: "الموظف" };

function roleOf(m: RawTranscriptMessage): ReaderRole | null {
  if (m.senderType === "CUSTOMER") return "CUSTOMER";
  if (m.senderType === "AI") return "AGENT";
  if (m.senderType === "HUMAN") return "HUMAN";
  return null; // SYSTEM
}

/** النص داخل <m> بيانات — بنعطّل أي قوسين زاوية حتى ما يقدر يسكّر الوسم أو يفتح وسم جديد. */
function escapeData(s: string): string {
  return s.replace(/</g, "‹").replace(/>/g, "›");
}

export function formatClock(at: Date, timeZone = "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).formatToParts(at);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}

export function buildTranscript(raw: RawTranscriptMessage[], opts: TranscriptOptions = {}): Transcript {
  const maxMessages = opts.maxMessages ?? 80;
  const maxChars = opts.maxChars ?? 12_000;
  const perMessage = opts.perMessageChars ?? 600;

  const usable: { id: string; role: ReaderRole; text: string; at: Date }[] = [];
  for (const m of raw) {
    if (m.isNote || m.deletedAt) continue;
    const role = roleOf(m);
    if (!role) continue;
    const media = m.type ? MEDIA_LABEL[m.type] : undefined;
    const body = (m.text ?? "").replace(/\s+/g, " ").trim();
    let text = [media, body].filter(Boolean).join(" ").trim();
    if (!text) continue;
    if (text.length > perMessage) text = text.slice(0, perMessage);
    usable.push({ id: m.id, role, text, at: m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt) });
  }
  usable.sort((a, b) => a.at.getTime() - b.at.getTime());

  // القص من الأقدم: ناخد من الأحدث لورا لحد ما نوصل أي حد.
  const kept: typeof usable = [];
  let chars = 0;
  for (let i = usable.length - 1; i >= 0; i--) {
    if (kept.length >= maxMessages) break;
    const cost = usable[i].text.length;
    if (kept.length > 0 && chars + cost > maxChars) break;
    kept.push(usable[i]);
    chars += cost;
  }
  kept.reverse();
  const truncated = kept.length < usable.length;

  const messages: ReaderMessage[] = kept.map((m, i) => ({ localId: `m${i + 1}`, id: m.id, role: m.role, text: m.text, at: m.at }));
  const idMap: Record<string, string> = {};
  for (const m of messages) idMap[m.localId] = m.id;
  const lines = messages.map(
    (m) => `<m id="${m.localId}" from="${ROLE_LABEL[m.role]}" at="${formatClock(m.at, opts.timeZone)}">${escapeData(m.text)}</m>`
  );
  return { messages, lines, idMap, truncated };
}
