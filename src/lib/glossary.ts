/**
 * القاموس الموحّد (2.1، 03-UI-STRUCTURE §4): اسم واحد لكل شي بالواجهة الجديدة.
 *
 * - `TERMS`: التسميات الرسمية — الصفحات الجديدة بتستوردها بدل ما تكتب النص بإيدها.
 * - `FORBIDDEN`: الكلمات الممنوعة بنصوص الواجهة الجديدة + بدائلها. `tests/glossary.test.ts` بيفحص ملفات الواجهة
 *   الجديدة (مجلدات `v2` ومكوّنات العدّة الجديدة)؛ الواجهة القديمة بتتنظّف بحزمة 3.8.
 * - قاعدة اللهجة: التسميات والأزرار والحالات وعناوين الأعمدة = فصحى مبسّطة قصيرة. الشرح والتلميحات = محكية خفيفة.
 */

export const TERMS = {
  customer: "العميل",
  agent: "الوكيل",
  agentSection: "الوكيل الذكي",
  ownServer: "سيرفرك الخاص",
  needsYou: "يحتاجك",
  takeOver: "استلم المحادثة",
  handBack: "رجّعها للوكيل",
  endConversation: "أنهِ المحادثة",
  conversationOpen: "مفتوحة",
  conversationEnded: "منتهية",
  orderCard: "بطاقة الطلب",
  orderCollecting: "قيد التجميع",
  productGroup: "مجموعة منتجات",
  page: "الصفحة",
  channel: "القناة",
  info: "المعلومات",
  save: "حفظ",
  add: "أضف",
  delete: "حذف",
  remove: "إزالة",
  undo: "تراجع",
  on: "شغّال",
  off: "متوقف",
} as const;

export interface ForbiddenTerm {
  /** الكلمة الممنوعة (نمط regex بحدود كلمة عربية). */
  pattern: RegExp;
  word: string;
  use: string;
}

/** حد كلمة عربي: قبلها/بعدها مش حرف عربي (التشكيل والتطويل جزء من الكلمة). */
const word = (w: string) => new RegExp(`(?<![\\u0621-\\u064A])${w}(?![\\u0621-\\u064A])`);

export const FORBIDDEN: ForbiddenTerm[] = [
  { pattern: word("الزبون"), word: "الزبون", use: TERMS.customer },
  { pattern: word("زبون"), word: "زبون", use: "عميل" },
  { pattern: word("مسودة"), word: "مسودة", use: TERMS.orderCard },
  { pattern: word("التحويلات"), word: "التحويلات", use: TERMS.needsYou },
  { pattern: word("كتالوج"), word: "كتالوج", use: TERMS.productGroup },
  { pattern: word("الكتالوجات"), word: "الكتالوجات", use: TERMS.productGroup },
  { pattern: word("قاعدة المعرفة"), word: "قاعدة المعرفة", use: TERMS.info },
  { pattern: word("تحتاج تدخلًا بشريًا"), word: "تحتاج تدخلًا بشريًا", use: TERMS.needsYou },
  { pattern: word("بانتظار موظف"), word: "بانتظار موظف", use: TERMS.needsYou },
  { pattern: word("الذكاء الاصطناعي"), word: "الذكاء الاصطناعي", use: TERMS.agent },
  { pattern: /\bHermes\b/i, word: "Hermes", use: "تسمية عامة (قرار المالك)" },
];

/** الكلمات الممنوعة الموجودة بنص (للاختبار ولأي فحص وقت التشغيل). */
export function findForbiddenTerms(text: string): ForbiddenTerm[] {
  return FORBIDDEN.filter((f) => f.pattern.test(text));
}
