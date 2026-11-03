import type { Db } from "@/modules/customers/service";

/**
 * أي الطلبات انرحّلت فعلًا لمجموعة تلجرام؟
 *
 * المصدر سجل التدقيق `order.telegram_notified` اللي بينكتب **بعد** نجاح
 * الإرسال عند إنشاء الطلب. فالشعار بالقائمة حقيقة إرسال، مش «الإعدادات مفعّلة».
 * (المسودات ما بتترحّل — القرار للمالك.)
 */
export async function telegramNotifiedOrderIds(
  db: Db,
  workspaceId: string,
  orderIds: string[]
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  try {
    const rows = (await db.auditLog.findMany({
      where: {
        workspaceId,
        action: "order.telegram_notified",
        entityType: "Order",
        entityId: { in: orderIds },
      },
      select: { entityId: true },
      distinct: ["entityId"],
    })) as Array<{ entityId: string | null }>;
    return new Set(rows.map((r) => r.entityId).filter((id): id is string => Boolean(id)));
  } catch {
    // التدقيق غير متاح = ما مندّعي إرسالًا.
    return new Set();
  }
}
