import { createHash } from "node:crypto";
import { toWesternDigits } from "@/modules/orders/primitives";

/**
 * تصدير محادثة كمحادثة مرجعية للاختبارات (الحزمة 0.4) — **بتبدّل قبل ما يطلع أي شي**:
 *  - كل رقم هاتف برقم وهمي بنفس الطول والصيغة (نفس البادئة اللي بتضل صالحة للسوق)،
 *  - كل اسم علم (اسم العميل · أسماء الموظفين · أسماء ممرّرة) باسم وهمي ثابت،
 *  - بتفشل (`assertAnonymized`) إذا باقي أي رقم أو اسم أصلي بالمخرجات.
 * التبديل ثابت (نفس المدخل ← نفس الوهمي) فالمحادثة بتضل مفهومة: الرقم اللي انذكر مرتين بيضل نفسه.
 */
export interface FixtureMessage {
  id: string;
  senderType: "CUSTOMER" | "AI" | "HUMAN" | "SYSTEM";
  type: string;
  text: string | null;
  createdAt: string;
}

const FAKE_NAMES = ["سامر", "ليلى", "محمود", "هدى", "كريم", "رنا", "عمر", "دانا", "طارق", "سلمى"];
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

function digest(s: string): number[] {
  return [...createHash("sha256").update(s).digest()].map((b) => b % 10);
}

/** رقم وهمي بنفس الطول: بنحافظ على بادئة السوق (أول 2 للسوري · 3 للأردني) والباقي من هاش ثابت. */
export function fakePhone(original: string): string {
  const w = toWesternDigits(original).replace(/\D/g, "");
  const keep = w.startsWith("07") ? 3 : w.startsWith("09") ? 2 : Math.min(3, w.length);
  const d = digest(w);
  let out = w.slice(0, keep);
  for (let i = keep; i < w.length; i++) out += String((d[i % d.length] + i) % 10);
  // لو طلع نفس الأصلي (احتمال ضعيف) بنقلب آخر خانة.
  if (out === w) out = out.slice(0, -1) + String((Number(out.slice(-1)) + 1) % 10);
  return out;
}

/** مرشّحو الأرقام: 7+ خانات بأي أرقام (هندية/فارسية/غربية) مع فراغات أو شرطات بين مجموعات. */
const PHONE_RE = /[0-9٠-٩۰-۹](?:[\s\-.]?[0-9٠-٩۰-۹]){6,14}/g;

export function anonymizeText(text: string, names: Array<[string, string]>, phones: Map<string, string>): string {
  let out = text.replace(PHONE_RE, (m) => {
    const w = toWesternDigits(m).replace(/\D/g, "");
    if (w.length < 7) return m;
    if (!phones.has(w)) phones.set(w, fakePhone(w));
    const fake = phones.get(w)!;
    // نحافظ على أسلوب الكتابة: أرقام هندية إذا الأصل هندي.
    const style = /[٠-٩]/.test(m) ? AR_DIGITS : /[۰-۹]/.test(m) ? FA_DIGITS : null;
    return style ? [...fake].map((c) => style[Number(c)]).join("") : fake;
  });
  for (const [real, fake] of names) {
    if (!real.trim()) continue;
    out = out.split(real).join(fake);
  }
  return out;
}

export interface AnonymizeResult {
  messages: FixtureMessage[];
  phones: Array<{ real: string; fake: string }>;
  names: Array<{ real: string; fake: string }>;
}

export function anonymizeConversation(messages: FixtureMessage[], realNames: string[] = []): AnonymizeResult {
  const unique = [...new Set(realNames.map((n) => n.trim()).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length);
  const nameMap: Array<[string, string]> = unique.map((n, i) => [n, FAKE_NAMES[(digest(n)[0] + i) % FAKE_NAMES.length]]);
  const phones = new Map<string, string>();
  const out = messages.map((m) => ({ ...m, text: m.text == null ? null : anonymizeText(m.text, nameMap, phones) }));
  return {
    messages: out,
    phones: [...phones.entries()].map(([real, fake]) => ({ real, fake })),
    names: nameMap.map(([real, fake]) => ({ real, fake })),
  };
}

/** يفشل (يرمي) إذا باقي أي رقم أو اسم أصلي بالنص المخرَج. بيستدعيه السكربت قبل ما يكتب ملف. */
export function assertAnonymized(serialized: string, realPhones: string[], realNames: string[]): void {
  const western = toWesternDigits(serialized).replace(/[\s\-.]/g, "");
  for (const p of realPhones) {
    if (p.length >= 7 && western.includes(p)) throw new Error("FIXTURE_LEAK: رقم هاتف أصلي باقي بالمخرجات");
  }
  for (const n of realNames) {
    if (n.trim().length >= 2 && serialized.includes(n.trim())) throw new Error("FIXTURE_LEAK: اسم أصلي باقي بالمخرجات");
  }
}
