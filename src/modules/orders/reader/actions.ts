import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import { publishRealtime } from "@/modules/realtime/events";
import { enqueueJob, type Db } from "@/modules/jobs/service";
import { assertOrderTransition } from "@/modules/orders/state-machine";
import { getIntegrationSettings } from "@/modules/integrations/settings";
import { isBlacklistedAtOms, runAfterSeal } from "./after-seal";
import { requestChangeOnSealedOrder, type AmendOutcome } from "./amend";

/**
 * إجراءات الطلب المقروء (الحزمة 1.4): تثبيت · أوقف · أطلق · إلغاء · تعديل حقول · إعادة قراءة.
 *
 * - التثبيت (`sealOrder`) بيغيّر الحالة وبينشر `OrderConfirmed` وبس — **ولا إرسال لبرّا**
 *   (الـ OMS · تيليجرام · رسالة للعميل = الحزمة 1.6).
 * - الحجز الذرّي: `updateMany` بشرط الحالة ونسخة القراءة؛ كنسين بنفس اللحظة = تثبيت واحد.
 * - كل تغيير إله `OrderRevision`.
 */
type Row = Record<string, unknown>;
type M = Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
export interface Actor {
  userId: string | null; // null = النظام
  workspaceId: string;
}

type OrderRow = {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  status: string;
  readVersion: number;
  reviewReasons: string[];
  agreement: string | null;
  heldBy: string | null;
  settleAt: Date | null;
  sealedAt: Date | null;
  customerId: string;
  recipientPhone?: string | null;
};

async function loadOrder(db: Db, workspaceId: string, orderId: string): Promise<OrderRow> {
  const o = (await (db as unknown as M).order.findUnique({ where: { id: orderId } })) as OrderRow | null;
  if (!o || o.workspaceId !== workspaceId) throw new NotFoundError("Order");
  return o;
}

async function nextVersion(db: Db, orderId: string): Promise<number> {
  const last = (await (db as unknown as M).orderRevision.findMany({ where: { orderId }, orderBy: { version: "desc" }, take: 1 })) as Array<{ version: number }>;
  return (last[0]?.version ?? 0) + 1;
}

async function addRevision(
  db: Db,
  o: { id: string; workspaceId: string },
  kind: string,
  actor: Actor,
  diff: unknown[],
  snapshot: Row = {}
) {
  await (db as unknown as M).orderRevision.create({
    data: {
      workspaceId: o.workspaceId,
      orderId: o.id,
      version: await nextVersion(db, o.id),
      kind,
      snapshot,
      diff: JSON.parse(JSON.stringify(diff)),
      evidence: [],
      actor: actor.userId ? `user:${actor.userId}` : "system",
    },
  });
}

function notify(db: Db, o: OrderRow) {
  void publishRealtime(db as never, { workspaceId: o.workspaceId, type: "order.updated", conversationId: o.conversationId ?? undefined, entityId: o.id });
}

export type SealResult = { sealed: true; orderId: string } | { sealed: false; reason: "STALE_READING" | "NOT_SEALABLE" | "RACE_LOST" | "ON_HOLD" | "BLACKLISTED" };

/**
 * تثبيت طلب. `auto = true` من كنس المهلة: بيشترط قراءة طازة وما بيثبّت `CONFIRMATION_PENDING`.
 * التثبيت اليدوي (موظف) بيجوز من `NEW` أو `CONFIRMATION_PENDING` بموافقة الموظف (`agreement = STAFF`).
 */
export async function sealOrder(
  db: Db,
  input: { workspaceId: string; orderId: string; actor: Actor; auto?: boolean; now?: Date }
): Promise<SealResult> {
  const now = input.now ?? new Date();
  const order = await loadOrder(db, input.workspaceId, input.orderId);
  const auto = input.auto === true;
  if (order.heldBy && auto) return { sealed: false, reason: "ON_HOLD" };
  const allowed = auto ? ["NEW"] : ["NEW", "CONFIRMATION_PENDING"];
  if (!allowed.includes(order.status) || order.sealedAt) return { sealed: false, reason: "NOT_SEALABLE" };

  if (auto && order.conversationId) {
    const d = db as unknown as M;
    const lastCustomer = (await d.message.findFirst({
      where: { conversationId: order.conversationId, deletedAt: null, isNote: false, senderType: "CUSTOMER" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    })) as { id: string } | null;
    const reading = (await d.conversationReading.findUnique({ where: { conversationId: order.conversationId } })) as {
      readThroughMessageId?: string | null;
      status?: string;
    } | null;
    if (lastCustomer && (!reading || reading.status !== "DONE" || reading.readThroughMessageId !== lastCustomer.id)) {
      // ما منثبّت على قراءة قديمة: اصفف قراءة فورية وتخطَّ.
      await enqueueJob(db, {
        workspaceId: input.workspaceId,
        type: "read_conversation",
        payload: { conversationId: order.conversationId, throughMessageId: lastCustomer.id, trigger: "CUSTOMER" },
        idempotencyKey: `read:${input.workspaceId}:${order.conversationId}:${lastCustomer.id}:seal`,
        maxAttempts: 4,
      }).catch(() => undefined);
      return { sealed: false, reason: "STALE_READING" };
    }
  }

  // العميل محظور بالـ OMS؟ ما منثبّت ولا منبعت: الطلب بيروح للمراجعة (§10.1).
  if (await isBlacklistedAtOms(db, order.workspaceId, order.recipientPhone ?? null)) {
    const reasons = [...new Set([...order.reviewReasons, "CUSTOMER_BLACKLISTED"])];
    const data: Row = { reviewReasons: reasons, settleAt: null };
    if (order.status === "NEW") {
      assertOrderTransition("NEW", "CONFIRMATION_PENDING");
      data.status = "CONFIRMATION_PENDING";
    }
    await (db as unknown as M).order.update({ where: { id: order.id }, data });
    await addRevision(db, order, "STAFF_EDIT", input.actor, [{ field: "reviewReasons", from: order.reviewReasons, to: reasons }]);
    notify(db, order);
    return { sealed: false, reason: "BLACKLISTED" };
  }

  assertOrderTransition(order.status as never, "CONFIRMED");
  const claimed = (await (db as unknown as M).order.updateMany({
    where: { id: order.id, status: order.status, readVersion: order.readVersion, sealedAt: null },
    data: {
      status: "CONFIRMED",
      confirmationStatus: auto ? "CONFIRMED_BY_CUSTOMER" : "CONFIRMED_BY_AGENT",
      sealedAt: now,
      settleAt: null,
      ...(auto ? {} : { agreement: "STAFF" }),
    },
  })) as { count: number };
  if (claimed.count !== 1) return { sealed: false, reason: "RACE_LOST" };

  await addRevision(db, order, "SEAL", input.actor, [{ field: "status", from: order.status, to: "CONFIRMED" }], { sealedAt: now.toISOString() });
  await recordAudit(db, {
    workspaceId: order.workspaceId,
    userId: input.actor.userId,
    action: "order.sealed",
    entityType: "Order",
    entityId: order.id,
    metadata: { auto },
  }).catch(() => undefined);
  await eventBus.publish(makeEvent("OrderConfirmed", order.workspaceId, { orderId: order.id, customerId: order.customerId, conversationId: order.conversationId })).catch(() => undefined);
  // التثبيت = لحظة الخروج الوحيدة (1.6): تيليجرام · الـ OMS · رسالة التثبيت — كل واحد بمعزل.
  await runAfterSeal(db, order, input.actor);
  notify(db, order);
  return { sealed: true, orderId: order.id };
}

/** «أوقف»: الطلب بيستنى موظف (سبب `STAFF_HOLD`) وما بيتثبّت لحاله. */
export async function holdOrder(db: Db, input: { workspaceId: string; orderId: string; actor: Actor }) {
  const order = await loadOrder(db, input.workspaceId, input.orderId);
  if (order.sealedAt || !["NEW", "CONFIRMATION_PENDING"].includes(order.status)) {
    throw new AppError("Order cannot be held", 422, "ORDER_NOT_HOLDABLE");
  }
  const reasons = [...new Set([...order.reviewReasons, "STAFF_HOLD"])];
  const data: Row = { heldBy: input.actor.userId ?? "system", settleAt: null, reviewReasons: reasons };
  if (order.status === "NEW") {
    assertOrderTransition("NEW", "CONFIRMATION_PENDING");
    data.status = "CONFIRMATION_PENDING";
  }
  await (db as unknown as M).order.update({ where: { id: order.id }, data });
  await addRevision(db, order, "STAFF_EDIT", input.actor, [{ field: "hold", from: false, to: true }]);
  notify(db, order);
  return { orderId: order.id, status: (data.status as string) ?? order.status };
}

/** «أطلق»: شيل `STAFF_HOLD`؛ إذا ما ضل أسباب ← `NEW` ومهلة جديدة. */
export async function releaseOrder(db: Db, input: { workspaceId: string; orderId: string; actor: Actor; now?: Date }) {
  const now = input.now ?? new Date();
  const order = await loadOrder(db, input.workspaceId, input.orderId);
  if (order.sealedAt || !["NEW", "CONFIRMATION_PENDING"].includes(order.status)) {
    throw new AppError("Order cannot be released", 422, "ORDER_NOT_RELEASABLE");
  }
  const reasons = order.reviewReasons.filter((r) => r !== "STAFF_HOLD");
  const data: Row = { heldBy: null, reviewReasons: reasons };
  if (reasons.length === 0) {
    const settings = await getIntegrationSettings(db, order.workspaceId);
    if (order.status === "CONFIRMATION_PENDING") {
      assertOrderTransition("CONFIRMATION_PENDING", "NEW");
      data.status = "NEW";
    }
    data.settleAt = new Date(now.getTime() + settings.orderSettleMinutes * 60_000);
  }
  await (db as unknown as M).order.update({ where: { id: order.id }, data });
  await addRevision(db, order, "STAFF_EDIT", input.actor, [{ field: "hold", from: true, to: false }]);
  notify(db, order);
  return { orderId: order.id, status: (data.status as string) ?? order.status };
}

/** إلغاء يدوي لطلب غير مثبّت. المثبّت بيروح لمسار الإلغاء بعد التثبيت (الحزمة 1.6). */
export async function cancelOrderByStaff(
  db: Db,
  input: { workspaceId: string; orderId: string; actor: Actor; reason?: string }
): Promise<{ orderId: string; status: string; cancel?: AmendOutcome }> {
  const order = await loadOrder(db, input.workspaceId, input.orderId);
  if (order.sealedAt) {
    // المثبّت: مسار طلب الإلغاء (§10.3) — محلي إذا ما انبعت، وإلا ملاحظة للـ OMS + بند «يحتاجك».
    if (!order.conversationId) throw new AppError("Sealed order has no conversation", 422, "ORDER_SEALED");
    const cancel = await requestChangeOnSealedOrder(db, { workspaceId: input.workspaceId, conversationId: order.conversationId, kind: "CANCEL", actor: input.actor, reason: input.reason });
    return { orderId: order.id, status: cancel.action === "CANCEL_APPLIED" ? "CANCELLED" : order.status, cancel };
  }
  assertOrderTransition(order.status as never, "CANCELLED");
  await (db as unknown as M).order.update({ where: { id: order.id }, data: { status: "CANCELLED", settleAt: null } });
  await addRevision(db, order, "CANCEL_APPLIED", input.actor, [{ field: "status", from: order.status, to: "CANCELLED" }, ...(input.reason ? [{ field: "reason", from: null, to: input.reason }] : [])]);
  notify(db, order);
  return { orderId: order.id, status: "CANCELLED" };
}

const EDITABLE = ["recipientName", "recipientPhone", "recipientAltPhone", "deliveryAddress", "province", "notes"] as const;
export type EditableField = (typeof EDITABLE)[number];

/** تعديل موظف على حقول الطلب (قبل التثبيت): بيتحمي من استبدال القراءة اللاحقة. */
export async function editOrderFields(
  db: Db,
  input: { workspaceId: string; orderId: string; actor: Actor; fields: Partial<Record<EditableField, string | null>> }
): Promise<{ orderId: string; changed: string[]; amend?: AmendOutcome }> {
  const order = (await loadOrder(db, input.workspaceId, input.orderId)) as OrderRow & Record<string, unknown>;
  if (order.sealedAt && order.conversationId) {
    // المثبّت: طلب تعديل (§10.3) مش تعديل مباشر.
    const amend = await requestChangeOnSealedOrder(db, { workspaceId: input.workspaceId, conversationId: order.conversationId, kind: "AMEND", actor: input.actor, staffFields: input.fields });
    return { orderId: order.id, changed: [], amend };
  }
  if (order.sealedAt || !["NEW", "CONFIRMATION_PENDING"].includes(order.status)) {
    throw new AppError("Only an unsealed order can be edited", 422, "ORDER_NOT_EDITABLE");
  }
  const diff: Array<{ field: string; from: unknown; to: unknown }> = [];
  const data: Row = {};
  for (const f of EDITABLE) {
    if (!(f in input.fields)) continue;
    const to = input.fields[f] ?? null;
    const from = (order[f] as string | null | undefined) ?? null;
    if (to !== from) {
      diff.push({ field: f, from, to });
      data[f] = to;
    }
  }
  if (diff.length === 0) return { orderId: order.id, changed: [] as string[] };
  await (db as unknown as M).order.update({ where: { id: order.id }, data });
  await addRevision(db, order, "STAFF_EDIT", input.actor, diff);
  notify(db, order);
  return { orderId: order.id, changed: diff.map((x) => x.field) };
}

/** إعادة قراءة فورية للمحادثة (زر «من الرسالة»/«أعد القراءة»). */
export async function rereadConversation(db: Db, input: { workspaceId: string; conversationId: string }) {
  const d = db as unknown as M;
  const conv = (await d.conversation.findFirst({ where: { id: input.conversationId, workspaceId: input.workspaceId }, select: { id: true } })) as { id: string } | null;
  if (!conv) throw new NotFoundError("Conversation");
  const last = (await d.message.findFirst({
    where: { conversationId: input.conversationId, deletedAt: null, isNote: false, senderType: "CUSTOMER" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  })) as { id: string } | null;
  if (!last) throw new AppError("No customer message to read", 422, "NO_CUSTOMER_MESSAGE");
  // نمسح التغطية: القراءة بتنعاد حتى لو ما في رسالة جديدة.
  const existing = (await d.conversationReading.findUnique({ where: { conversationId: input.conversationId } })) as { id: string } | null;
  if (existing) await d.conversationReading.update({ where: { id: existing.id }, data: { status: "IDLE", readThroughMessageId: null } });
  const job = await enqueueJob(db, {
    workspaceId: input.workspaceId,
    type: "read_conversation",
    payload: { conversationId: input.conversationId, throughMessageId: last.id, trigger: "CUSTOMER" },
    idempotencyKey: `read:${input.workspaceId}:${input.conversationId}:${last.id}:manual:${Date.now()}`,
    maxAttempts: 4,
  });
  return { queued: true, jobId: job.id };
}
