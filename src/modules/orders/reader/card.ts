import type { Db } from "@/modules/jobs/service";
import { getOrderMode, type OrderMode } from "./schedule";

/**
 * بيانات «بطاقة الطلب» للموظف (الحزمة 1.8): القراءة + الطلب المرتبط بالمحادثة + سجل التغييرات.
 * القيم **كاملة** (هاتف · عنوان) — الموظف لازم يقدر يتحقق منها؛ المسار نفسه محمي بصلاحية `orders.read`
 * وما بيروح لأي موديل. المسودة القديمة (`LEGACY_DRAFT`) = `mode` بس وبلا بيانات.
 */
export interface OrderCardItem {
  name: string;
  quantity: number | null;
  unitPrice: number;
}

export interface OrderCardData {
  mode: OrderMode;
  conversationId: string;
  reading: {
    stage: string;
    status: string;
    version: number;
    missing: string[];
    flags: string[];
    openQuestions: string[];
    lastError: string | null;
    readAt: string | null;
    items: OrderCardItem[];
    recipient: { name: string | null; phone: string | null; altPhone: string | null; province: string | null; address: string | null };
    currency: string | null;
  } | null;
  order: {
    id: string;
    orderNumber: string;
    status: string;
    settleAt: string | null;
    sealedAt: string | null;
    heldBy: string | null;
    reviewReasons: string[];
    total: number;
    currency: string;
    recipientName: string | null;
    recipientPhone: string | null;
    recipientAltPhone: string | null;
    deliveryAddress: string | null;
    province: string | null;
    omsStatus: string | null;
    omsShippingStatus: string | null;
    omsOrderId: string | null;
    items: OrderCardItem[];
  } | null;
  /** طلب تعديل/إلغاء بعد التثبيت لسا معلّق. */
  pendingChange: { version: number; kind: string; omsState: string | null; diff: Array<{ field: string; from: unknown; to: unknown }> } | null;
  timeline: Array<{ version: number; kind: string; actor: string; createdAt: string; diff: Array<{ field: string; from: unknown; to: unknown }> }>;
}

type M = Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
type Row = Record<string, any>;

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export async function getOrderCard(db: Db, input: { workspaceId: string; conversationId: string }): Promise<OrderCardData> {
  const mode = await getOrderMode(db, input.workspaceId);
  const base: OrderCardData = { mode, conversationId: input.conversationId, reading: null, order: null, pendingChange: null, timeline: [] };
  if (mode === "LEGACY_DRAFT") return base;
  const d = db as unknown as M;

  const reading = (await d.conversationReading.findUnique({ where: { conversationId: input.conversationId } })) as Row | null;
  if (reading && reading.workspaceId === input.workspaceId) {
    const data = (reading.data ?? {}) as Row;
    base.reading = {
      stage: String(reading.stage ?? "NONE"),
      status: String(reading.status ?? "IDLE"),
      version: Number(reading.version ?? 0),
      missing: (reading.missing ?? []) as string[],
      flags: (reading.flags ?? []) as string[],
      openQuestions: (data.openQuestions ?? []) as string[],
      lastError: reading.lastError ? String(reading.lastError).slice(0, 160) : null,
      readAt: iso(reading.readAt),
      items: ((data.items ?? []) as Row[]).map((i) => ({ name: String(i.name), quantity: i.quantity ?? null, unitPrice: Number(i.unitPrice ?? 0) })),
      recipient: {
        name: data.recipient?.name ?? null,
        phone: data.recipient?.phone ?? null,
        altPhone: data.recipient?.altPhone ?? null,
        province: data.recipient?.province ?? null,
        address: data.recipient?.address ?? null,
      },
      currency: data.totals?.currency ?? null,
    };
  }

  const order = (await d.order.findFirst({
    where: { workspaceId: input.workspaceId, conversationId: input.conversationId, status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
  })) as Row | null;
  if (!order) return base;

  const items = (await d.orderItem.findMany({ where: { orderId: order.id } })) as Row[];
  base.order = {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    settleAt: iso(order.settleAt),
    sealedAt: iso(order.sealedAt),
    heldBy: order.heldBy ?? null,
    reviewReasons: (order.reviewReasons ?? []) as string[],
    total: Number(order.total ?? 0),
    currency: String(order.currency ?? ""),
    recipientName: order.recipientName ?? null,
    recipientPhone: order.recipientPhone ?? null,
    recipientAltPhone: order.recipientAltPhone ?? null,
    deliveryAddress: order.deliveryAddress ?? null,
    province: order.province ?? null,
    omsStatus: order.omsStatus ?? null,
    omsShippingStatus: order.omsShippingStatus ?? null,
    omsOrderId: order.omsOrderId ?? null,
    items: items.map((i) => ({ name: String(i.productNameSnapshot), quantity: Number(i.quantity), unitPrice: Number(i.unitPrice ?? 0) })),
  };

  const revs = (await d.orderRevision.findMany({ where: { orderId: order.id }, orderBy: { version: "desc" }, take: 8 })) as Row[];
  base.timeline = revs.map((r) => ({
    version: Number(r.version),
    kind: String(r.kind),
    actor: String(r.actor),
    createdAt: iso(r.createdAt) ?? "",
    diff: (Array.isArray(r.diff) ? r.diff : []) as Array<{ field: string; from: unknown; to: unknown }>,
  }));
  const pending = revs.find((r) => ["AMEND_REQUEST", "CANCEL_REQUEST"].includes(String(r.kind)) && ["PENDING", "NOTE_SENT", "NEEDS_STAFF"].includes(String(r.omsState)));
  if (pending) {
    base.pendingChange = {
      version: Number(pending.version),
      kind: String(pending.kind),
      omsState: pending.omsState ?? null,
      diff: (Array.isArray(pending.diff) ? pending.diff : []) as Array<{ field: string; from: unknown; to: unknown }>,
    };
  }
  return base;
}
