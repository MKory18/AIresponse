/**
 * التنسيق الموحّد (2.1، 03-UI-STRUCTURE §6.6): دالة وحدة لكل نوع، ولا `toLocaleString()` مباشرة بالصفحات الجديدة.
 *
 * - الأرقام **لاتينية (0–9)** بكل مكان، والمبالغ مع رمز العملة دايمًا.
 * - التاريخ والوقت بتوقيت المساحة (`timezone`) مش بتوقيت المتصفح.
 * - كل الدوال صرفة وبتقبل `now` للاختبار، وما بترمي على قيمة فاضية/تالفة (بترجّع «—»).
 */

export const EMPTY = "—";

const NUM_LOCALE = "en-US";
const DATE_LOCALE = "ar-u-nu-latn-ca-gregory";

/** عملات المنظومة: الرمز بالعربي + عدد الكسور المعتمد (الدينار بـ3). */
const CURRENCIES: Record<string, { symbol: string; digits: number }> = {
  JOD: { symbol: "د.أ", digits: 3 },
  SYP: { symbol: "ل.س", digits: 0 },
  SAR: { symbol: "ر.س", digits: 2 },
  AED: { symbol: "د.إ", digits: 2 },
  KWD: { symbol: "د.ك", digits: 3 },
  IQD: { symbol: "د.ع", digits: 0 },
  EGP: { symbol: "ج.م", digits: 2 },
  USD: { symbol: "$", digits: 2 },
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** رقم بفواصل آلاف لاتينية. `maxFraction` افتراضي 2. */
export function formatNumber(value: unknown, maxFraction = 2): string {
  const n = toNumber(value);
  if (n === null) return EMPTY;
  return n.toLocaleString(NUM_LOCALE, { maximumFractionDigits: maxFraction, minimumFractionDigits: 0 });
}

/** مبلغ مع رمز العملة: `12.5 د.أ` — عملة مجهولة بيظهر رمزها كما هو (`12 XYZ`). */
export function formatMoney(amount: unknown, currency: string | null | undefined): string {
  const n = toNumber(amount);
  if (n === null) return EMPTY;
  const code = (currency ?? "").toUpperCase();
  const def = CURRENCIES[code];
  const text = formatNumber(n, def?.digits ?? 2);
  if (!code) return text;
  return def ? (code === "USD" ? `${def.symbol}${text}` : `${text} ${def.symbol}`) : `${text} ${code}`;
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

function safeFormat(d: Date, options: Intl.DateTimeFormatOptions, timeZone?: string | null): string {
  try {
    return new Intl.DateTimeFormat(DATE_LOCALE, { ...options, ...(timeZone ? { timeZone } : {}) }).format(d);
  } catch {
    // منطقة زمنية مجهولة — نرجع لتوقيت الجهاز بدل ما نكسر الصفحة.
    return new Intl.DateTimeFormat(DATE_LOCALE, options).format(d);
  }
}

/** `17 نوفمبر، 14:30` بتوقيت المساحة (24 ساعة). */
export function formatDateTime(value: unknown, timeZone?: string | null): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return safeFormat(d, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, timeZone);
}

/** `17 نوفمبر` (مع السنة إذا مو السنة الحالية). */
export function formatDate(value: unknown, timeZone?: string | null, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  const sameYear = safeFormat(d, { year: "numeric" }, timeZone) === safeFormat(now, { year: "numeric" }, timeZone);
  return safeFormat(d, sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" }, timeZone);
}

/** `14:30` بتوقيت المساحة. */
export function formatTime(value: unknown, timeZone?: string | null): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return safeFormat(d, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, timeZone);
}

/** «الآن» · «قبل 5 د» · «قبل 3 س» · «قبل 2 يوم» · وبعد شهر التاريخ. */
export function formatRelative(value: unknown, now: Date = new Date(), timeZone?: string | null): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  const diff = now.getTime() - d.getTime();
  if (diff < 0) return formatDateTime(d, timeZone);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "الآن";
  if (mins < 60) return `قبل ${mins} د`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `قبل ${hours} س`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `قبل ${days} يوم`;
  return formatDate(d, timeZone, now);
}

/** مدة المؤقّت بصيغة `MM:SS` (أو `H:MM:SS`): لعدّاد التثبيت. ما بينزل تحت صفر. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
