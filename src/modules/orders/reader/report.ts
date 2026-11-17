/**
 * تقرير الظل (الحزمة 1.3): ملخص القراءات المحفوظة + مقارنتها مع الطلبات الفعلية
 * بنفس المحادثات — لتحديد جاهزية التفعيل (الحزمة 1.9) بالأرقام مش بالإحساس.
 * دالة صرفة: بلا قاعدة بيانات ولا شبكة.
 */
export interface ReadingLite {
  conversationId: string;
  stage: string;
  status: string;
  flags: string[];
  missing: string[];
}

export interface ShadowSummary {
  total: number;
  byStage: Record<string, number>;
  failed: number;
  /** قراءات COMPLETE (القارئ كان رح يسجّل طلب). */
  wouldCreate: number;
  /** COMPLETE وفي طلب فعلي (المسودة القديمة سجّلت). */
  agreed: number;
  /** COMPLETE وما في طلب فعلي — القارئ لقط شي فاتت عليه المسودة. */
  readerOnly: number;
  /** في طلب فعلي وقراءته مش COMPLETE — القارئ فوّت شي ⚠️ */
  legacyOnly: number;
  flags: Array<{ flag: string; count: number }>;
}

export function summarizeShadow(readings: ReadingLite[], orderConversationIds: string[]): ShadowSummary {
  const hasOrder = new Set(orderConversationIds);
  const byStage: Record<string, number> = {};
  const flagCounts = new Map<string, number>();
  let failed = 0;
  let wouldCreate = 0;
  let agreed = 0;
  let readerOnly = 0;
  let legacyOnly = 0;
  for (const r of readings) {
    byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
    if (r.status === "FAILED") failed += 1;
    const complete = r.stage === "COMPLETE";
    const ordered = hasOrder.has(r.conversationId);
    if (complete) {
      wouldCreate += 1;
      if (ordered) agreed += 1;
      else readerOnly += 1;
      for (const f of r.flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
    } else if (ordered) {
      legacyOnly += 1;
    }
  }
  const flags = [...flagCounts.entries()].map(([flag, count]) => ({ flag, count })).sort((a, b) => b.count - a.count);
  return { total: readings.length, byStage, failed, wouldCreate, agreed, readerOnly, legacyOnly, flags };
}
