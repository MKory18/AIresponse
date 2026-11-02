/**
 * أسماء عرض مزوّدي الذكاء وتفاصيل فحص الاتصال — مصدر واحد للصفحتين (الاستوديو · الإعدادات).
 *
 * ⚠️ قبل: خريطة الاستوديو كانت ناقصة (بلا hermes/custom) وبترجع لقيمة الـid الخام، وتفصيل
 * الفحص كان بينعرض خام (`HERMES_BASE_URL_OR_API_KEY_MISSING`) — فكلمة «Hermes» كانت بتظهر
 * بالموقع (قرار المالك: ولا «Hermes» بأي نص مرئي).
 * 🔧 هلأ خريطة وحدة، وأي نص بيوصل للمستخدم وفيه hermes (مهما كان شكله) بيطلع باسم «الوكيل الذكي».
 * القيم الداخلية (`hermes` · `HERMES_*`) ما بتتغيّر — بس العرض.
 */
export const AGENT_LABEL = "الوكيل الذكي";

export const PROVIDER_AR: Record<string, string> = {
  mock: "وهمي (تجريبي)",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  internal: "داخلي",
  hermes: `${AGENT_LABEL} (سيرفرك)`,
  custom: "مزوّد مخصص (أي API)",
};

/** أي نص مرئي بيمرّ من هون: كلمة hermes بتتبدّل بالاسم العام. */
export function publicText(text: string): string {
  return text.replace(/hermes/gi, AGENT_LABEL);
}

export function providerLabel(id: string | null | undefined): string {
  if (!id) return "—";
  if (/hermes/i.test(id)) return PROVIDER_AR.hermes!;
  return PROVIDER_AR[id] ?? id;
}

const DETAIL_AR: Record<string, string> = {
  HERMES_BASE_URL_OR_API_KEY_MISSING: `ناقص عنوان ${AGENT_LABEL} أو مفتاحه`,
};

/** تفصيل فحص الاتصال كما بيرجع من الخادم ← نص آمن للعرض. */
export function publicDetail(detail: string): string {
  return DETAIL_AR[detail] ?? publicText(detail);
}
