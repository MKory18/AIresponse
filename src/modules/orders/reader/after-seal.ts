import { childLogger } from "@/core/logger";
import { enqueueJob, type Db } from "@/modules/jobs/service";
import { getIntegrationSettings } from "@/modules/integrations/settings";
import { deliverOrderTelegram } from "@/modules/orders/telegram-delivery";

const log = childLogger("order-reader");

/**
 * كل اللي بيطلع لبرّا بيصير هون — **لحظة التثبيت بس** (الحزمة 1.6، §10.1):
 *  - تيليجرام (`deliverOrderTelegram` وإلا مهمة إعادة المحاولة المعروفة)،
 *  - الـ OMS (`maybeEnqueueAutoHandoff` — بنفس مفتاح عدم التكرار `oms-handoff:…`)،
 *  - رسالة التثبيت للعميل (`send_order_confirmation` — نص حتمي).
 * كل واحد بمعزل: فشل أي وحدة ما بيوقف التانيتين ولا بيرجّع التثبيت.
 * `handoffOrderToOms` ما بيتغيّر.
 */
export async function runAfterSeal(
  db: Db,
  order: { id: string; workspaceId: string; conversationId: string | null },
  actor: { userId: string | null }
): Promise<{ telegram: boolean; oms: boolean; confirmation: boolean }> {
  const out = { telegram: false, oms: false, confirmation: false };
  const userId = actor.userId ?? "system";

  try {
    await deliverOrderTelegram(db as never, { workspaceId: order.workspaceId, userId, orderId: order.id });
    out.telegram = true;
  } catch (err) {
    await enqueueJob(db, {
      workspaceId: order.workspaceId,
      type: "notify_order_telegram",
      payload: { orderId: order.id, userId },
      runAfter: new Date(Date.now() + 30_000),
      idempotencyKey: `tg-order:${order.workspaceId}:${order.id}`,
      maxAttempts: 8,
    }).catch(() => undefined);
    log.warn({ orderId: order.id, error: err instanceof Error ? err.message : String(err) }, "seal_telegram_failed");
  }

  try {
    const { maybeEnqueueAutoHandoff } = await import("@/modules/oms/auto-handoff");
    out.oms = await maybeEnqueueAutoHandoff(db as never, order.workspaceId, order.id);
  } catch (err) {
    log.warn({ orderId: order.id, error: err instanceof Error ? err.message : String(err) }, "seal_oms_enqueue_failed");
  }

  try {
    const settings = await getIntegrationSettings(db, order.workspaceId);
    if (settings.orderConfirmMessage && order.conversationId) {
      await enqueueJob(db, {
        workspaceId: order.workspaceId,
        type: "send_order_confirmation",
        payload: { orderId: order.id },
        idempotencyKey: `order-confirm:${order.workspaceId}:${order.id}`,
        maxAttempts: 4,
      });
      out.confirmation = true;
    }
  } catch (err) {
    log.warn({ orderId: order.id, error: err instanceof Error ? err.message : String(err) }, "seal_confirmation_enqueue_failed");
  }
  return out;
}

/**
 * فحص الحظر قبل التثبيت (§10.1): العميل محظور بالـ OMS ← ما منثبّت ولا منبعت.
 * فشل الفحص (الـ OMS واقع · الباب ما بيدعمه) ما بيوقف شي: الـ OMS نفسه بيرفض المحظور بـ 422.
 * بيشتغل بس لما الربط فعّال والإرسال التلقائي مفعّل (غير هيك ما في وين نسأل).
 */
export async function isBlacklistedAtOms(db: Db, workspaceId: string, phone: string | null): Promise<boolean> {
  if (!phone) return false;
  try {
    const { getOmsConnectionRow, buildOmsClient } = await import("@/modules/oms/connection");
    const conn = (await getOmsConnectionRow(db as never, workspaceId)) as { isActive?: boolean; autoHandoff?: boolean } | null;
    if (!conn?.isActive || !conn.autoHandoff) return false;
    const client = await buildOmsClient(db as never, workspaceId);
    const r = await client.lookupCustomer(phone);
    return r.blacklisted === true;
  } catch {
    return false;
  }
}
