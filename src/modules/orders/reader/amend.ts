import { AppError, NotFoundError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import { publishRealtime } from "@/modules/realtime/events";
import { assertOrderTransition } from "@/modules/orders/state-machine";
import type { Db } from "@/modules/jobs/service";
import { diffOrder, type FieldDiff } from "./lifecycle";
import type { VerifiedReading } from "./verify";

const log = childLogger("order-reader");

/**
 * التعديل والإلغاء بعد التثبيت (§10.3).
 *
 *  (أ) الطلب لسا ما انبعت (`omsOrderId = null`): بنطبّق محليًا (أو نلغي) ← `AMEND_APPLIED`/`CANCEL_APPLIED`.
 *  (ب) انبعت والـ OMS بيدعم التعديل الآلي: **هيكل جاهز خلف `OMS_AUTO_AMEND`** (بيتفعّل بعد المرحلة 5).
 *  (ج) انبعت وما في تعديل آلي: ملاحظة حتمية على طلب الـ OMS (`addOrderNote`) ← `NOTE_SENT`
 *      + بند «يحتاجك» (`ORDER_CHANGE_REQUEST`) فيه «تم التعديل بالـ OMS» (`APPLIED`) و«مرفوض» (`REJECTED`).
 *      فشل الملاحظة = `NEEDS_STAFF` (البند نفسه بيحمل الطلب). **المسار (ج) هو المعتمد من أول يوم.**
 * ما في أي رسالة للعميل من هون: البائع بيقول الحقيقة من «بطاقة الطلب».
 */
export const OMS_AUTO_AMEND = false;

/**
 * التعديل/الإلغاء الآلي بالـ OMS: **مطفي افتراضيًا** (تفعيل بالإنتاج = ضغطة المالك).
 * بيتفعّل بعد ما الـ OMS ينشر نقطتي `amend`/`cancel` ويصدر المالك توكنًا جديدًا بصلاحيتهم: `OMS_AUTO_AMEND=1`.
 * أي رفض (توكن قديم · طلب مش قابل للتعديل · الـ OMS واقف) بيرجّع للمسار المعتمد: ملاحظة + موظف — ما في حالة أسوأ من اليوم.
 */
export function omsAutoAmendEnabled(): boolean {
  return process.env.OMS_AUTO_AMEND === "1";
}

const AUTO_FIELD: Record<string, "name" | "phone" | "city" | "address"> = {
  recipientName: "name",
  recipientPhone: "phone",
  province: "city",
  deliveryAddress: "address",
};

/** الفرق قابل للتعديل الآلي؟ حقول العميل والملاحظات بس (البنود/الهاتف الإضافي ← الملاحظة + الموظف). */
export function autoAmendBody(diff: FieldDiff[]): { customer?: Record<string, string>; notes?: string } | null {
  const customer: Record<string, string> = {};
  let notes: string | undefined;
  for (const x of diff) {
    if (x.field === "notes") {
      if (typeof x.to !== "string" || !x.to.trim()) return null;
      notes = x.to;
    } else if (AUTO_FIELD[x.field]) {
      if (typeof x.to !== "string" || !x.to.trim()) return null;
      customer[AUTO_FIELD[x.field]] = x.to;
    } else {
      return null;
    }
  }
  if (Object.keys(customer).length === 0 && notes === undefined) return null;
  return { ...(Object.keys(customer).length > 0 ? { customer } : {}), ...(notes !== undefined ? { notes } : {}) };
}

/** قابل للتعديل بالـ OMS = نفس قاعدة `chatEditable` عندهم. */
export function isChatEditable(order: { omsStatus?: string | null; omsShippingStatus?: string | null }): boolean {
  const okStatus = ["NEW", "IN_PROGRESS", "NO_ANSWER", "FOLLOW_UP_REQUIRED", "POSTPONED"];
  return okStatus.includes(String(order.omsStatus ?? "NEW")) && String(order.omsShippingStatus ?? "NOT_READY") === "NOT_READY";
}

type M = Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
type SealedOrder = {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  customerId: string;
  orderNumber: string;
  status: string;
  omsOrderId: string | null;
  omsStatus: string | null;
  omsShippingStatus: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  recipientAltPhone: string | null;
  deliveryAddress: string | null;
  province: string | null;
  notes: string | null;
};

export type AmendOutcome =
  | { action: "NONE"; reason: string }
  | { action: "AMEND_APPLIED" | "CANCEL_APPLIED"; orderId: string }
  | { action: "AMEND_REQUESTED" | "CANCEL_REQUESTED"; orderId: string; omsState: "NOTE_SENT" | "NEEDS_STAFF"; handoffId: string | null };

const FIELD_AR: Record<string, string> = {
  recipientName: "الاسم",
  recipientPhone: "الهاتف",
  recipientAltPhone: "هاتف إضافي",
  deliveryAddress: "العنوان",
  province: "المحافظة",
  notes: "الملاحظات",
  items: "البنود",
  status: "الحالة",
};

export function describeDiff(diff: FieldDiff[], names: Record<string, string> = {}): string {
  const show = (v: unknown): string => {
    if (Array.isArray(v)) return v.map((i) => `${names[(i as { productId: string }).productId] ?? "منتج"} × ${(i as { quantity: number }).quantity}`).join("، ");
    return v === null || v === undefined || v === "" ? "—" : String(v);
  };
  return diff.map((d) => `${FIELD_AR[d.field] ?? d.field} من ${show(d.from)} إلى ${show(d.to)}`).join(" · ");
}

export async function findLastSealedOrder(db: Db, workspaceId: string, conversationId: string): Promise<SealedOrder | null> {
  const rows = (await (db as unknown as M).order.findMany({
    where: { workspaceId, conversationId, sealedAt: { not: null }, status: { notIn: ["CANCELLED", "FAILED", "RETURNED", "DELIVERED"] } },
    orderBy: { sealedAt: "desc" },
    take: 1,
  })) as SealedOrder[];
  return rows[0] ?? null;
}

async function nextVersion(db: Db, orderId: string): Promise<number> {
  const last = (await (db as unknown as M).orderRevision.findMany({ where: { orderId }, orderBy: { version: "desc" }, take: 1 })) as Array<{ version: number }>;
  return (last[0]?.version ?? 0) + 1;
}

export interface RequestAmendInput {
  workspaceId: string;
  conversationId: string;
  kind: "AMEND" | "CANCEL";
  actor: { userId: string | null };
  /** من القارئ: الفرق بيتحسب مقابل الطلب المثبّت. */
  verified?: VerifiedReading;
  /** من موظف: الحقول الجديدة. */
  staffFields?: Partial<Record<"recipientName" | "recipientPhone" | "recipientAltPhone" | "deliveryAddress" | "province" | "notes", string | null>>;
  reason?: string;
}

export async function requestChangeOnSealedOrder(db: Db, input: RequestAmendInput): Promise<AmendOutcome> {
  const d = db as unknown as M;
  const order = await findLastSealedOrder(db, input.workspaceId, input.conversationId);
  if (!order) return { action: "NONE", reason: "NO_SEALED_ORDER" };

  const items = (await d.orderItem.findMany({ where: { orderId: order.id }, select: { productId: true, quantity: true, productNameSnapshot: true } })) as Array<{ productId: string; quantity: number; productNameSnapshot: string }>;
  const names: Record<string, string> = Object.fromEntries(items.map((i) => [i.productId, i.productNameSnapshot]));

  let diff: FieldDiff[];
  if (input.kind === "CANCEL") {
    diff = [{ field: "status", from: order.status, to: "CANCELLED" }];
  } else if (input.staffFields) {
    diff = [];
    for (const [field, to] of Object.entries(input.staffFields)) {
      const from = (order as unknown as Record<string, unknown>)[field] as string | null | undefined;
      if ((to ?? null) !== (from ?? null)) diff.push({ field, from: from ?? null, to: to ?? null });
    }
  } else if (input.verified) {
    diff = diffOrder({ ...order, readVersion: 0, settleAt: null, items } as never, input.verified);
    for (const i of input.verified.items) names[i.productId] = i.name;
  } else {
    return { action: "NONE", reason: "NO_CHANGE_SOURCE" };
  }
  if (diff.length === 0) return { action: "NONE", reason: "NO_DIFF" };

  // طلب مطابق لسا معلّق؟ ما منكرّره عند كل قراءة.
  const serialized = JSON.stringify(diff);
  const pending = (await d.orderRevision.findMany({
    where: { orderId: order.id, kind: input.kind === "CANCEL" ? "CANCEL_REQUEST" : "AMEND_REQUEST", omsState: { in: ["PENDING", "NOTE_SENT", "NEEDS_STAFF"] } },
  })) as Array<{ diff: unknown }>;
  if (pending.some((r) => JSON.stringify(r.diff) === serialized)) return { action: "NONE", reason: "ALREADY_REQUESTED" };

  const actor = input.actor.userId ? `user:${input.actor.userId}` : "reader";
  const fieldsOnly = diff.every((x) => x.field !== "items");

  // ── (أ) لسا ما انبعت ──
  if (!order.omsOrderId && (input.kind === "CANCEL" || fieldsOnly)) {
    if (input.kind === "CANCEL") {
      assertOrderTransition(order.status as never, "CANCELLED");
      await d.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    } else {
      const data: Record<string, unknown> = {};
      for (const x of diff) data[x.field] = x.to;
      await d.order.update({ where: { id: order.id }, data });
    }
    const kind = input.kind === "CANCEL" ? "CANCEL_APPLIED" : "AMEND_APPLIED";
    await d.orderRevision.create({
      data: { workspaceId: order.workspaceId, orderId: order.id, version: await nextVersion(db, order.id), kind, snapshot: {}, diff: JSON.parse(serialized), evidence: [], actor, omsState: "APPLIED" },
    });
    void publishRealtime(db as never, { workspaceId: order.workspaceId, type: "order.updated", conversationId: input.conversationId, entityId: order.id });
    return { action: kind, orderId: order.id };
  }

  const version = await nextVersion(db, order.id);

  // ── (ب) تعديل/إلغاء آلي بالـ OMS: بس لما مفعّل. أي رفض ← (ج) تحت ──
  if (order.omsOrderId && omsAutoAmendEnabled()) {
    const body = input.kind === "AMEND" ? autoAmendBody(diff) : null;
    if (input.kind === "CANCEL" || body) {
      try {
        const { buildOmsClient } = await import("@/modules/oms/connection");
        const client = await buildOmsClient(db as never, order.workspaceId);
        // الانتقال المحلي لازم يصلح قبل ما نلمس الـ OMS (ما نلغي عندهم وبعدين نفشل عنا).
        if (input.kind === "CANCEL") assertOrderTransition(order.status as never, "CANCELLED");
        const key = `replies:${order.workspaceId}:${order.id}:rev${version}`;
        if (input.kind === "CANCEL") await client.cancelOrder(order.omsOrderId, input.reason ?? "العميل تراجع بالمحادثة", key);
        else await client.amendOrder(order.omsOrderId, body!, input.reason ?? "العميل غيّر بياناته بالمحادثة", key);
        if (input.kind === "CANCEL") {
          await d.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
        } else {
          const data: Record<string, unknown> = {};
          for (const x of diff) data[x.field] = x.to;
          await d.order.update({ where: { id: order.id }, data });
        }
        const appliedKind = input.kind === "CANCEL" ? "CANCEL_APPLIED" : "AMEND_APPLIED";
        await d.orderRevision.create({
          data: { workspaceId: order.workspaceId, orderId: order.id, version, kind: appliedKind, snapshot: {}, diff: JSON.parse(serialized), evidence: [], actor, omsState: "APPLIED" },
        });
        void publishRealtime(db as never, { workspaceId: order.workspaceId, type: "order.updated", conversationId: input.conversationId, entityId: order.id });
        return { action: appliedKind, orderId: order.id };
      } catch (err) {
        log.warn({ orderId: order.id, error: err instanceof Error ? err.message : String(err) }, "oms_auto_amend_fallback_to_note");
      }
    }
  }

  // ── (ج) ملاحظة + بند «يحتاجك» ──
  const text = `${input.kind === "CANCEL" ? "طلب إلغاء" : "طلب تعديل"} من المحادثة: ${describeDiff(diff, names)}${input.reason ? ` — ${input.reason}` : ""}`;
  let omsState: "NOTE_SENT" | "NEEDS_STAFF" = "NEEDS_STAFF";
  if (order.omsOrderId) {
    try {
      const { buildOmsClient } = await import("@/modules/oms/connection");
      const client = await buildOmsClient(db as never, order.workspaceId);
      await client.addOrderNote(order.omsOrderId, text, `replies:${order.workspaceId}:${order.id}:rev${version}`);
      omsState = "NOTE_SENT";
    } catch (err) {
      log.warn({ orderId: order.id, error: err instanceof Error ? err.message : String(err) }, "amend_note_failed");
    }
  }
  const kind = input.kind === "CANCEL" ? "CANCEL_REQUEST" : "AMEND_REQUEST";
  await d.orderRevision.create({
    data: { workspaceId: order.workspaceId, orderId: order.id, version, kind, snapshot: {}, diff: JSON.parse(serialized), evidence: [], actor, omsState },
  });
  let handoffId: string | null = null;
  try {
    const { createHandoff } = await import("@/modules/handoffs/handoff-service");
    const h = (await createHandoff(db as never, {
      workspaceId: order.workspaceId,
      conversationId: input.conversationId,
      customerId: order.customerId,
      reason: "ORDER_CHANGE_REQUEST",
      metadata: { orderId: order.id, orderNumber: order.orderNumber, kind, revision: version, fields: diff.map((x) => x.field), omsState },
    })) as { id: string };
    handoffId = h.id;
  } catch (err) {
    log.warn({ orderId: order.id, error: err instanceof Error ? err.message : String(err) }, "amend_handoff_failed");
  }
  return { action: input.kind === "CANCEL" ? "CANCEL_REQUESTED" : "AMEND_REQUESTED", orderId: order.id, omsState, handoffId };
}

/** قرار الموظف على طلب تعديل/إلغاء: «تم التعديل بالـ OMS» (APPLIED) أو «مرفوض» (REJECTED). */
export async function resolveChangeRequest(
  db: Db,
  input: { workspaceId: string; orderId: string; version: number; decision: "APPLIED" | "REJECTED"; actor: { userId: string | null } }
): Promise<{ orderId: string; decision: string }> {
  const d = db as unknown as M;
  const order = (await d.order.findUnique({ where: { id: input.orderId } })) as SealedOrder | null;
  if (!order || order.workspaceId !== input.workspaceId) throw new NotFoundError("Order");
  const revs = (await d.orderRevision.findMany({ where: { orderId: order.id, version: input.version } })) as Array<{ id: string; kind: string; diff: unknown; omsState: string | null }>;
  const req = revs[0];
  if (!req || !["AMEND_REQUEST", "CANCEL_REQUEST"].includes(req.kind)) throw new AppError("Change request not found", 404, "CHANGE_REQUEST_NOT_FOUND");
  if (!["PENDING", "NOTE_SENT", "NEEDS_STAFF"].includes(String(req.omsState))) throw new AppError("Change request already resolved", 409, "CHANGE_REQUEST_RESOLVED");

  const diff = (Array.isArray(req.diff) ? req.diff : []) as FieldDiff[];
  if (input.decision === "APPLIED") {
    if (req.kind === "CANCEL_REQUEST") {
      assertOrderTransition(order.status as never, "CANCELLED");
      await d.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    } else {
      const data: Record<string, unknown> = {};
      for (const x of diff) if (x.field !== "items") data[x.field] = x.to;
      if (Object.keys(data).length > 0) await d.order.update({ where: { id: order.id }, data });
    }
  }
  await d.orderRevision.update({ where: { id: req.id }, data: { omsState: input.decision } });
  const kind = input.decision === "REJECTED" ? "AMEND_REJECTED" : req.kind === "CANCEL_REQUEST" ? "CANCEL_APPLIED" : "AMEND_APPLIED";
  await d.orderRevision.create({
    data: {
      workspaceId: order.workspaceId,
      orderId: order.id,
      version: await nextVersion(db, order.id),
      kind,
      snapshot: {},
      diff: JSON.parse(JSON.stringify(diff)),
      evidence: [],
      actor: input.actor.userId ? `user:${input.actor.userId}` : "system",
      omsState: input.decision,
    },
  });
  void publishRealtime(db as never, { workspaceId: order.workspaceId, type: "order.updated", conversationId: order.conversationId ?? undefined, entityId: order.id });
  return { orderId: order.id, decision: input.decision };
}
