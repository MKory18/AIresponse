import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";

/**
 * P12 — إشارات التسليم من واتساب (statuses[]): sent · delivered · read · failed.
 *
 * كانت تنرمى (قبول الإرسال ≠ تسليم)، فنتائج حملات الكليبر (delivered/read)
 * وتحليلات الحملات بتضل صفر. هلأ بتحدّث Message.deliveryStatus برقم الرسالة
 * (wamid) داخل مساحة القناة — للأمام بس (مقروء ما بيرجع «واصل»)، و«فشل» ما
 * بيغطي على رسالة وصلت. ولا نص ولا رقم زبون بيتخزن من الإشارة.
 */

const log = childLogger("whatsapp.statuses");

export interface WhatsAppStatusSignal {
  wamid: string;
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  at: Date;
  errorCode: string | null;
}

const MAP: Record<string, WhatsAppStatusSignal["status"]> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };
const RANK: Record<string, number> = { PENDING: 0, QUEUED: 1, SENT: 2, DELIVERED: 3, READ: 4 };

/** إشارات رقم واتساب واحد من حمولة الـ webhook (نقية — بلا قاعدة بيانات). */
export function extractWhatsAppStatuses(payload: unknown, phoneNumberId: string): WhatsAppStatusSignal[] {
  const out: WhatsAppStatusSignal[] = [];
  const entries = (payload as { entry?: Array<{ changes?: Array<{ field?: string; value?: Record<string, unknown> }> }> }).entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = (change.value ?? {}) as {
        metadata?: { phone_number_id?: string };
        statuses?: Array<{ id?: string; status?: string; timestamp?: string; errors?: Array<{ code?: number | string }> }>;
      };
      if (value.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const s of value.statuses ?? []) {
        const mapped = s.status ? MAP[s.status] : undefined;
        if (!s.id || !mapped || s.id.length > 200) continue;
        const ts = Number(s.timestamp);
        out.push({
          wamid: s.id,
          status: mapped,
          at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
          errorCode: mapped === "FAILED" && s.errors?.[0]?.code !== undefined ? String(s.errors[0].code).slice(0, 20) : null,
        });
      }
    }
  }
  return out;
}

/** يطبّق الإشارات على رسائل المساحة. يرجّع عدد الرسائل الي تحدّثت. لا يرمي. */
export async function applyWhatsAppStatuses(db: Db, workspaceId: string, signals: WhatsAppStatusSignal[]): Promise<number> {
  let updated = 0;
  for (const sig of signals) {
    try {
      const msg = (await db.message.findFirst({
        where: { workspaceId, externalMessageId: sig.wamid },
        select: { id: true, deliveryStatus: true },
      })) as { id: string; deliveryStatus: string } | null;
      if (!msg) continue;
      const current = msg.deliveryStatus;
      if (sig.status === "FAILED") {
        // فشل بعد ما وصلت/انقرت = إشارة متأخرة — ما منغيّر الحقيقة.
        if ((RANK[current] ?? 0) >= RANK.DELIVERED || current === "FAILED") continue;
        await db.message.update({
          where: { id: msg.id },
          data: { deliveryStatus: "FAILED", deliveryError: sig.errorCode ? `WA_${sig.errorCode}` : "WA_FAILED" } as never,
        });
        updated += 1;
        continue;
      }
      if (current === "FAILED" && sig.status === "SENT") continue;
      if ((RANK[sig.status] ?? 0) <= (RANK[current] ?? 0) && current !== "FAILED") continue;
      await db.message.update({ where: { id: msg.id }, data: { deliveryStatus: sig.status } as never });
      updated += 1;
    } catch (err) {
      log.warn({ err, workspaceId }, "whatsapp_status_apply_failed");
    }
  }
  return updated;
}
