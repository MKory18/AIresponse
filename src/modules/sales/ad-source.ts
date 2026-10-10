import type { Db } from "@/modules/customers/service";
import { recordAudit } from "@/modules/audit/service";

/**
 * P8 — مصدر الإعلان (لمسة أولى فقط):
 * - القاعدة: المصدر يُكتب مرة واحدة من بيانات قناة موثوقة، ولا يُستبدل
 *   ولا يُخمَّن أبدًا. الرسالة وحدها ليست دليلًا على الإعلان الذي جلب
 *   العميل — بلا بيانات إحالة صريحة يبقى المصدر null (غير معروف).
 * - حماية من إعادة إرسال Webhook: اللمسة الأولى تفوز (قيمة أصلية محفوظة).
 */

export interface AdSourceResult {
  set: boolean;
  source: string | null;
}

/** يكتب المصدر فقط إذا كان العميل بلا مصدر مسبق (first-touch wins). */
export async function recordAdSource(
  db: Db,
  input: { workspaceId: string; customerId: string; source: string | null | undefined }
): Promise<AdSourceResult> {
  const src = input.source && String(input.source).trim() ? String(input.source).trim().slice(0, 200) : null;
  const customer = await (db as unknown as {
    customer: { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> };
  }).customer.findUnique({ where: { id: input.customerId } });
  if (!customer || customer.workspaceId !== input.workspaceId) return { set: false, source: null };
  // لا استبدال أبدًا — القيمة الأصلية مقدسة (منع تغيير المصدر بإعادة الإرسال).
  if (customer.adSource) return { set: false, source: String(customer.adSource) };
  if (!src) return { set: false, source: null }; // بلا بيانات موثوقة → يبقى غير معروف
  await (db as unknown as {
    customer: { update: (a: unknown) => Promise<unknown> };
  }).customer.update({
    where: { id: input.customerId },
    data: { adSource: src, adSourceAt: new Date() } as never,
  });
  await recordAudit(db, {
    workspaceId: input.workspaceId,
    action: "sales.ad_source_captured",
    entityType: "Customer",
    entityId: input.customerId,
    metadata: { source: src },
  });
  return { set: true, source: src };
}
