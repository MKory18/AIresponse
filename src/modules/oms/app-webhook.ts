import { z } from "zod";
import { childLogger } from "@/core/logger";
import { recordAudit } from "@/modules/audit/service";
import type { Db } from "@/modules/customers/service";
import { handleOmsStatusChanged, type OmsStatusResult } from "./webhook";
import { normalizeOmsOrderNumber } from "./manual";

/**
 * P12 — أحداث «التطبيقات» من الـ OMS الحقيقي (ريبو Zaki-ai-CRM:
 * src/lib/apps/events.ts). هذا هو الشكل الذي يرسله الـ OMS فعليًا اليوم:
 *
 *   POST {S7}/api/webhooks/oms/{key}
 *   X-Zaki-Event: order.shipped · X-Zaki-Delivery: <id> · X-Zaki-Timestamp: <ms>
 *   X-Zaki-Signature: sha256=<hex HMAC(secret, "<ts>.<body>")>
 *   {"event":"order.shipped","at":"…","data":{"orderId","orderNumber",
 *     "shippingStatus","previousStatus","total","currency","trackingNumber"}}
 *
 * الـ OMS يرسل أحداث كل طلبات الشركة لكل تطبيق مسجّل — طلب مش من سيستم 7
 * يُرد عليه 200 «تجاهل» (وإلا الـ OMS يعيد المحاولة 6 ساعات على طلب لا يخصنا).
 * المطابقة بمعرّف الطلب بالـ OMS أو برقمه (الربط اليدوي يحفظ الرقم فقط،
 * وأول حدث يكمّل المعرّف). الحالة تمرّ بنفس معالج P2 (ترتيب · تكرار ·
 * لا رجوع للخلف · متابعات ما بعد الشحن).
 */

const log = childLogger("oms.app-webhook");

export const OMS_APP_EVENTS = [
  "order.created",
  "order.confirmed",
  "order.shipped",
  "order.delivered",
  "order.returned",
  "order.cancelled",
] as const;
export type OmsAppEvent = (typeof OMS_APP_EVENTS)[number];

export const omsAppEnvelopeSchema = z.object({
  event: z.string().min(1).max(64),
  at: z.string().max(64).optional(),
  data: z
    .object({
      orderId: z.string().min(1).max(64).optional(),
      orderNumber: z.string().min(1).max(64).nullable().optional(),
      confirmationStatus: z.string().max(40).optional(),
      shippingStatus: z.string().max(40).optional(),
      previousStatus: z.string().max(40).nullable().optional(),
      trackingNumber: z.string().max(120).nullable().optional(),
      // المجموع والعملة كما بالـ OMS — للتحقق قبل إكمال ربط بالرقم فقط
      // (بلا قيود شكل: حدث بشكل غير متوقع ما لازم ينرفض كله وينضاع).
      total: z.unknown().optional(),
      currency: z.unknown().optional(),
    })
    .passthrough(),
});
export type OmsAppEnvelope = z.infer<typeof omsAppEnvelopeSchema>;

/** حالة المرآة المحلية لكل حدث (أسماء حالات الـ OMS نفسها). */
export function omsStatusForAppEvent(env: OmsAppEnvelope): string | null {
  switch (env.event as OmsAppEvent) {
    case "order.created":
      return "NEW";
    case "order.confirmed":
      return "CONFIRMED";
    case "order.cancelled":
      return "CANCELLED";
    case "order.shipped":
      return env.data.shippingStatus === "OUT_FOR_DELIVERY" ? "OUT_FOR_DELIVERY" : "SHIPPED";
    case "order.delivered":
      return "DELIVERED";
    case "order.returned":
      return "RETURNED";
    default:
      return null;
  }
}

export interface OmsAppConnection {
  id: string;
  workspaceId: string;
}

export type OmsAppResult =
  | { outcome: "ignored"; reason: "UNSUPPORTED_EVENT" | "UNKNOWN_ORDER" | "NO_ORDER_REF" | "LINK_MISMATCH" }
  | ({ outcome: "applied" } & OmsStatusResult);

type OrderRow = {
  id: string;
  workspaceId: string;
  omsOrderId: string | null;
  omsOrderNumber: string | null;
  total?: unknown;
  currency?: string | null;
  createdAt?: Date | string | null;
};

/** فرق مقبول بين مجموعنا ومجموع الـ OMS (التوصيل ممكن ينحسب عنده غير). */
const TOTAL_TOLERANCE_RATIO = 0.3;
const TOTAL_TOLERANCE_MIN = 5;

/**
 * ربط بالرقم بس (موظف كتب الرقم): قبل ما يكمل، الحدث لازم «يشبه» طلبنا —
 * نفس العملة · مجموع قريب · وما صار قبل ما ينعمل طلبنا. رقم غلط (0184 بدل
 * 0148) لطلب زبون تاني ما بيسوق حالة طلبنا. null = مطابق.
 */
export function manualLinkMismatch(order: OrderRow, env: OmsAppEnvelope): "CURRENCY" | "TOTAL" | "BEFORE_ORDER" | null {
  const evCurrency = typeof env.data.currency === "string" ? env.data.currency.trim().toUpperCase() : "";
  const localCurrency = String(order.currency ?? "").trim().toUpperCase();
  if (evCurrency && localCurrency && evCurrency !== localCurrency) return "CURRENCY";
  const evTotal = env.data.total === null || env.data.total === undefined ? NaN : Number(env.data.total);
  const localTotal = Number(order.total);
  if (Number.isFinite(evTotal) && evTotal > 0 && Number.isFinite(localTotal) && localTotal > 0) {
    const tolerance = Math.max(TOTAL_TOLERANCE_MIN, localTotal * TOTAL_TOLERANCE_RATIO);
    if (Math.abs(evTotal - localTotal) > tolerance) return "TOTAL";
  }
  const at = env.at ? new Date(env.at).getTime() : NaN;
  const created = order.createdAt ? new Date(order.createdAt).getTime() : NaN;
  if (Number.isFinite(at) && Number.isFinite(created) && at < created - 10 * 60_000) return "BEFORE_ORDER";
  return null;
}

export async function handleOmsAppWebhook(
  db: Db,
  input: { connection: OmsAppConnection; envelope: OmsAppEnvelope; deliveryId: string | null }
): Promise<OmsAppResult> {
  const { connection, envelope } = input;
  const status = omsStatusForAppEvent(envelope);
  if (!status) return { outcome: "ignored", reason: "UNSUPPORTED_EVENT" };
  const omsId = envelope.data.orderId?.trim() || null;
  const omsNumber = envelope.data.orderNumber ? normalizeOmsOrderNumber(envelope.data.orderNumber) || null : null;
  if (!omsId && !omsNumber) return { outcome: "ignored", reason: "NO_ORDER_REF" };

  // المطابقة داخل مساحة الاتصال فقط (المساحة من مفتاح المسار، لا من الطلب).
  // المعرّف أولًا (ربط مؤكد من الـ OMS)، وبعدين الرقم (ربط يدوي): ربط يدوي
  // غلط على نفس الرقم ما بيخطف حدث الطلب الصحيح.
  const select = { id: true, workspaceId: true, omsOrderId: true, omsOrderNumber: true, total: true, currency: true, createdAt: true };
  let order = omsId
    ? ((await db.order.findFirst({ where: { workspaceId: connection.workspaceId, omsOrderId: omsId }, select } as never)) as OrderRow | null)
    : null;
  if (!order && omsNumber) {
    order = (await db.order.findFirst({
      where: {
        workspaceId: connection.workspaceId,
        omsOrderNumber: omsNumber,
        // طلب مربوط بمعرّف OMS تاني مش هو — الرقم صدفة/غلط.
        ...(omsId ? { OR: [{ omsOrderId: null }, { omsOrderId: omsId }] } : {}),
      },
      select,
    } as never)) as OrderRow | null;
  }
  if (!order) return { outcome: "ignored", reason: "UNKNOWN_ORDER" };

  // طلب تاني مربوط يدويًا بنفس الرقم وبلا معرّف = ربط يدوي غلط على الأغلب:
  // ما منغيّره بصمت، بس منعلّمه بالسجل حتى الفريق يصلّحه.
  if (omsId && omsNumber && order.omsOrderId === omsId) {
    const suspects = (await db.order.findMany({
      where: { workspaceId: connection.workspaceId, omsOrderNumber: omsNumber, omsOrderId: null, NOT: { id: order.id } },
      select: { id: true },
      take: 5,
    } as never)) as Array<{ id: string }>;
    for (const sus of suspects) {
      await recordAudit(db, {
        workspaceId: connection.workspaceId,
        action: "oms.manual_link_suspect",
        entityType: "Order",
        entityId: sus.id,
        metadata: { omsOrderNumber: omsNumber },
      });
    }
  }

  // ربط بالرقم بس: الحدث لازم يطابق طلبنا قبل ما يكمّل المعرّف أو يغيّر حالته.
  if (!order.omsOrderId) {
    const mismatch = manualLinkMismatch(order, envelope);
    if (mismatch) {
      log.warn({ orderId: order.id, mismatch }, "oms.app_webhook.manual_link_mismatch");
      const seen = await (db as unknown as { auditLog?: { findFirst: (a: unknown) => Promise<unknown> } }).auditLog
        ?.findFirst({ where: { workspaceId: order.workspaceId, entityId: order.id, action: "oms.manual_link_mismatch" }, orderBy: { createdAt: "desc" } })
        .catch(() => null);
      const prev = (seen as { metadata?: { omsOrderNumber?: string } } | null)?.metadata?.omsOrderNumber;
      if (prev !== order.omsOrderNumber) {
        const evTotal = Number(envelope.data.total);
        await recordAudit(db, {
          workspaceId: order.workspaceId,
          action: "oms.manual_link_mismatch",
          entityType: "Order",
          entityId: order.id,
          metadata: {
            omsOrderNumber: order.omsOrderNumber,
            reason: mismatch,
            omsTotal: Number.isFinite(evTotal) ? evTotal : null,
            omsCurrency: typeof envelope.data.currency === "string" ? envelope.data.currency.slice(0, 8) : null,
          },
        });
      }
      return { outcome: "ignored", reason: "LINK_MISMATCH" };
    }
  }

  // إكمال الربط: الربط اليدوي يعرف الرقم فقط — أول حدث يكمّل المعرّف (والعكس).
  const link: Record<string, unknown> = {};
  if (omsId && !order.omsOrderId) link.omsOrderId = omsId;
  if (omsNumber && !order.omsOrderNumber) link.omsOrderNumber = omsNumber;
  if (Object.keys(link).length > 0) {
    try {
      await db.order.update({ where: { id: order.id }, data: link as never });
      if (link.omsOrderId) order.omsOrderId = String(link.omsOrderId);
      await recordAudit(db, {
        workspaceId: order.workspaceId,
        action: "oms.order_link_completed",
        entityType: "Order",
        entityId: order.id,
        metadata: { omsOrderId: order.omsOrderId, omsOrderNumber: omsNumber },
      });
    } catch (err) {
      // معرّف الـ OMS مربوط بطلب آخر (ربط يدوي خاطئ) — لا نسرق الربط بصمت.
      if ((err as { code?: string })?.code === "P2002") {
        log.warn({ orderId: order.id }, "oms.app_webhook.link_conflict");
        await recordAudit(db, {
          workspaceId: order.workspaceId,
          action: "oms.order_link_conflict",
          entityType: "Order",
          entityId: order.id,
          metadata: { omsOrderNumber: omsNumber },
        });
        return { outcome: "ignored", reason: "UNKNOWN_ORDER" };
      }
      throw err;
    }
  }
  if (!order.omsOrderId) return { outcome: "ignored", reason: "UNKNOWN_ORDER" };

  const result = await handleOmsStatusChanged(db, {
    event: "order-status-changed",
    workspaceId: order.workspaceId,
    omsOrderId: order.omsOrderId,
    status,
    note: envelope.data.trackingNumber ? `tracking:${String(envelope.data.trackingNumber).slice(0, 60)}` : null,
    // مفتاح عدم التكرار من الجسم الموقّع (الحدث · الطلب · وقته) — مش من رأس
    // X-Zaki-Delivery (غير موقّع): طلب ملتقط بيتعاد بمعرّف تسليم جديد خلال
    // 5 دقايق = نفس المفتاح = تكرار. بلا «at» بس منرجع لمعرّف التسليم.
    eventId: envelope.at
      ? `app:${envelope.event}:${order.omsOrderId}:${envelope.at}`
      : input.deliveryId
        ? `app:${input.deliveryId}`
        : `app:${envelope.event}:${order.omsOrderId}:`,
    occurredAt: envelope.at ?? null,
  });
  return { outcome: "applied", ...result };
}
