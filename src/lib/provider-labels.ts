/**
 * أسماء عرض مزوّدي الذكاء وتفاصيل فحص الاتصال — مصدر واحد للصفحتين.
 */
export const PROVIDER_AR: Record<string, string> = {
  mock: "وهمي (تجريبي)",
  openrouter: "OpenRouter",
  internal: "داخلي",
  custom: "مزوّد مخصص (أي API)",
};

export function providerLabel(id: string | null | undefined): string {
  if (!id) return "—";
  return PROVIDER_AR[id] ?? id;
}

/** تفصيل فحص الاتصال كما بيرجع من الخادم ← نص آمن للعرض. */
export function publicDetail(detail: string): string {
  return detail;
}
