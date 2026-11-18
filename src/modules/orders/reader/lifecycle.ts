import { randomId } from "@/core/crypto";
import { childLogger } from "@/core/logger";
import { makeEvent, eventBus } from "@/core/events/bus";
import { publishRealtime } from "@/modules/realtime/events";
import { calculateCartPricing } from "@/modules/orders/pricing";
import { assertOrderTransition } from "@/modules/orders/state-machine";
import type { Db } from "@/modules/jobs/service";
import type { VerifiedReading } from "./verify";

const log = childLogger("order-reader");

/**
 * دورة الطلب من القراءة (الحزمة 1.4) — الجدول §7.6 من خطة قارئ الطلب.
 *
 * - `COMPLETE` وما في طلب مفتوح ← طلب جديد (`NEW` أو `CONFIRMATION_PENDING` إذا في أسباب مراجعة).
 * - `COMPLETE` وفي طلب مفتوح ← تحديث بمكانه مع `OrderRevision` بالفرق (وما بنستبدل حقل ثبّته موظف).
 * - `CANCELLED` ← إلغاء الطلب المفتوح. `COLLECTING` ← الطلب المفتوح بيرجع `CONFIRMATION_PENDING` (ما منحذف طلب).
 * - بهالحزمة: ولا إرسال لبرّا (الـ OMS · تيليجرام · رسالة للعميل) — التثبيت بيغيّر الحالة بس.
 * - طلب مثبّت + طلب تعديل (`AMEND_LAST`) = الحزمة 1.6 (هون بيتخطّى).
 */
export interface ApplyReadingInput {
  workspaceId: string;
  conversationId: string;
  customerId: string;
  verified: VerifiedReading;
  readVersion: number;
  orderSettleMinutes: number;
  now: Date;
}

export type ApplyOutcome =
  | { action: "NONE"; reason: string }
  | { action: "CREATED"; orderId: string; status: string }
  | { action: "UPDATED"; orderId: string; changed: string[] }
  | { action: "SETTLE_EXTENDED"; orderId: string }
  | { action: "CANCELLED"; orderId: string }
  | { action: "PENDING"; orderId: string }
  /** طلب مثبّت: تعديل/إلغاء عبر مسار §10.3 (محلي أو ملاحظة للـ OMS + بند «يحتاجك»). */
  | { action: "CHANGE"; detail: import("./amend").AmendOutcome };

type Row = Record<string, unknown>;
type OpenOrder = {
  id: string;
  status: string;
  readVersion: number;
  recipientName: string | null;
  recipientPhone: string | null;
  recipientAltPhone: string | null;
  deliveryAddress: string | null;
  province: string | null;
  settleAt: Date | null;
  items?: Array<{ productId: string; quantity: number }>;
};

const OPEN = ["NEW", "CONFIRMATION_PENDING"];

/** أسباب المراجعة: كل `flag` من المدقّق + الناقص + منتج غير محسوم. */
export function computeReviewReasons(v: VerifiedReading): string[] {
  const out = new Set<string>(v.flags);
  if (v.missing.length > 0) out.add("MISSING_FIELDS");
  if (v.unresolved.length > 0) out.add("PRODUCT_UNRESOLVED");
  return [...out];
}

export interface FieldDiff {
  field: string;
  from: unknown;
  to: unknown;
}

const itemsKey = (items: Array<{ productId: string; quantity: number | null }>) =>
  items
    .map((i) => `${i.productId}:${i.quantity ?? 0}`)
    .sort()
    .join("|");

export function diffOrder(order: OpenOrder, v: VerifiedReading): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const cmp = (field: string, from: string | null, to: string | null) => {
    if (to && (from ?? "") !== to) diffs.push({ field, from, to });
  };
  cmp("recipientName", order.recipientName, v.recipient.name);
  cmp("recipientPhone", order.recipientPhone, v.recipient.phone);
  cmp("recipientAltPhone", order.recipientAltPhone, v.recipient.altPhone);
  cmp("deliveryAddress", order.deliveryAddress, v.recipient.address);
  cmp("province", order.province, v.recipient.province);
  const newItems = v.items.filter((i) => i.quantity && i.quantity > 0);
  if (newItems.length > 0 && itemsKey(order.items ?? []) !== itemsKey(newItems)) {
    diffs.push({
      field: "items",
      from: (order.items ?? []).map((i) => ({ productId: i.productId, quantity: i.quantity })),
      to: newItems.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    });
  }
  return diffs;
}

export async function applyReading(db: Db, input: ApplyReadingInput): Promise<ApplyOutcome> {
  const outcome = await applyCore(db, input);
  await afterApply(db, input, outcome);
  return outcome;
}

/** تعديل/إلغاء على آخر طلب مثبّت (الحزمة 1.6). */
async function sealedChange(db: Db, input: ApplyReadingInput, kind: "AMEND" | "CANCEL"): Promise<ApplyOutcome> {
  const { requestChangeOnSealedOrder } = await import("./amend");
  const r = await requestChangeOnSealedOrder(db, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    kind,
    actor: { userId: null },
    verified: input.verified,
  });
  return r.action === "NONE" ? { action: "NONE", reason: r.reason } : { action: "CHANGE", detail: r };
}

const HANDOFF_REASON: Record<string, "CUSTOMER_REQUEST" | "COMPLAINT" | "PAYMENT_ISSUE" | "MANUAL"> = {
  CUSTOMER_REQUEST: "CUSTOMER_REQUEST",
  COMPLAINT: "COMPLAINT",
  PAYMENT_ISSUE: "PAYMENT_ISSUE",
  OTHER: "MANUAL",
};

/**
 * بعد التطبيق (best-effort — فشلها ما بيأثّر على القراءة ولا الطلب):
 *  - `needsHuman` أو `AI_CLAIMED_NO_ORDER` ← بند «يحتاجك» **بلا تغيير `aiState`** (الوكيل بيكمّل يرد).
 *  - ملف العميل: آخر قيمة متحقق منها بتغلب (مع سطر تدقيق) — مش «لا تستبدل».
 */
async function afterApply(db: Db, input: ApplyReadingInput, outcome: ApplyOutcome): Promise<void> {
  const v = input.verified;
  try {
    const claimed = v.flags.includes("AI_CLAIMED_NO_ORDER");
    if (v.needsHuman.value || claimed) {
      const { createHandoff } = await import("@/modules/handoffs/handoff-service");
      await createHandoff(db as never, {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        customerId: input.customerId,
        reason: v.needsHuman.value ? HANDOFF_REASON[String(v.needsHuman.reason)] ?? "MANUAL" : "MANUAL",
        metadata: { source: "order_reader", needsHuman: v.needsHuman.value, aiClaimedNoOrder: claimed },
      });
    }
  } catch (err) {
    log.warn({ conversationId: input.conversationId, error: err instanceof Error ? err.message : String(err) }, "reader_handoff_failed");
  }
  try {
    if (v.stage === "COMPLETE" && ["CREATED", "UPDATED", "SETTLE_EXTENDED"].includes(outcome.action)) {
      await updateCustomerFromReading(db, input);
    }
  } catch (err) {
    log.warn({ customerId: input.customerId, error: err instanceof Error ? err.message : String(err) }, "reader_customer_update_failed");
  }
}

export async function updateCustomerFromReading(db: Db, input: ApplyReadingInput): Promise<string[]> {
  const d = db as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
  const r = input.verified.recipient;
  const customer = (await d.customer.findUnique({ where: { id: input.customerId } })) as (Record<string, unknown> & { workspaceId: string }) | null;
  if (!customer || customer.workspaceId !== input.workspaceId) return [];
  const data: Record<string, unknown> = {};
  const pick = (field: string, value: string | null) => {
    if (value && (customer[field] ?? null) !== value) data[field] = value;
  };
  pick("name", r.name);
  pick("phone", r.phone);
  pick("address", r.address);
  pick("province", r.province);
  pick("city", r.city);
  const fields = Object.keys(data);
  if (fields.length === 0) return [];
  await d.customer.update({ where: { id: input.customerId }, data });
  const { recordAudit } = await import("@/modules/audit/service");
  await recordAudit(db as never, {
    workspaceId: input.workspaceId,
    action: "customer.updated_from_reading",
    entityType: "Customer",
    entityId: input.customerId,
    metadata: { fields },
  }).catch(() => undefined);
  return fields;
}

async function applyCore(db: Db, input: ApplyReadingInput): Promise<ApplyOutcome> {
  const d = db as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
  const { verified: v } = input;

  const open = (await d.order.findFirst({
    where: { workspaceId: input.workspaceId, conversationId: input.conversationId, status: { in: OPEN } },
    orderBy: { createdAt: "desc" },
  })) as OpenOrder | null;
  if (open) {
    open.items = (await d.orderItem.findMany({ where: { orderId: open.id }, select: { productId: true, quantity: true } })) as Array<{ productId: string; quantity: number }>;
  }

  const declined = v.agreement.state === "DECLINED" || v.cancelRequested || v.stage === "CANCELLED";

  // ── إلغاء ──
  if (declined) {
    if (!open) return sealedChange(db, input, "CANCEL");
    return cancelOpenOrder(db, input, open);
  }

  // ── ما في طلب جاهز ──
  if (v.stage !== "COMPLETE") {
    if (open && v.stage === "COLLECTING" && open.status === "NEW") {
      return markPending(db, input, open, ["MISSING_FIELDS"]);
    }
    return { action: "NONE", reason: `STAGE_${v.stage}` };
  }

  // طلب مثبّت + تعديل (§10.3)
  if (!open && v.relation === "AMEND_LAST") return sealedChange(db, input, "AMEND");

  const lines = v.items.filter((i) => i.productId && i.quantity && i.quantity > 0);
  if (lines.length === 0) return { action: "NONE", reason: "NO_RESOLVED_ITEMS" };

  if (!open) return createOrder(db, input, lines);
  return updateOrder(db, input, open, lines);
}

// ───────────────────────── إنشاء ─────────────────────────

async function createOrder(
  db: Db,
  input: ApplyReadingInput,
  lines: VerifiedReading["items"]
): Promise<ApplyOutcome> {
  const { verified: v } = input;
  const d = db as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;

  // أسعار من قاعدة البيانات — ما بنثق بسعر الموديل ولا بنسخة المدقّق.
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const products = (await d.product.findMany({
    where: { id: { in: productIds }, workspaceId: input.workspaceId, isActive: true, isArchived: false },
    select: { id: true, name: true, sku: true, price: true, currency: true },
  })) as Array<{ id: string; name: string; sku: string | null; price: unknown; currency: string }>;
  const byId = new Map(products.map((p) => [p.id, p]));
  if (lines.some((l) => !byId.has(l.productId))) return { action: "NONE", reason: "PRODUCT_NOT_ACTIVE" };
  const breakdown = await calculateCartPricing(db as never, {
    workspaceId: input.workspaceId,
    items: lines.map((l) => ({ price: byId.get(l.productId)!.price as never, quantity: l.quantity as number, currency: byId.get(l.productId)!.currency })),
    province: v.recipient.province,
  });

  const reasons = computeReviewReasons(v);
  if (!breakdown.deliveryAvailable && !reasons.includes("AREA_NOT_SERVED")) reasons.push("AREA_NOT_SERVED");
  const status = reasons.length > 0 ? "CONFIRMATION_PENDING" : "NEW";
  // الـ OMS بيرفض طلب بلا اسم (ORDER_MISSING_NAME): الاسم الناقص بيتعوّض من ملف العميل (اسم البروفايل).
  const profile = (await d.customer.findUnique({ where: { id: input.customerId }, select: { name: true } })) as { name?: string | null } | null;
  const recipientName = v.recipient.name ?? profile?.name ?? null;

  const existingCount = (await (d.order.count as (a: unknown) => Promise<number>)({
    where: { workspaceId: input.workspaceId, conversationId: input.conversationId, idempotencyKey: { startsWith: `reader:${input.workspaceId}:${input.conversationId}:` } },
  })) as number;
  const n = existingCount + 1;
  const idempotencyKey = `reader:${input.workspaceId}:${input.conversationId}:${n}`;
  const dup = (await d.order.findUnique({ where: { idempotencyKey } })) as { id: string; status: string } | null;
  if (dup) return { action: "NONE", reason: "ALREADY_CREATED" };

  const settleAt =
    status === "NEW" ? new Date(new Date(v.lastCustomerMessageAt ?? input.now).getTime() + input.orderSettleMinutes * 60_000) : null;
  const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${randomId(3).toUpperCase()}`;
  const agreement = v.agreement.state === "EXPLICIT" || v.agreement.state === "IMPLICIT" ? v.agreement.state : null;

  const write = async (tx: Db): Promise<{ id: string }> => {
    const t = tx as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
    const created = (await t.order.create({
      data: {
        workspaceId: input.workspaceId,
        orderNumber,
        customerId: input.customerId,
        conversationId: input.conversationId,
        status,
        confirmationStatus: "PENDING",
        deliveryAddress: v.recipient.address,
        recipientName,
        recipientPhone: v.recipient.phone,
        recipientAltPhone: v.recipient.altPhone,
        province: v.recipient.province,
        notes: v.notes,
        subtotal: breakdown.subtotal,
        discount: breakdown.discount,
        deliveryFee: breakdown.deliveryFee,
        total: breakdown.total,
        currency: breakdown.currency,
        source: "AI",
        idempotencyKey,
        settleAt,
        readVersion: input.readVersion,
        reviewReasons: reasons,
        agreement,
        items: {
          create: lines.map((l, idx) => ({
            productId: l.productId,
            productNameSnapshot: byId.get(l.productId)!.name,
            skuSnapshot: byId.get(l.productId)!.sku,
            unitPrice: breakdown.lines[idx].unitPrice,
            quantity: l.quantity,
            subtotal: breakdown.lines[idx].subtotal,
          })),
        },
      },
    })) as { id: string };
    await t.orderRevision.create({
      data: {
        workspaceId: input.workspaceId,
        orderId: created.id,
        version: 1,
        kind: "READ",
        snapshot: snapshotOf(v, breakdown, status),
        diff: [],
        evidence: [...new Set(lines.flatMap((l) => l.evidence))],
        actor: "reader",
      },
    });
    return created;
  };
  const anyDb = db as unknown as { $transaction?: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };
  const order = typeof anyDb.$transaction === "function" ? await anyDb.$transaction(write) : await write(db);

  await eventBus.publish(makeEvent("OrderCreated", input.workspaceId, { orderId: order.id, total: breakdown.total, customerId: input.customerId, conversationId: input.conversationId })).catch(() => undefined);
  void publishRealtime(db as never, { workspaceId: input.workspaceId, type: "order.created", conversationId: input.conversationId, entityId: order.id });
  log.info({ orderId: order.id, status, reasons }, "reader_order_created");
  return { action: "CREATED", orderId: order.id, status };
}

function snapshotOf(v: VerifiedReading, breakdown: { subtotal: number; discount: number; deliveryFee: number; total: number; currency: string }, status: string) {
  return JSON.parse(
    JSON.stringify({
      status,
      items: v.items.map((i) => ({ productId: i.productId, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice })),
      recipient: { name: v.recipient.name, phone: v.recipient.phone, altPhone: v.recipient.altPhone, province: v.recipient.province, address: v.recipient.address },
      totals: breakdown,
    })
  );
}

// ───────────────────────── تحديث ─────────────────────────

async function staffProtectedFields(db: Db, orderId: string): Promise<Set<string>> {
  const d = db as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
  const revs = (await d.orderRevision.findMany({ where: { orderId, kind: "STAFF_EDIT" } })) as Array<{ diff: unknown }>;
  const out = new Set<string>();
  for (const r of revs) for (const x of (Array.isArray(r.diff) ? r.diff : []) as Array<{ field?: string }>) if (x.field) out.add(x.field);
  return out;
}

async function updateOrder(
  db: Db,
  input: ApplyReadingInput,
  open: OpenOrder,
  lines: VerifiedReading["items"]
): Promise<ApplyOutcome> {
  const { verified: v } = input;
  const d = db as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;

  const protectedFields = await staffProtectedFields(db, open.id);
  const rawDiff = diffOrder(open, v);
  const diffs = rawDiff.filter((x) => !protectedFields.has(x.field));
  const reasons = computeReviewReasons(v);
  if (rawDiff.some((x) => protectedFields.has(x.field))) reasons.push("CHANGED_AFTER_STAFF_EDIT");

  if (diffs.length === 0) {
    // ما في فرق: بس مدّد المهلة إذا في رسالة عميل أحدث من آخر تحديث للمهلة.
    const status = reasons.length > 0 ? "CONFIRMATION_PENDING" : "NEW";
    const data: Record<string, unknown> = { reviewReasons: reasons };
    if (status !== open.status) {
      assertOrderTransition(open.status as never, status as never);
      data.status = status;
    }
    let extended = false;
    if (status === "NEW" && v.lastCustomerMessageAt) {
      const newSettle = new Date(new Date(v.lastCustomerMessageAt).getTime() + input.orderSettleMinutes * 60_000);
      if (!open.settleAt || newSettle > new Date(open.settleAt)) {
        data.settleAt = newSettle;
        extended = true;
      }
    }
    if (status === "CONFIRMATION_PENDING") data.settleAt = null;
    await d.order.update({ where: { id: open.id }, data });
    return extended ? { action: "SETTLE_EXTENDED", orderId: open.id } : { action: "NONE", reason: "NO_DIFF" };
  }

  const itemsChanged = diffs.some((x) => x.field === "items");
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const products = itemsChanged
    ? ((await d.product.findMany({
        where: { id: { in: productIds }, workspaceId: input.workspaceId, isActive: true, isArchived: false },
        select: { id: true, name: true, sku: true, price: true, currency: true },
      })) as Array<{ id: string; name: string; sku: string | null; price: unknown; currency: string }>)
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  if (itemsChanged && lines.some((l) => !byId.has(l.productId))) return { action: "NONE", reason: "PRODUCT_NOT_ACTIVE" };

  const province = protectedFields.has("province") ? open.province : v.recipient.province ?? open.province;
  let breakdown: Awaited<ReturnType<typeof calculateCartPricing>> | null = null;
  if (itemsChanged || diffs.some((x) => x.field === "province")) {
    const cartLines = itemsChanged
      ? lines
      : ((open.items ?? []) as Array<{ productId: string; quantity: number }>).map((i) => ({ productId: i.productId, quantity: i.quantity }));
    const priceRows = itemsChanged
      ? products
      : ((await d.product.findMany({
          where: { id: { in: cartLines.map((l) => l.productId) }, workspaceId: input.workspaceId },
          select: { id: true, price: true, currency: true },
        })) as Array<{ id: string; price: unknown; currency: string }>);
    const priceById = new Map(priceRows.map((p) => [p.id, p]));
    breakdown = await calculateCartPricing(db as never, {
      workspaceId: input.workspaceId,
      items: cartLines.map((l) => ({ price: priceById.get(l.productId)!.price as never, quantity: l.quantity as number, currency: priceById.get(l.productId)!.currency })),
      province,
    });
    if (!breakdown.deliveryAvailable && !reasons.includes("AREA_NOT_SERVED")) reasons.push("AREA_NOT_SERVED");
  }

  const nextStatus = reasons.length > 0 ? "CONFIRMATION_PENDING" : "NEW";
  const set = (f: string) => diffs.find((x) => x.field === f)?.to;
  const data: Record<string, unknown> = {
    readVersion: input.readVersion,
    reviewReasons: reasons,
    settleAt:
      nextStatus === "NEW"
        ? new Date(new Date(v.lastCustomerMessageAt ?? input.now).getTime() + input.orderSettleMinutes * 60_000)
        : null,
  };
  if (nextStatus !== open.status) {
    assertOrderTransition(open.status as never, nextStatus as never);
    data.status = nextStatus;
  }
  for (const f of ["recipientName", "recipientPhone", "recipientAltPhone", "deliveryAddress", "province"] as const) {
    const to = set(f);
    if (to !== undefined) data[f] = to;
  }
  if (breakdown) Object.assign(data, { subtotal: breakdown.subtotal, discount: breakdown.discount, deliveryFee: breakdown.deliveryFee, total: breakdown.total, currency: breakdown.currency });

  const lastRev = (await d.orderRevision.findMany({ where: { orderId: open.id }, orderBy: { version: "desc" }, take: 1 })) as Array<{ version: number }>;
  const version = (lastRev[0]?.version ?? 0) + 1;

  const write = async (tx: Db) => {
    const t = tx as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
    await t.order.update({ where: { id: open.id }, data });
    if (itemsChanged && breakdown) {
      await t.orderItem.deleteMany({ where: { orderId: open.id } });
      for (const [idx, l] of lines.entries()) {
        await t.orderItem.create({
          data: {
            orderId: open.id,
            productId: l.productId,
            productNameSnapshot: byId.get(l.productId)!.name,
            skuSnapshot: byId.get(l.productId)!.sku,
            unitPrice: breakdown.lines[idx].unitPrice,
            quantity: l.quantity,
            subtotal: breakdown.lines[idx].subtotal,
          },
        });
      }
    }
    await t.orderRevision.create({
      data: {
        workspaceId: input.workspaceId,
        orderId: open.id,
        version,
        kind: "READ",
        snapshot: snapshotOf(v, breakdown ?? { subtotal: 0, discount: 0, deliveryFee: 0, total: 0, currency: "" }, nextStatus),
        diff: JSON.parse(JSON.stringify(diffs)),
        evidence: [...new Set(lines.flatMap((l) => l.evidence))],
        actor: "reader",
      },
    });
  };
  const anyDb = db as unknown as { $transaction?: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };
  if (typeof anyDb.$transaction === "function") await anyDb.$transaction(write);
  else await write(db);

  void publishRealtime(db as never, { workspaceId: input.workspaceId, type: "order.updated", conversationId: input.conversationId, entityId: open.id });
  return { action: "UPDATED", orderId: open.id, changed: diffs.map((x) => x.field) };
}

// ───────────────────────── إلغاء · رجوع للمراجعة ─────────────────────────

async function cancelOpenOrder(db: Db, input: ApplyReadingInput, open: OpenOrder): Promise<ApplyOutcome> {
  const d = db as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
  assertOrderTransition(open.status as never, "CANCELLED");
  const lastRev = (await d.orderRevision.findMany({ where: { orderId: open.id }, orderBy: { version: "desc" }, take: 1 })) as Array<{ version: number }>;
  const write = async (tx: Db) => {
    const t = tx as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
    await t.order.update({ where: { id: open.id }, data: { status: "CANCELLED", settleAt: null, readVersion: input.readVersion } });
    await t.orderRevision.create({
      data: {
        workspaceId: input.workspaceId,
        orderId: open.id,
        version: (lastRev[0]?.version ?? 0) + 1,
        kind: "CANCEL_APPLIED",
        snapshot: { status: "CANCELLED" },
        diff: [{ field: "status", from: open.status, to: "CANCELLED" }],
        evidence: [],
        actor: "reader",
      },
    });
  };
  const anyDb = db as unknown as { $transaction?: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };
  if (typeof anyDb.$transaction === "function") await anyDb.$transaction(write);
  else await write(db);
  void publishRealtime(db as never, { workspaceId: input.workspaceId, type: "order.updated", conversationId: input.conversationId, entityId: open.id });
  return { action: "CANCELLED", orderId: open.id };
}

async function markPending(db: Db, input: ApplyReadingInput, open: OpenOrder, reasons: string[]): Promise<ApplyOutcome> {
  const d = db as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
  assertOrderTransition(open.status as never, "CONFIRMATION_PENDING");
  await d.order.update({ where: { id: open.id }, data: { status: "CONFIRMATION_PENDING", settleAt: null, reviewReasons: reasons, readVersion: input.readVersion } });
  void publishRealtime(db as never, { workspaceId: input.workspaceId, type: "order.updated", conversationId: input.conversationId, entityId: open.id });
  return { action: "PENDING", orderId: open.id };
}
