import type { Prisma, OrderDraft, OrderDraftState } from "@prisma/client";
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

/** حالات المسودة المفتوحة (قابلة للجمع/التأكيد). */
export const OPEN_DRAFT_STATES: OrderDraftState[] = ["EMPTY", "COLLECTING", "READY", "CONFIRMING"];

/** كل المسودات المفتوحة للمحادثة — الأحدث أولًا. */
export async function listOpenDrafts(db: Db, workspaceId: string, conversationId: string) {
  return (await db.orderDraft.findMany({
    where: { workspaceId, conversationId, state: { in: OPEN_DRAFT_STATES } },
    orderBy: { sequence: "desc" },
  })) as OrderDraft[];
}

async function nextDraftSequence(db: Db, workspaceId: string, conversationId: string): Promise<number> {
  const last = (await db.orderDraft.findFirst({
    where: { workspaceId, conversationId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  })) as { sequence?: number } | null;
  return (last?.sequence ?? 0) + 1;
}

/**
 * مسودة جديدة (منتج واحد فقط) بترقيم تسلسلي داخل المحادثة.
 * قرار المالك: كل منتج مسودة مستقلة — لا سلة.
 */
async function createDraftRow(db: Db, workspaceId: string, conversationId: string, customerId: string) {
  const customer = await db.customer.findFirst({
    where: { id: customerId, workspaceId },
    select: { name: true, phone: true, address: true, province: true },
  });
  // قرار المالك — كل منتج مسودة جديدة، بس بيانات التواصل تُورَّث من آخر مسودة
  // بنفس المحادثة (ما نطلب الاسم/الرقم/العنوان من جديد لكل منتج).
  const previous = (await db.orderDraft.findFirst({
    where: { workspaceId, conversationId },
    orderBy: { sequence: "desc" },
    select: { customerName: true, phone: true, rawAddress: true, province: true },
  })) as { customerName: string | null; phone: string | null; rawAddress: string | null; province: string | null } | null;
  const rawAddress = previous?.rawAddress ?? customer?.address ?? null;
  const province = previous?.province ?? customer?.province ?? (rawAddress ? inferProvince(rawAddress) : null);
  const previousPhone = previous?.phone ? normalizePhone(previous.phone) : null;
  const profilePhone = customer?.phone ? normalizePhone(customer.phone) : null;
  const seed = {
    customerName: previous?.customerName ?? customer?.name ?? null,
    phone: previousPhone?.valid ? previousPhone.canonical : profilePhone?.valid ? profilePhone.canonical : null,
    rawAddress,
    province,
  };
  const sequence = await nextDraftSequence(db, workspaceId, conversationId);
  try {
    const draft = await db.orderDraft.create({
      data: {
        workspaceId,
        conversationId,
        customerId,
        sequence,
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
    await eventBus.publish(makeEvent("OrderDraftCreated", workspaceId, { draftId: draft.id, conversationId, sequence }));
    return draft as OrderDraft;
  } catch (err) {
    // سباق على نفس الرقم: نكمل على أحدث مسودة مفتوحة بدل ما نفشل الرد.
    if ((err as { code?: string }).code !== "P2002") throw err;
    const open = await listOpenDrafts(db, workspaceId, conversationId);
    if (open[0]) return open[0];
    throw err;
  }
}

/** المسودة النشطة = أحدث مسودة مفتوحة، أو مسودة جديدة. */
export async function getOrCreateDraft(db: Db, workspaceId: string, conversationId: string, customerId: string) {
  const open = await listOpenDrafts(db, workspaceId, conversationId);
  if (open[0]) return open[0];
  return createDraftRow(db, workspaceId, conversationId, customerId);
}

/** عنصر واحد فقط داخل المسودة (مرآة الحقول المفردة للتوافق). */
function singleItemData(
  item: DraftItem,
  quantityOverride?: number | null
): Prisma.OrderDraftUncheckedUpdateInput {
  const quantity = quantityOverride !== undefined ? quantityOverride : item.quantity;
  const stored: DraftItem = { ...item, quantity };
  return {
    items: [stored] as unknown as Prisma.InputJsonValue,
    productId: item.productId,
    productName: item.productName || null,
    variantId: item.variantId,
    quantity,
  };
}

/** يكمل بيانات العميل المعروفة على المسودة (بلا استبدال قيمة موجودة). */
async function backfillCustomerFields(
  db: Db,
  workspaceId: string,
  customerId: string,
  draft: OrderDraft
): Promise<OrderDraft> {
  if (draft.phone && draft.rawAddress && draft.province && draft.customerName) return draft;
  const customer = await db.customer.findFirst({
    where: { id: customerId, workspaceId },
    select: { name: true, phone: true, address: true, province: true },
  });
  if (!customer) return draft;
  const backfill: Prisma.OrderDraftUncheckedUpdateInput = {};
  if (!draft.phone && customer.phone) {
    const normalized = normalizePhone(customer.phone);
    if (normalized.valid && normalized.canonical) backfill.phone = normalized.canonical;
  }
  if (!draft.rawAddress && customer.address) backfill.rawAddress = customer.address;
  if (!draft.province) {
    const source = draft.rawAddress ?? customer.address ?? null;
    const province = customer.province ?? (source ? inferProvince(source) : null);
    if (province) backfill.province = province;
  }
  if (!draft.customerName && customer.name) backfill.customerName = customer.name;
  if (Object.keys(backfill).length === 0) return draft;
  return (await db.orderDraft.update({ where: { id: draft.id }, data: backfill })) as OrderDraft;
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
  let active = await getOrCreateDraft(db, params.workspaceId, params.conversationId, params.customerId);

  // Legacy: مسودة قديمة انبنت كسلة (>1 منتج). نفصلها لمسودة لكل منتج.
  const legacyItems = parseDraftItems(active);
  if (legacyItems.length > 1) {
    const [first, ...rest] = legacyItems;
    await db.orderDraft.update({ where: { id: active.id }, data: singleItemData(first) });
    for (const item of rest) {
      const created = await createDraftRow(db, params.workspaceId, params.conversationId, params.customerId);
      await db.orderDraft.update({ where: { id: created.id }, data: singleItemData(item) });
    }
    active = (await db.orderDraft.findUniqueOrThrow({ where: { id: active.id } })) as OrderDraft;
  }

  // P22 — منتجات مذكورة بالرسالة (مفرد أو متعدد). كل واحد بمسودته.
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

  const incoming: DraftItem[] = [];
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
          await eventBus.publish(makeEvent("OrderDraftUpdated", params.workspaceId, { draftId: active.id, ambiguous: true }));
          return { draft: active, ambiguousCandidates: resolution.candidates!.map((c) => c.name) };
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
  }

  // كل منتج → مسودته: نفس المنتج يحدّث مسودته المفتوحة، ومنتج جديد = مسودة جديدة.
  // لقطة المسودات المفتوحة قبل التعديل: لو مسودة جاهزة/قيد التأكيد تغيّر فيها شي جوهري
  // بنرجّعها لجمع البيانات ونطلب تأكيد جديد (العميل شاف ملخصاً قديماً).
  const beforeById = new Map(
    (await listOpenDrafts(db, params.workspaceId, params.conversationId)).map((d) => [d.id, d] as const)
  );
  const targets: OrderDraft[] = [];
  if (incoming.length > 0) {
    for (const item of incoming) {
      const open = await listOpenDrafts(db, params.workspaceId, params.conversationId);
      const match = open.find((d) => parseDraftItems(d)[0]?.productId === item.productId);
      if (match) {
        const current = parseDraftItems(match)[0];
        const quantity = item.quantity ?? current?.quantity ?? null;
        targets.push(
          (await db.orderDraft.update({
            where: { id: match.id },
            data: singleItemData({ ...item, quantity }, quantity),
          })) as OrderDraft
        );
      } else {
        // أول منتج يستخدم المسودة النشطة الفارغة (ما نترك مسودة فارغة يتيمة).
        const empty = open.find(
          (d) => parseDraftItems(d).length === 0 && d.state !== "READY" && d.state !== "CONFIRMING"
        );
        const created = empty ?? (await createDraftRow(db, params.workspaceId, params.conversationId, params.customerId));
        targets.push(
          (await db.orderDraft.update({ where: { id: created.id }, data: singleItemData(item) })) as OrderDraft
        );
      }
    }
  } else if (params.extraction.quantity && params.extraction.quantity > 0 && parseDraftItems(active).length > 0) {
    // كمية بلا اسم منتج («بدي 3») = تحديث آخر مسودة مفتوحة.
    const current = parseDraftItems(active)[0];
    const quantity = Math.trunc(params.extraction.quantity);
    targets.push(
      (await db.orderDraft.update({
        where: { id: active.id },
        data: singleItemData({ ...current, quantity }, quantity),
      })) as OrderDraft
    );
  } else {
    targets.push(active);
  }

  // بيانات التواصل/الملاحظات تُطبَّق على كل مسودة تأثّرت بهذه الرسالة.
  const common: Prisma.OrderDraftUncheckedUpdateInput = {};
  if (params.extraction.customerName) common.customerName = params.extraction.customerName;
  if (params.extraction.notes) common.notes = params.extraction.notes;
  if (params.extraction.phone) {
    const phone = normalizePhone(params.extraction.phone);
    if (phone.valid) common.phone = phone.canonical;
  }
  if (params.extraction.rawAddress) {
    common.rawAddress = params.extraction.rawAddress;
    common.province = params.extraction.province ?? inferProvince(params.extraction.rawAddress) ?? null;
  } else if (params.extraction.province) {
    common.province = params.extraction.province;
  }
  if (params.extraction.confidence) {
    common.entityConfidence = params.extraction.confidence as Prisma.InputJsonValue;
  }

  const requiredFields = await getRequiredOrderFields(db, params.workspaceId, params.conversationId);
  const results: { id: string; missingFields: RequiredDraftField[]; becameReady: boolean }[] = [];
  let primary: OrderDraft = targets[targets.length - 1];
  let becameReady = false;

  for (const target of targets) {
    let current = Object.keys(common).length > 0
      ? ((await db.orderDraft.update({ where: { id: target.id }, data: common })) as OrderDraft)
      : target;
    current = await backfillCustomerFields(db, params.workspaceId, params.customerId, current);
    const prev = beforeById.get(current.id);
    if (prev && (prev.state === "READY" || prev.state === "CONFIRMING") && draftMaterialChange(prev, current)) {
      assertDraftTransition(current.state as OrderDraftState, "COLLECTING");
      current = (await db.orderDraft.update({ where: { id: current.id }, data: { state: "COLLECTING" } })) as OrderDraft;
    }

    const missing = computeMissingFields(current, requiredFields);
    current = (await db.orderDraft.update({
      where: { id: current.id },
      data: { missingFields: missing },
    })) as OrderDraft;

    let ready = false;
    if (missing.length === 0 && current.state === "COLLECTING") {
      assertDraftTransition(current.state as OrderDraftState, "READY");
      current = (await db.orderDraft.update({
        where: { id: current.id },
        data: { state: "READY" },
      })) as OrderDraft;
      // المسودة الجاهزة ما بتنرحّل لتلجرام — الترحيل للطلبات فقط.
      await eventBus.publish(makeEvent("OrderReadyForConfirmation", params.workspaceId, { draftId: current.id }));
      ready = true;
      becameReady = true;
    }

    await recordAudit(db, {
      workspaceId: params.workspaceId,
      action: "order_draft.updated",
      entityType: "OrderDraft",
      entityId: current.id,
      metadata: { source: params.source, missing },
    });
    await eventBus.publish(makeEvent("OrderDraftUpdated", params.workspaceId, { draftId: current.id, missing }));

    results.push({ id: current.id, missingFields: missing, becameReady: ready });
    primary = current;
  }

  return {
    draft: primary,
    missingFields: results[results.length - 1]?.missingFields ?? (primary.missingFields as RequiredDraftField[]),
    ...(becameReady ? { becameReady: true } : {}),
    drafts: results,
  };
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

/** تغيير جوهري بمسودة جاهزة: منتج · كمية · رقم هاتف · عنوان — يستوجب تأكيداً جديداً. */
function draftMaterialChange(prev: OrderDraft, next: OrderDraft): boolean {
  const itemsKey = (d: OrderDraft) => JSON.stringify(parseDraftItems(d).map((i) => [i.productId, i.quantity]));
  return (
    itemsKey(prev) !== itemsKey(next) ||
    (prev.phone ?? null) !== (next.phone ?? null) ||
    (prev.rawAddress ?? null) !== (next.rawAddress ?? null)
  );
}
