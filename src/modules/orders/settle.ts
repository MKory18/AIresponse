import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/jobs/service";
import { getIntegrationSettings } from "@/modules/integrations/settings";
import { sealOrder } from "@/modules/orders/reader/actions";

const log = childLogger("order-settle");

/**
 * كنس التثبيت (§8.3) — من `runIntegrationScheduler` كل دورة.
 *
 * لكل طلب: `status = NEW` · `settleAt <= الآن` · `heldBy = null` · مساحته على `READER`
 * و`orderAutoSeal = true`. التثبيت ذرّي (`sealOrder`)، وما بيثبّت على قراءة قديمة:
 * إذا آخر رسالة عميل مش مغطّاة بالقراءة بيصفّف قراءة فورية ويتخطّى.
 * التثبيت هو لحظة الخروج الوحيدة (الحزمة 1.6): تيليجرام · الـ OMS · رسالة التثبيت — `sealOrder` > `runAfterSeal`.
 */
export interface SealSweepResult {
  checked: number;
  sealed: number;
  skipped: Record<string, number>;
}

async function isCollectionOnlyPage(db: Db, orderId: string): Promise<boolean> {
  try {
    const d = db as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
    const order = (await d.order.findUnique({ where: { id: orderId } })) as { conversationId?: string | null } | null;
    if (!order?.conversationId) return false;
    const conv = (await d.conversation.findUnique({ where: { id: order.conversationId } })) as { channelId?: string | null } | null;
    if (!conv?.channelId) return false;
    const ch = (await d.channel.findUnique({ where: { id: conv.channelId } })) as { sendMode?: string } | null;
    return ch?.sendMode === "COLLECTION_ONLY";
  } catch {
    return false;
  }
}

export async function sealDueOrders(db: Db, now = new Date(), opts: { limit?: number } = {}): Promise<SealSweepResult> {
  const d = db as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
  const due = (await d.order.findMany({
    where: { status: "NEW", settleAt: { lte: now }, heldBy: null, sealedAt: null },
    orderBy: { settleAt: "asc" },
    take: opts.limit ?? 50,
    select: { id: true, workspaceId: true },
  })) as Array<{ id: string; workspaceId: string }>;

  const result: SealSweepResult = { checked: due.length, sealed: 0, skipped: {} };
  const settingsCache = new Map<string, { orderMode: string; orderAutoSeal: boolean }>();
  for (const o of due) {
    let s = settingsCache.get(o.workspaceId);
    if (!s) {
      const full = await getIntegrationSettings(db, o.workspaceId).catch(() => null);
      s = { orderMode: full?.orderMode ?? "LEGACY_DRAFT", orderAutoSeal: full?.orderAutoSeal ?? false };
      settingsCache.set(o.workspaceId, s);
    }
    if (s.orderMode !== "READER" || !s.orderAutoSeal) {
      result.skipped.MODE_OR_AUTOSEAL_OFF = (result.skipped.MODE_OR_AUTOSEAL_OFF ?? 0) + 1;
      continue;
    }
    // صفحة «تجميع فقط»: التثبيت التلقائي مطفي (كل طلب بيستنى موظف) — §13.
    if (await isCollectionOnlyPage(db, o.id)) {
      result.skipped.COLLECTION_ONLY = (result.skipped.COLLECTION_ONLY ?? 0) + 1;
      continue;
    }
    try {
      const r = await sealOrder(db, { workspaceId: o.workspaceId, orderId: o.id, actor: { userId: null, workspaceId: o.workspaceId }, auto: true, now });
      if (r.sealed) result.sealed += 1;
      else result.skipped[r.reason] = (result.skipped[r.reason] ?? 0) + 1;
    } catch (err) {
      result.skipped.ERROR = (result.skipped.ERROR ?? 0) + 1;
      log.warn({ orderId: o.id, error: err instanceof Error ? err.message : String(err) }, "seal_failed");
    }
  }
  if (result.sealed > 0 || Object.keys(result.skipped).length > 0) log.info(result, "seal_sweep");
  return result;
}
