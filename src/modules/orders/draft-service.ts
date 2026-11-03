import type { Prisma, OrderDraftState } from "@prisma/client";
import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { assertDraftTransition } from "./state-machine";
import { inferProvince, normalizePhone } from "./primitives";
import { resolveProduct, type ResolvableProduct } from "./primitives";
import {
  DEFAULT_ORDER_FIELDS,
  normalizeOrderFields,
  type OrderFieldKey,
} from "./required-fields";

export const REQUIRED_DRAFT_FIELDS = ["product", "quantity", "phone", "address"] as const;
export type RequiredDraftField = OrderFieldKey;

export interface DraftExtractionInput {
  productName?: string | null;
  productId?: string | null;
  quantity?: number | null;
  /** P22 — عدة منتجات في رسالة واحدة (سلة). */
  items?: {
    productName?: string | null;
    productId?: string | null;
    quantity?: number | null;
    variantId?: string | null;
  }[];
  customerName?: string | null;
  phone?: string | null;
  rawAddress?: string | null;
  province?: string | null;
  notes?: string | null;
  confidence?: Record<string, number>;
}

/** عنصر سلة داخل مسودة الطلب (يُخزَّن JSON في OrderDraft.items). */
export interface DraftItem {
  productId: string | null;
  productName: string;
  variantId: string | null;
  quantity: number | null;
}

/**
 * P22 — يقرأ سلة المسودة. توافق خلفي: المسودات القديمة (بلا items) ترجع
 * منتجها المفرد. اسم المنتج قد يكون فارغًا بالمسودات القديمة (productId فقط) —
 * مسار إنشاء الطلب يجيب الاسم من قاعدة البيانات.
 */
export function parseDraftItems(draft: {
  items?: unknown;
  productId?: string | null;
  productName?: string | null;
  variantId?: string | null;
  quantity?: number | null;
}): DraftItem[] {
  let raw: unknown = draft.items;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = [];
    }
  }
  const items: DraftItem[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const o = entry as Record<string, unknown>;
      const productId = typeof o.productId === "string" && o.productId ? o.productId : null;
      const name = typeof o.productName === "string" ? o.productName.trim() : "";
      if (!productId && !name) continue;
      const q = typeof o.quantity === "number" && Number.isFinite(o.quantity) ? Math.trunc(o.quantity) : null;
      items.push({
        productId,
        productName: name,
        variantId: typeof o.variantId === "string" && o.variantId ? o.variantId : null,
        quantity: q && q > 0 ? q : null,
      });
      if (items.length >= 20) break;
    }
  }
  if (items.length === 0 && draft.productId) {
    items.push({
      productId: draft.productId,
      productName: (draft.productName ?? "").trim(),
      variantId: draft.variantId ?? null,
      quantity: draft.quantity && draft.quantity > 0 ? draft.quantity : null,
    });
  }
  return items;
}

/** دمج عنصر جديد: نفس المنتج = تحديث الكمية (آخر قيمة صريحة تفوز) لا تكرار. */
function mergeDraftItems(existing: DraftItem[], incoming: DraftItem[]): DraftItem[] {
  const result = existing.map((i) => ({ ...i }));
  for (const item of incoming) {
    const idx = result.findIndex(
      (x) =>
        (item.productId && x.productId === item.productId) ||
        (!item.productId && item.productName && x.productName === item.productName)
    );
    if (idx >= 0) {
      const prev = result[idx];
      result[idx] = {
        productId: item.productId ?? prev.productId,
        productName: item.productName || prev.productName,
        variantId: item.variantId ?? prev.variantId,
        quantity: item.quantity ?? prev.quantity,
      };
    } else {
      result.push(item);
    }
    if (result.length >= 20) break;
  }
  return result.slice(0, 20);
}

export async function getOrCreateDraft(db: Db, workspaceId: string, conversationId: string, customerId: string) {
  let draft = await db.orderDraft.findUnique({ where: { conversationId } });
  if (draft) return draft;

  // P18 — زبون قديم عنده هاتف/عنوان بملفه: نبدأ المسودة ببياناته المعروفة
  // بدل ما نطلبها منه من جديد كل طلب. الحقول الناقصة تبقى ناقصة (لا اختراع).
  const customer = await db.customer.findFirst({
    where: { id: customerId, workspaceId },
    select: { name: true, phone: true, address: true, province: true },
  });
  const rawAddress = customer?.address ?? null;
  const province = customer?.province ?? (rawAddress ? inferProvince(rawAddress) : null);
  // هاتف الملف ممكن يكون قديمًا بصيغة غير قانونية — لا نمرّره للمسودة إلا صالحًا.
  const profilePhone = customer?.phone ? normalizePhone(customer.phone) : null;
  const seed = {
    customerName: customer?.name ?? null,
    phone: profilePhone?.valid ? profilePhone.canonical : null,
    rawAddress,
    province,
  };

  try {
    draft = await db.orderDraft.create({
      data: {
        workspaceId,
        conversationId,
        customerId,
        state: "COLLECTING",
        ...seed,
        items: [] as Prisma.InputJsonValue,
        missingFields: computeMissingFields({
          productId: null,
          quantity: null,
          phone: seed.phone,
          rawAddress: seed.rawAddress,
          province: seed.province,
        }),
      },
    });
  } catch (err) {
    // سباق رسالتين متزامنتين على نفس المحادثة: القيد الفريد (conversationId)
    // يحسم، ونكمل على المسودة الفائزة بدل ما نفشل الرد.
    if ((err as { code?: string }).code !== "P2002") throw err;
    const winner = await db.orderDraft.findUnique({ where: { conversationId } });
    if (!winner) throw err;
    return winner;
  }
  await eventBus.publish(makeEvent("OrderDraftCreated", workspaceId, { draftId: draft.id, conversationId }));
  return draft;
}

export async function getOwnedDraft(db: Db, workspaceId: string, draftId: string) {
  const draft = await db.orderDraft.findUnique({ where: { id: draftId } });
  if (!draft || draft.workspaceId !== workspaceId) throw new NotFoundError("Order draft");
  return draft;
}

/**
 * Merges extracted data into the persisted draft. Prices are NEVER accepted
 * here — unit price is resolved from Product DB at pricing time. Phone is
 * normalized; invalid phones are dropped (AI cannot inject garbage).
 */
export async function updateDraftFromExtraction(
  db: Db,
  params: {
    workspaceId: string;
    conversationId: string;
    customerId: string;
    extraction: DraftExtractionInput;
    source: string;
    /** Scioping of the page catalog: undefined = legacy (everything), [] or a list = confined to these ids. */
    allowedProductIds?: string[];
  }
) {
  const draft = await getOrCreateDraft(db, params.workspaceId, params.conversationId, params.customerId);
  if (draft.state === "CANCELLED" || draft.state === "CONVERTED") {
    throw new AppError("Draft is closed", 422, "DRAFT_CLOSED");
  }

  const data: Prisma.OrderDraftUncheckedUpdateInput = {};

  // P22 — سلة متعددة المنتجات: ندمج كل منتج مذكور (items) أو المفرد القديم.
  const existingItems = parseDraftItems(draft);
  const rawItems =
    Array.isArray(params.extraction.items) && params.extraction.items.length > 0
      ? params.extraction.items
      : params.extraction.productName || params.extraction.productId
        ? [
            {
              productName: params.extraction.productName,
              productId: params.extraction.productId,
              quantity: params.extraction.quantity,
              variantId: null as string | null,
            },
          ]
        : [];

  if (rawItems.length > 0) {
    // اسم المنتج يُحلّ من قاعدة البيانات (لا ثقة بنص الموديل)، ومعرّف المنتج
    // يُتحقق من المساحة/النشاط/الكتالوج. كل شيء خارجها = كأنه ما انذكر.
    const allowed = params.allowedProductIds;
    const needsName = rawItems.some((i) => !i.productId && i.productName);
    const catalogProducts = needsName
      ? ((await db.product.findMany({
          where: {
            workspaceId: params.workspaceId,
            isActive: true,
            isArchived: false,
            ...(allowed ? { id: { in: allowed } } : {}),
          },
        })) as unknown as ResolvableProduct[])
      : [];
    const withAliases = catalogProducts.map((p) => ({
      ...p,
      aliases: [p.name, ...(((p as unknown as { tags?: string[] }).tags ?? []).filter((t) => t.length > 2))],
    }));
    const idList = [...new Set(rawItems.map((i) => i.productId).filter((v): v is string => Boolean(v)))];
    const ownedById = new Map(
      (idList.length
        ? await db.product.findMany({
            where: {
              id: { in: idList },
              workspaceId: params.workspaceId,
              isActive: true,
              isArchived: false,
              ...(allowed ? { id: { in: allowed } } : {}),
            },
            select: { id: true, name: true },
          })
        : []
      ).map((p) => [p.id, p] as const)
    );

    const incoming: DraftItem[] = [];
    for (const raw of rawItems) {
      let productId: string | null = null;
      let productName = "";
      if (raw.productId) {
        const owned = ownedById.get(raw.productId);
        if (!owned) continue;
        productId = owned.id;
        productName = owned.name;
      } else if (raw.productName) {
        const resolution = resolveProduct(raw.productName, withAliases);
        if (resolution.status === "AMBIGUOUS") {
          // Ambiguity → ask, never guess.
          await eventBus.publish(makeEvent("OrderDraftUpdated", params.workspaceId, { draftId: draft.id, ambiguous: true }));
          return { draft, ambiguousCandidates: resolution.candidates!.map((c) => c.name) };
        }
        if (resolution.status !== "RESOLVED") continue; // NOT_FOUND: لا نضيف منتجًا وهميًا
        productId = resolution.product!.id;
        productName = resolution.product!.name;
      } else {
        continue;
      }
      const quantity = raw.quantity && raw.quantity > 0 ? Math.trunc(raw.quantity) : null;
      incoming.push({ productId, productName, variantId: raw.variantId ?? null, quantity });
    }

    const merged = mergeDraftItems(existingItems, incoming);
    applyCartToDraftData(data, merged);
  } else if (params.extraction.quantity && params.extraction.quantity > 0 && existingItems.length > 0) {
    // كمية بلا اسم منتج ("بدي 3" بعد «بدي ماء الكمأة») = تحديث آخر عنصر
    // بالسلّة (السياق الحالي)، لا إنشاء عنصر بلا منتج.
    const qty = Math.trunc(params.extraction.quantity);
    const items = existingItems.map((item, idx) =>
      idx === existingItems.length - 1 ? { ...item, quantity: qty } : item
    );
    applyCartToDraftData(data, items);
  }

  if (params.extraction.customerName && !draft.customerName) data.customerName = params.extraction.customerName;
  if (params.extraction.notes) data.notes = params.extraction.notes;

  if (params.extraction.phone) {
    const phone = normalizePhone(params.extraction.phone);
    if (phone.valid) data.phone = phone.canonical;
  }
  if (params.extraction.rawAddress) {
    data.rawAddress = params.extraction.rawAddress;
  }
  if (params.extraction.province) {
    data.province = params.extraction.province;
  } else if (params.extraction.rawAddress) {
    // Deterministic known-province mapping from the raw address (spec §8).
    const { inferProvince } = await import("./primitives");
    const inferred = inferProvince(params.extraction.rawAddress);
    if (inferred) data.province = inferred;
  }
  if (params.extraction.confidence) {
    data.entityConfidence = params.extraction.confidence as Prisma.InputJsonValue;
  }

  const updated = await db.orderDraft.update({ where: { id: draft.id }, data });

  // Deterministic missing-field computation.
  let refreshed = (await db.orderDraft.findUniqueOrThrow({ where: { id: draft.id } })) as typeof draft;

  // P18 — زبون قديم بملفه هاتف/عنوان/اسم: نكمل الناقص تلقائيًا بدل ما نطلب
  // منه نفس المعلومات كل طلب. لا نستبدل قيمة موجودة بالمسودة، ولا نخترع قيمة.
  if (!refreshed.phone || !refreshed.rawAddress || !refreshed.province || !refreshed.customerName) {
    const customer = await db.customer.findFirst({
      where: { id: params.customerId, workspaceId: params.workspaceId },
      select: { name: true, phone: true, address: true, province: true },
    });
    if (customer) {
      const backfill: Prisma.OrderDraftUncheckedUpdateInput = {};
      if (!refreshed.phone && customer.phone) {
        const normalized = normalizePhone(customer.phone);
        if (normalized.valid && normalized.canonical) backfill.phone = normalized.canonical;
      }
      if (!refreshed.rawAddress && customer.address) backfill.rawAddress = customer.address;
      if (!refreshed.province) {
        const source = refreshed.rawAddress ?? customer.address ?? null;
        const province = customer.province ?? (source ? inferProvince(source) : null);
        if (province) backfill.province = province;
      }
      if (!refreshed.customerName && customer.name) backfill.customerName = customer.name;
      if (Object.keys(backfill).length > 0) {
        await db.orderDraft.update({ where: { id: draft.id }, data: backfill });
        refreshed = (await db.orderDraft.findUniqueOrThrow({ where: { id: draft.id } })) as typeof draft;
      }
    }
  }

  // P19 — الحقول المطلوبة تتبع الصفحة (القناة) صاحبة المحادثة، مش إعدادًا
  // عامًا واحدًا لكل المساحات.
  const requiredFields = await getRequiredOrderFields(db, params.workspaceId, params.conversationId);

  const missing = computeMissingFields(refreshed, requiredFields);
  const final = await db.orderDraft.update({
    where: { id: draft.id },
    data: { missingFields: missing },
  });

  await recordAudit(db, {
    workspaceId: params.workspaceId,
    action: "order_draft.updated",
    entityType: "OrderDraft",
    entityId: draft.id,
    metadata: { source: params.source, missing },
  });
  await eventBus.publish(makeEvent("OrderDraftUpdated", params.workspaceId, { draftId: draft.id, missing }));

  // State transition to READY when nothing is missing.
  if (missing.length === 0 && final.state === "COLLECTING") {
    assertDraftTransition(final.state, "READY");
    const ready = await db.orderDraft.update({ where: { id: draft.id }, data: { state: "READY" } });
    // المسودة الجاهزة **ما** بتنرحّل لتلجرام — الترحيل للطلبات فقط (بعد الإنشاء).
    await eventBus.publish(makeEvent("OrderReadyForConfirmation", params.workspaceId, { draftId: draft.id }));
    await eventBus.publish(makeEvent("OrderReadyForConfirmation", params.workspaceId, { draftId: draft.id }));
    return { draft: ready, missingFields: missing, becameReady: true };
  }

  return { draft: final, missingFields: missing };
}

export function computeMissingFields(
  draft: {
    items?: unknown;
    productId: string | null;
    quantity: number | null;
    customerName?: string | null;
    phone: string | null;
    rawAddress: string | null;
    province: string | null;
  },
  requiredFields: readonly string[] = DEFAULT_ORDER_FIELDS
): RequiredDraftField[] {
  const required = new Set(requiredFields);
  const missing: RequiredDraftField[] = [];
  // P22 — الحساب على السلة: منتج/كمية لكل عنصر. مسودة فارغة = الاثنان ناقصان.
  const items = parseDraftItems(draft);
  if (items.length === 0) {
    missing.push("product", "quantity");
  } else {
    if (items.some((i) => !i.productId)) missing.push("product");
    if (items.some((i) => !i.quantity || i.quantity <= 0)) missing.push("quantity");
  }
  if (required.has("phone") && !draft.phone) missing.push("phone");
  if (required.has("address") && !draft.rawAddress && !draft.province) missing.push("address");
  if (required.has("name") && !draft.customerName) missing.push("name");
  return missing;
}

/** مرآة العنصر الأول للحقول المفردة (توافق خلفي/بطاقة/ملخص). */
function applyCartToDraftData(data: Prisma.OrderDraftUncheckedUpdateInput, items: DraftItem[]): void {
  data.items = items as unknown as Prisma.InputJsonValue;
  const first = items[0] ?? null;
  data.productId = first?.productId ?? null;
  data.productName = first?.productName || null;
  data.variantId = first?.variantId ?? null;
  data.quantity = first?.quantity ?? null;
}

/** الحقول المطلوبة لهذه المحادثة حسب صفحتها؛ غياب القناة = الافتراضي. */
export async function getRequiredOrderFields(
  db: Db,
  workspaceId: string,
  conversationId: string
): Promise<OrderFieldKey[]> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { workspaceId: true, channelId: true },
  });
  if (!conversation || conversation.workspaceId !== workspaceId || !conversation.channelId) {
    return [...DEFAULT_ORDER_FIELDS];
  }
  const channel = await db.channel.findUnique({
    where: { id: conversation.channelId },
    select: { workspaceId: true, orderRequiredFields: true },
  });
  if (!channel || channel.workspaceId !== workspaceId) return [...DEFAULT_ORDER_FIELDS];
  return normalizeOrderFields((channel as { orderRequiredFields?: string[] }).orderRequiredFields);
}

/**
 * ملاحظة سلوكية (قرار المالك): المسودة الجاهزة **ما بتنرحّل** لتلجرام.
 * الترحيل يصير مرة واحدة عند إنشاء الطلب الرسمي (order-service).
 */

/**
 * MULTI-ORDER PER CONVERSATION — MANY orders per conversation.
 *
 * A closed draft (CONVERTED/CANCELLED) is recycled, not dead: an explicit
 * new-order request empties the cart and starts collecting the next order
 * in the SAME conversation. Contact info (name/phone/address/province) is
 * intentionally kept so re-ordering stays fast; the product, quantity and
 * notes are cleared. The idempotency key is bumped monotonically so the
 * recycled draft can never be deduped against an older order.
 */
export async function recycleDraftForNewOrder(db: Db, workspaceId: string, draft: {
  id: string;
  state: OrderDraftState;
  orderId: string | null;
  idempotencyKey: string | null;
}) {
  if (draft.state !== "CONVERTED" && draft.state !== "CANCELLED") {
    throw new AppError("Draft is still open", 422, "DRAFT_OPEN");
  }
  const idempotencyKey = nextDraftIdempotencyKey(draft.idempotencyKey, draft.id);
  const recycled = await db.orderDraft.update({
    where: { id: draft.id },
    data: {
      state: "COLLECTING",
      productId: null,
      productName: null,
      variantId: null,
      quantity: null,
      notes: null,
      items: [] as Prisma.InputJsonValue,
      missingFields: ["product", "quantity"],
      entityConfidence: {},
      idempotencyKey,
      orderId: null,
    },
  });
  await recordAudit(db, {
    workspaceId,
    action: "order_draft.recycled",
    entityType: "OrderDraft",
    entityId: draft.id,
    metadata: { previousOrderId: draft.orderId, idempotencyKey },
  });
  await eventBus.publish(makeEvent("OrderDraftUpdated", workspaceId, { draftId: draft.id, recycled: true }));
  return recycled;
}

/** draft:D → draft:D:r1 → draft:D:r2 — monotonic, never colliding. */
function nextDraftIdempotencyKey(current: string | null, draftId: string): string {
  const m = current ? /^(.*):r(\d+)$/.exec(current) : null;
  if (m) return `${m[1]}:r${Number(m[2]) + 1}`;
  return `draft:${draftId}:r1`;
}

export async function setDraftState(db: Db, workspaceId: string, draftId: string, to: OrderDraftState) {
  const draft = await getOwnedDraft(db, workspaceId, draftId);
  assertDraftTransition(draft.state as OrderDraftState, to);
  const updated = await db.orderDraft.update({ where: { id: draftId }, data: { state: to } });
  await recordAudit(db, {
    workspaceId,
    action: "order_draft.state_changed",
    entityType: "OrderDraft",
    entityId: draftId,
    metadata: { from: draft.state, to },
  });
  return updated;
}

export async function cancelDraft(db: Db, ctx: ActorContext, draftId: string) {
  const draft = await setDraftState(db, ctx.workspaceId, draftId, "CANCELLED");
  await eventBus.publish(makeEvent("OrderCancelled", ctx.workspaceId, { draftId, type: "DRAFT" }));
  return draft;
}

/** Deterministic order summary text for the AI to phrase (never prices from AI). */
export function buildDraftSummary(draft: {
  items?: unknown;
  productId?: string | null;
  productName?: string | null;
  quantity: number | null;
  variantId?: string | null;
  phone: string | null;
  rawAddress: string | null;
  province: string | null;
  missingFields: string[];
}): string {
  const lines: string[] = [];
  const items = parseDraftItems(draft);
  if (items.length > 0) {
    lines.push("المنتجات:");
    for (const item of items) {
      const qty = item.quantity ? ` × ${item.quantity}` : "";
      lines.push(`- ${item.productName || "منتج"}${qty}`);
    }
  } else if (draft.productName) {
    lines.push(`المنتج: ${draft.productName}`);
    if (draft.quantity) lines.push(`الكمية: ${draft.quantity}`);
  }
  if (draft.phone) lines.push(`الهاتف: ${draft.phone}`);
  if (draft.rawAddress || draft.province) {
    lines.push(`العنوان: ${[draft.province, draft.rawAddress].filter(Boolean).join(" - ")}`);
  }
  if (draft.missingFields.length) {
    lines.push(`ينقص: ${draft.missingFields.map(fieldLabel).join("، ")}`);
  }
  return lines.join("\n");
}

function fieldLabel(f: string): string {
  switch (f) {
    case "product": return "المنتج";
    case "quantity": return "الكمية";
    case "phone": return "الهاتف";
    case "address": return "العنوان";
    case "name": return "الاسم";
    default: return f;
  }
}
