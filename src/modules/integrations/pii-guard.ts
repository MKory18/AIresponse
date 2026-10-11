/**
 * P12 — حارس البيانات الشخصية لكل ما يخرج من سيستم 7 لنظام آخر أو لوكيل.
 *
 * السور الأول هو مخطط كل حدث/أداة الحرفي (لا مكان لحقل شخصي). هذا السور
 * التاني: يمسح كل نص خارج ويرفض أي شيء يشبه رقم هاتف أو إيميل، وأي مفتاح
 * باسم حقل شخصي. الرفض يمنع الإرسال كله — لا «تنظيف» صامت لنصف رسالة.
 *
 * المعرّفات الرقمية الطويلة المقصودة (رقم الإعلان مثلًا) مسموحة فقط تحت
 * مفاتيحها المسماة في ID_KEYS، وبشكلها الرقمي الصافي.
 */

const PERSONAL_KEYS = new Set([
  "name",
  "full_name",
  "fullname",
  "customer_name",
  "phone",
  "phone_number",
  "mobile",
  "email",
  "address",
  "province",
  "city",
  "text",
  "message_text",
  "body_text",
  "psid",
  "ctwa_clid",
  "wa_id",
]);

/** مفاتيح معرّفات رقمية مقصودة (ليست أرقام هواتف). */
const ID_KEYS = new Set(["ad_id", "source_id", "page_id", "waba_id", "campaign_id", "order_id", "oms_order_id"]);

// تحويل الأرقام العربية/الفارسية لأرقام لاتينية قبل الفحص.
function toLatinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// تسلسل يشبه هاتفًا: + اختيارية ثم 7–15 رقمًا بفواصل مسافة/شرطة/نقطة/أقواس.
const PHONE_RE = /(?:\+|00)?\d(?:[\s\-.()]*\d){6,14}/;

export interface PiiFinding {
  path: string;
  kind: "PERSONAL_KEY" | "PHONE" | "EMAIL";
}

/** صيغ المعرّفات المعتمة المعروفة (مولّدة عندنا أو من Prisma) — مستثناة كليًا. */
const KNOWN_OPAQUE: RegExp[] = [
  /^c[a-z0-9]{20,32}$/, // cuid (Prisma)
  /^rep_rt_[a-z0-9]{8,40}$/, // حملة إعادة تواصل
  /^hrm_[0-9a-f]{20}$/, // مرجع مسودة Hermes
  /^(cv|agt)_[a-p]{6,16}$/, // مراجع بحروف فقط
];

/**
 * مرجع معتم تحت مفتاح معرّف (…_id · …_ref · id · ref): صيغة معروفة (cuid ·
 * rep_rt_ · hrm_ …) مستثناة كليًا؛ مرجع غريب (مثل external_ref من الكليبر)
 * بيبلش بحرف ومستثنى بس إذا ما فيه 9 أرقام متتالية — «p0791234567» مش مرجع،
 * هاد رقم هاتف ورا حرف. (بدون الاستثناء ~10% من المراجع كانت بتنمنع غلط.)
 */
function isOpaqueRef(key: string, v: string): boolean {
  const idKey = key === "id" || key === "ref" || key.endsWith("_id") || key.endsWith("_ref");
  if (!idKey) return false;
  if (KNOWN_OPAQUE.some((re) => re.test(v))) return true;
  return /^[A-Za-z][A-Za-z0-9_\-]{1,79}$/.test(v) && !/\d{9,}/.test(v);
}

/** مفاتيح روابط: معرّفات cuid جوّا المسار/الاستعلام مش أرقام هواتف. */
function isUrlKey(key: string): boolean {
  return key === "url" || key === "href" || key === "link" || key.endsWith("_url");
}

function scanString(value: string, path: string, key: string, out: PiiFinding[]): void {
  const v = toLatinDigits(value);
  if (EMAIL_RE.test(v)) {
    out.push({ path, kind: "EMAIL" });
    return;
  }
  if (ID_KEYS.has(key) && /^\d{1,30}$/.test(v)) return; // معرّف رقمي صافٍ تحت مفتاحه
  if (isOpaqueRef(key, v)) return;
  if (isUrlKey(key)) {
    // رابط مراجعة/صفحة: نشيل معرّفات cuid وبعدين نفحص الباقي (wa.me/9639… بينمسك).
    const rest = v.replace(/c[a-z0-9]{20,32}/g, "/");
    const m = rest.match(PHONE_RE);
    if (m && m[0].replace(/\D/g, "").length >= 7) out.push({ path, kind: "PHONE" });
    return;
  }
  // المبالغ دائمًا بكسر عشري ("1500.00") والتواريخ ISO لا تُعد هواتف — أما
  // نص أرقام صافٍ بلا كسر (0936654998) فيُفحص كهاتف.
  if (/^-?\d{1,9}\.\d{1,4}$/.test(v)) return;
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+([+-]\d{2}:\d{2}|Z)?)?$/.test(v)) return;
  const m = v.match(PHONE_RE);
  if (m) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 7) out.push({ path, kind: "PHONE" });
  }
}

/** يمسح قيمة JSON كاملة؛ يرجّع كل مكان مشبوه (فارغ = نظيف). */
export function findPii(value: unknown, path = "$", key = "", out: PiiFinding[] = []): PiiFinding[] {
  if (value === null || value === undefined) return out;
  if (typeof value === "string") {
    scanString(value, path, key, out);
    return out;
  }
  if (typeof value === "number") {
    // العدّادات لا تصل لتسع خانات؛ رقم صحيح بهذا الطول خارج مفاتيح المعرّفات
    // يشبه هاتفًا مخزّنًا كرقم.
    if (Number.isInteger(value) && Math.abs(value) >= 1e8 && !ID_KEYS.has(key)) out.push({ path, kind: "PHONE" });
    return out;
  }
  if (typeof value === "boolean") return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => findPii(v, `${path}[${i}]`, key, out));
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (PERSONAL_KEYS.has(lower) && v !== null && v !== undefined && v !== "") {
        out.push({ path: `${path}.${k}`, kind: "PERSONAL_KEY" });
        continue;
      }
      findPii(v, `${path}.${k}`, lower, out);
    }
  }
  return out;
}

export function assertNoPii(value: unknown): void {
  const findings = findPii(value);
  if (findings.length > 0) {
    const err = new Error(`PII_BLOCKED: ${findings.map((f) => `${f.kind}@${f.path}`).join(", ")}`) as Error & {
      code?: string;
      findings?: PiiFinding[];
    };
    err.code = "PII_BLOCKED";
    err.findings = findings;
    throw err;
  }
}

/**
 * يستبدل أي رقم يشبه هاتفًا أو إيميلًا داخل نص تجاري (قالب رد مثلًا) بـ «[…]»
 * قبل خروجه لوكيل — النص يبقى مفيدًا، والرقم لا يخرج أبدًا.
 */
export function redactContacts(text: string): string {
  const latin = toLatinDigits(text);
  // نشتغل على النسخة اللاتينية لتحديد المواضع (نفس الطول — تحويل حرف بحرف).
  let out = "";
  let i = 0;
  const re = new RegExp(`${EMAIL_RE.source}|${PHONE_RE.source}`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin)) !== null) {
    const isEmail = m[0].includes("@");
    const digits = m[0].replace(/\D/g, "");
    if (!isEmail && digits.length < 7) continue;
    out += text.slice(i, m.index) + "[…]";
    i = m.index + m[0].length;
  }
  return out + text.slice(i);
}
