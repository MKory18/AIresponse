/**
 * كنس الطلبات اللي ما وصلت لمحلها.
 *
 * الطلب المؤكد بينبعت للـ OMS ولمجموعة تيليغرام لحظة ما ينعمل. بس إذا
 * الربط ما كان معمول وقتها (الـ OMS لسا ما انربط · بوت تيليغرام مش مضبوط)،
 * الطلب كان بيضل بلا ترحيل للأبد — ولا شي بيرجع ياخده بعدين.
 *
 * هون منمرّ كل ساعة على طلبات آخر ٣ أيام: اللي ما إله مهمة ترحيل أصلًا
 * بنعملّه وحدة. الطلب اللي إله مهمة (نجحت أو فشلت) ما منلمسه — المهام
 * وكنس الـ OMS بيتكفّلوا فيه.
 */
import { childLogger } from "@/core/logger";
import { enqueueJob } from "@/modules/jobs/service";
import type { Db } from "@/modules/customers/service";

const log = childLogger("orders.delivery-sweep");

/** نفس نافذة كنس الـ OMS: ٣ أيام. الأقدم بينبعت بالإيد من صفحة الطلب. */
export const ORDER_DELIVERY_SWEEP_HOURS = 72;
/** سقف لكل دورة حتى ما تتخم دفعة وحدة الطابور. */
export const ORDER_DELIVERY_SWEEP_LIMIT = 50;

const CONFIRMED = ["CONFIRMED_BY_CUSTOMER", "CONFIRMED_BY_AGENT"];
const DEAD = ["CANCELLED", "FAILED"];

type OrderRow = {
  id: string;
  workspaceId: string;
  status: string;
  confirmationStatus: string;
  omsOrderId: string | null;
};

/** معرّفات الطلبات اللي إلها مهمة من هالنوع (نجحت أو فشلت أو لسا بالطابور). */
async function orderIdsWithJob(db: Db, workspaceId: string, type: string): Promise<Set<string>> {
  const jobs = (await db.backgroundJob.findMany({
    where: { workspaceId, type } as never,
    select: { payload: true },
    take: 2000,
  })) as Array<{ payload: unknown }>;
  const out = new Set<string>();
  for (const j of jobs) {
    const id = (j.payload as { orderId?: unknown } | null)?.orderId;
    if (typeof id === "string" && id) out.add(id);
  }
  return out;
}

async function confirmedOrdersSince(db: Db, cutoff: Date): Promise<OrderRow[]> {
  return (await db.order.findMany({
    where: {
      createdAt: { gte: cutoff },
      confirmationStatus: { in: CONFIRMED },
      status: { notIn: DEAD },
    } as never,
    select: { id: true, workspaceId: true, status: true, confirmationStatus: true, omsOrderId: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  })) as unknown as OrderRow[];
}

function groupByWorkspace(orders: OrderRow[]): Map<string, OrderRow[]> {
  const out = new Map<string, OrderRow[]>();
  for (const o of orders) {
    const list = out.get(o.workspaceId);
    if (list) list.push(o);
    else out.set(o.workspaceId, [o]);
  }
  return out;
}

/**
 * طلب مؤكد ما نزل بالـ OMS ولا إله مهمة: منعملّه مهمة.
 * بس للمساحات اللي الـ OMS عندها مربوط والإرسال التلقائي مشغّل.
 */
export async function sweepOrdersMissingOms(db: Db, now = new Date()): Promise<number> {
  const conns = ((await (db as unknown as {
    omsConnection?: { findMany: (a: unknown) => Promise<unknown> };
  }).omsConnection?.findMany({
    where: { isActive: true, autoHandoff: true },
    select: { workspaceId: true },
  })) ?? []) as Array<{ workspaceId: string }>;
  if (conns.length === 0) return 0;
  const live = new Set(conns.map((c) => c.workspaceId));

  const cutoff = new Date(now.getTime() - ORDER_DELIVERY_SWEEP_HOURS * 3600_000);
  const byWorkspace = groupByWorkspace((await confirmedOrdersSince(db, cutoff)).filter((o) => live.has(o.workspaceId)));

  const { autoHandoffKey, OMS_HANDOFF_MAX_ATTEMPTS } = await import("@/modules/oms/auto-handoff");
  let queued = 0;
  for (const [workspaceId, orders] of byWorkspace) {
    const known = await orderIdsWithJob(db, workspaceId, "handoff_order_to_oms");
    for (const order of orders) {
      if (order.omsOrderId || known.has(order.id)) continue;
      const res = await enqueueJob(db, {
        workspaceId,
        type: "handoff_order_to_oms",
        payload: { orderId: order.id },
        idempotencyKey: autoHandoffKey(workspaceId, order.id),
        maxAttempts: OMS_HANDOFF_MAX_ATTEMPTS,
      }).catch(() => null);
      if (res && !res.deduplicated) queued += 1;
      if (queued >= ORDER_DELIVERY_SWEEP_LIMIT) break;
    }
    if (queued >= ORDER_DELIVERY_SWEEP_LIMIT) break;
  }
  if (queued > 0) log.info({ queued }, "oms_missing_orders_queued");
  return queued;
}

/** هل تيليغرام مضبوط لهالمساحة؟ (إعدادات المساحة، وبعدها متغيّرات البيئة) */
async function telegramReady(db: Db, workspaceId: string): Promise<boolean> {
  const settings = (await (db as unknown as {
    telegramOrderSettings?: { findUnique: (a: unknown) => Promise<unknown> };
  }).telegramOrderSettings?.findUnique?.({
    where: { workspaceId },
    select: { enabled: true, botTokenEnc: true, chatId: true },
  })) as { enabled?: boolean; botTokenEnc?: string | null; chatId?: string | null } | null | undefined;
  if (settings?.enabled && settings.botTokenEnc && settings.chatId) return true;
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ORDER_CHAT_ID);
}

/** معرّفات الطلبات اللي فعلًا انرحّلت لتيليغرام (سجل التدقيق هو الدليل). */
async function telegramDone(db: Db, workspaceId: string, orderIds: string[]): Promise<Set<string>> {
  const { telegramNotifiedOrderIds } = await import("./telegram-status");
  return telegramNotifiedOrderIds(db, workspaceId, orderIds);
}

/**
 * طلب مؤكد ما وصل مجموعة تيليغرام ولا إله مهمة: منعملّه مهمة.
 */
export async function sweepOrdersMissingTelegram(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ORDER_DELIVERY_SWEEP_HOURS * 3600_000);
  const byWorkspace = groupByWorkspace(await confirmedOrdersSince(db, cutoff));

  let queued = 0;
  for (const [workspaceId, orders] of byWorkspace) {
    if (!(await telegramReady(db, workspaceId))) continue;
    const sent = await telegramDone(db, workspaceId, orders.map((o) => o.id));
    const known = await orderIdsWithJob(db, workspaceId, "notify_order_telegram");
    for (const order of orders) {
      if (sent.has(order.id) || known.has(order.id)) continue;
      const res = await enqueueJob(db, {
        workspaceId,
        type: "notify_order_telegram",
        payload: { orderId: order.id, userId: "system" },
        idempotencyKey: `tg-order:${workspaceId}:${order.id}`,
        maxAttempts: 8,
      }).catch(() => null);
      if (res && !res.deduplicated) queued += 1;
      if (queued >= ORDER_DELIVERY_SWEEP_LIMIT) break;
    }
    if (queued >= ORDER_DELIVERY_SWEEP_LIMIT) break;
  }
  if (queued > 0) log.info({ queued }, "telegram_missing_orders_queued");
  return queued;
}
