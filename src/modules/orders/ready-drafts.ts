import type { Db } from "@/modules/customers/service";

/**
 * أي المسودات الجاهزة انرحّلت فعلًا لمجموعة تلجرام؟
 *
 * المصدر هو سجل التدقيق `order.ready_notified_telegram` اللي بيكتبه عامل
 * الإشعار **بعد** نجاح الإرسال (وما بيكتبه عند الفشل أو الإعدادات المطفية).
 * فالشعار بالواجهة حقيقة إرسال، مش مجرد «الإعدادات مفعّلة».
 */
export async function telegramNotifiedDraftIds(
  db: Db,
  workspaceId: string,
  draftIds: string[]
): Promise<Set<string>> {
  if (draftIds.length === 0) return new Set();
  try {
    const rows = (await db.auditLog.findMany({
      where: {
        workspaceId,
        action: "order.ready_notified_telegram",
        entityType: "OrderDraft",
        entityId: { in: draftIds },
      },
      select: { entityId: true },
      distinct: ["entityId"],
    })) as Array<{ entityId: string | null }>;
    return new Set(rows.map((r) => r.entityId).filter((id): id is string => Boolean(id)));
  } catch {
    // التدقيق غير متاح = لا ندّعي إرسالًا.
    return new Set();
  }
}
