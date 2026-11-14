import type { Db } from "@/modules/customers/service";
import { AppError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import { parseQuantity, parseConfirmation, normalizePhone, type ResolvableProduct } from "./primitives";
import { listOpenDrafts, updateDraftFromExtraction, buildDraftSummary, getOwnedDraft, parseDraftItems, retireOutOfCatalogDraftItems, type DraftItem } from "./draft-service";
import { evaluateOrderRules, aggregateVerdict, publishDuplicateEvent, detectDuplicate } from "./rules";
import { createOrderFromDraft, mergeCustomerData, updateOrderFromChat, cancelLatestOrderFromConversation } from "./order-service";
import type { ExtractionResult } from "@/modules/ai/structured";

export interface OrderIntelligenceResult {
  handled: boolean;
  action:
    | "NONE"
    | "DRAFT_UPDATED"
    | "ASK_MISSING_FIELD"
    | "REQUEST_CONFIRMATION"
    | "ORDER_CONFIRMED"
    | "ORDER_CANCELLED"
    | "ORDER_UPDATED"
    | "RULES_BLOCKED";
  missingFields?: string[];
  summaryText?: string;
  orderId?: string;
  orderNumber?: string;
  total?: number;
  currency?: string;
  rulesBlocked?: string[];
  needsHumanReview?: boolean;
  customerNotice?: string;
}

const ORDER_INTENTS = new Set(["ORDER_CREATE", "ORDER_UPDATE", "ORDER_CANCEL", "TRACK_ORDER"]);

/** قيمة فيها نص فعلي (مش فراغ ولا null). */
function filled(value: unknown): boolean {
  return typeof value === "number" ? Number.isFinite(value) && value > 0 : Boolean(String(value ?? "").trim());
}

/**
 * ⚠️ المسودة كانت تتعبّى بس لما الموديل يصنّف الرسالة «طلب». الاستخراج بيشتغل
 * على كل رسالة أصلًا، فالكمية والرقم والعنوان كانوا بينستخرجوا وبينحكوا بالرد
 * وبعدين **بينرموا** — ولا طلب انسجّل.
 * 🔧 أي رسالة فيها بيانات طلب بتوصل المسودة، مهما كان تصنيفها. **بلا أي نداء
 * ذكاء زيادة** — نفس الاستخراج اللي صار.
 *
 * اسم منتج لحاله مش «بيانات طلب»: «بكم ماء الكمأ؟» سؤال سعر وبيضل سؤال سعر.
 * اللي بيفتح مسودة لحاله: الرقم أو العنوان أو سلة منتجات — ما بيبعتهم الزبون
 * إلا وهو بيطلب. والأضعف (كمية · محافظة · اسم) بيكمّل مسودة مفتوحة بس، لأنه
 * «عندكم فرع بعمان؟» بيطلّع محافظة وما بصير يفتح طلب من لا شي.
 */
export function hasOrderData(extraction: ExtractionResult): boolean {
  return hasStrongOrderData(extraction) || hasWeakOrderData(extraction);
}

/** بيانات بتفتح مسودة لحالها: رقم · عنوان · سلة منتجات. */
function hasStrongOrderData(extraction: ExtractionResult): boolean {
  const e = extraction.entities;
  if (Array.isArray(e.products) && e.products.some((p) => p && filled(p.name))) return true;
  return filled(e.phone) || filled(e.address);
}

/** بيانات بتكمّل مسودة مفتوحة بس: كمية · محافظة · اسم. */
function hasWeakOrderData(extraction: ExtractionResult): boolean {
  const e = extraction.entities;
  return filled(e.quantity) || filled(e.province) || filled(e.customer_name);
}

function isProductCandidate(text: string): boolean {
  // Don't treat every message as a product mention — only plausible ones.
  return text.length > 2 && /[\p{L}]/u.test(text);
}

/**
 * OrderIntelligence — the deterministic bridge between AI extraction and the
 * order system. The AI proposes; this module + Rules Engine decide.
 *
 * Confirmation is context-gated: "تمام" only confirms when a READY draft
 * exists; "تمام" in a normal chat never creates an order.
 */
export async function handleOrderIntent(
  db: Db,
  params: {
    workspaceId: string;
    conversationId: string;
    customerId: string;
    extraction: ExtractionResult;
    customerText: string;
    source?: string;
    actorUserId?: string;
    /**
     * The page's catalog allowlist, resolved once in the reply path. Same
     * gate as the reply: a page orders only what its assigned catalog
     * holds; undefined keeps the legacy open behaviour for catalog-less
     * workspaces.
     */
    allowedProductIds?: string[];
  }
): Promise<OrderIntelligenceResult> {
  const { extraction } = params;
  const intent = extraction.intent;

  // حدود الكتالوج أولًا: مسودة منتجها طلع من الصفحة ما بتتأكد ولا بتنذكر.
  const retiredDrafts = params.allowedProductIds
    ? await retireOutOfCatalogDraftItems(db, {
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        allowedProductIds: params.allowedProductIds,
      })
    : 0;

  // 1. Explicit cancel — مسودة واحدة فقط، ولو في أكثر من وحدة نسأل.
  if (intent === "ORDER_CANCEL") {
    const open = await listOpenDrafts(db, params.workspaceId, params.conversationId);
    if (open.length > 0) {
      const target = open.length === 1 ? open[0] : matchDraftFromText(params.customerText, open);
      if (!target) {
        return {
          handled: true,
          action: "ASK_MISSING_FIELD",
          summaryText: `عندك أكثر من طلب: ${open.map((d) => draftLabel(d)).join("، ")}. أي واحد بدك تلغي؟`,
        };
      }
      await db.orderDraft.update({ where: { id: target.id }, data: { state: "CANCELLED" } });
      await recordAudit(db, {
        workspaceId: params.workspaceId,
        action: "order_draft.cancelled",
        entityType: "OrderDraft",
        entityId: target.id,
      });
      return { handled: true, action: "ORDER_CANCELLED", summaryText: `تم إلغاء طلب ${draftLabel(target)}.` };
    }
    // لا مسودة مفتوحة → يمكن يلغي آخر طلب منشأ.
    const converted = await db.orderDraft.findFirst({
      where: { workspaceId: params.workspaceId, conversationId: params.conversationId, state: "CONVERTED", orderId: { not: null } },
      orderBy: { sequence: "desc" },
    });
    if (converted) {
      const actor = { userId: params.actorUserId ?? "ai-agent", workspaceId: params.workspaceId };
      const cancelled = await cancelLatestOrderFromConversation(db, actor, params.conversationId);
      if (cancelled) {
        return {
          handled: true,
          action: "ORDER_CANCELLED",
          orderId: cancelled.orderId,
          orderNumber: cancelled.orderNumber,
          summaryText: `تم إلغاء الطلب رقم ${cancelled.orderNumber}.`,
        };
      }
    }
    return { handled: true, action: "NONE" };
  }

  // 2. Confirmation — مسودة واحدة تتأكد مباشرة، وأكثر من واحدة = سؤال.
  if (intent === "ORDER_CREATE" || intent === "ORDER_UPDATE" || intent === "UNKNOWN") {
    const open = await listOpenDrafts(db, params.workspaceId, params.conversationId);
    const ready = open.filter(
      (d) => (d.state === "READY" || d.state === "CONFIRMING") && parseDraftItems(d).length > 0
    );
    if (ready.length > 0) {
      const signal = parseConfirmation(params.customerText);
      const target = ready.length === 1 ? ready[0] : matchDraftFromText(params.customerText, ready);

      if (!target) {
        if (signal.signal === "YES" || signal.signal === "NO") {
          return {
            handled: true,
            action: "ASK_MISSING_FIELD",
            summaryText: `عندك ${ready.length} طلبات جاهزة: ${ready.map((d) => draftLabel(d)).join("، ")}. أي واحد تقصد؟`,
          };
        }
        // كلام عادي وسط جمع الطلب: نكمل عادي.
      } else {
        if (signal.signal === "NO") {
          await db.orderDraft.update({ where: { id: target.id }, data: { state: "CANCELLED" } });
          await recordAudit(db, {
            workspaceId: params.workspaceId,
            action: "order_draft.cancelled",
            entityType: "OrderDraft",
            entityId: target.id,
            metadata: { reason: "CUSTOMER_DECLINED" },
          });
          return { handled: true, action: "ORDER_CANCELLED", summaryText: "تم إلغاء الطلب. في شي ثاني بقدر ساعدك فيه؟" };
        }
        if (signal.signal === "YES") {
          const actor = { userId: params.actorUserId ?? "ai-agent", workspaceId: params.workspaceId };
          try {
            const result = await createOrderFromDraft(db, actor, {
              draftId: target.id,
              source: params.source ?? "AI",
            });
            return {
              handled: true,
              action: "ORDER_CONFIRMED",
              orderId: result.orderId,
              orderNumber: result.orderNumber,
              total: result.total,
              currency: result.currency,
              summaryText: `تم تأكيد طلبك ✅ رقم الطلب: ${result.orderNumber}`,
            };
          } catch (err) {
            if (err instanceof AppError && err.code === "ORDER_REQUIRES_HUMAN") {
              return { handled: true, action: "RULES_BLOCKED", needsHumanReview: true };
            }
            if (err instanceof AppError && err.code === "ORDER_MISSING_FIELDS") {
              const refreshed = await getOwnedDraft(db, params.workspaceId, target.id);
              return {
                handled: true,
                action: "ASK_MISSING_FIELD",
                missingFields: refreshed.missingFields as string[],
                summaryText: buildDraftSummary(refreshed),
              };
            }
            throw err;
          }
        }
        // تأكيد ملتبس داخل سياق مسودة نشطة → نكمل الجمع.
        if (intent === "ORDER_UPDATE" || intent === "UNKNOWN") {
          return { handled: true, action: "NONE" };
        }
      }
    } else if (retiredDrafts > 0 && parseConfirmation(params.customerText).signal === "YES") {
      return {
        handled: true,
        action: "ASK_MISSING_FIELD",
        missingFields: ["product", "quantity"],
        summaryText: "المنتج اللي كان بالطلب ما عاد متاح على هالصفحة، والطلب ما تأكد. بيانات التواصل محفوظة — اسأل العميل شو المنتج اللي بده ياه من المتاح.",
      };
    }
  }

  // 3. Order creation/update → merge extraction into the persisted draft.
  //    ⚠️ كان الشرط على التصنيف بس، فكل رسالة سمّاها الموديل «سؤال» كانت
  //    بياناتها تُرمى (المحادثة الحقيقية: الكمية والرقم والعنوان كلهم انرموا).
  //    🔧 بيانات الطلب بتدخل المسودة مهما كان التصنيف — والكمية لحالها بس
  //    مع مسودة مفتوحة، فسؤال عادي فيه رقم ما بيفتح طلب من لا شي.
  const labelledOrder = intent === "ORDER_CREATE" || intent === "ORDER_UPDATE" || extraction.requestedAction === "CREATE_ORDER";
  const capturesOrderData =
    labelledOrder ||
    hasStrongOrderData(extraction) ||
    (hasWeakOrderData(extraction) && (await listOpenDrafts(db, params.workspaceId, params.conversationId)).length > 0);
  if (capturesOrderData) {
    const entities = extraction.entities;
    // P22 — عدة منتجات في رسالة واحدة: نبني سلة من entities.products.
    const multiItems = Array.isArray(entities.products)
      ? entities.products
          .filter((p) => p && typeof p.name === "string" && p.name.trim())
          .slice(0, 20)
          .map((p) => ({ productName: p.name.trim(), quantity: p.quantity ?? null }))
      : [];
    const draftInput: Parameters<typeof updateDraftFromExtraction>[1]["extraction"] = {
      productName: multiItems.length ? null : entities.product ?? null,
      quantity: multiItems.length ? null : entities.quantity ?? null,
      customerName: entities.customer_name ?? null,
      phone: entities.phone ?? null,
      rawAddress: entities.address ?? null,
      province: entities.province ?? null,
      notes: entities.notes ?? null,
      ...(multiItems.length ? { items: multiItems } : {}),
      confidence: {},
    };

    // Deterministic quantity re-parse from the raw text when AI missed it
    // ("بدي 3" / "ثلاث قطع" / "٣").
    if (!draftInput.quantity && !multiItems.length) {
      const q = parseQuantity(params.customerText);
      if (q.value) {
        draftInput.quantity = q.value;
        draftInput.confidence!.quantity = q.confidence;
      }
    }

    // Deterministic product re-resolution from raw text when the AI missed it
    // ("بدي 3" after "بدي ماء الكمأة" — context product). Scoped to the page's
    // catalog allowlist the same way the direct merge below is.
    if (!draftInput.productName && !draftInput.productId && !multiItems.length) {
      const { resolveProduct } = await import("./primitives");
      const products = await listResolvableProducts(db, params.workspaceId, params.allowedProductIds);
      const resolution = resolveProduct(params.customerText, products);
      if (resolution.status === "RESOLVED" && resolution.product) {
        draftInput.productId = resolution.product.id;
      }
    }

    // قرار المالك: لا recycle — كل طلب جديد مسودة جديدة.
    // التعديل يخصّ آخر طلب منشأ فقط، وفقط إذا ما في منتج جديد بالرسالة.
    const wantsNewProduct = multiItems.length > 0 || Boolean(draftInput.productName || draftInput.productId);
    if (intent === "ORDER_UPDATE" && !wantsNewProduct) {
      const latestConverted = await db.orderDraft.findFirst({
        where: {
          workspaceId: params.workspaceId,
          conversationId: params.conversationId,
          state: "CONVERTED",
          orderId: { not: null },
        },
        orderBy: { sequence: "desc" },
      });
      if (latestConverted) {
        const wantsEdit = Boolean(
          draftInput.quantity || draftInput.rawAddress || draftInput.province || draftInput.notes || draftInput.phone
        );
        if (!wantsEdit) return { handled: false, action: "NONE" };
        const actor = { userId: params.actorUserId ?? "ai-agent", workspaceId: params.workspaceId };
        const edit = await updateOrderFromChat(db, actor, {
          conversationId: params.conversationId,
          quantity: draftInput.quantity,
          rawAddress: draftInput.rawAddress,
          province: draftInput.province,
          notes: draftInput.notes,
          phone: draftInput.phone,
        });
        if (edit.ok) {
          return {
            handled: true,
            action: "ORDER_UPDATED",
            orderId: edit.order.id,
            orderNumber: edit.order.orderNumber,
            total: Number(edit.order.total),
            currency: edit.order.currency,
            summaryText: edit.changed.length
              ? `تم تعديل الطلب رقم ${edit.order.orderNumber} ✅`
              : `الطلب رقم ${edit.order.orderNumber} ما فيه شي جديد يتغير.`,
          };
        }
        if (edit.reason === "NOT_EDITABLE") {
          return {
            handled: true,
            action: "NONE",
            summaryText: `الطلب رقم ${edit.orderNumber} وصل مرحلة ما بتنعدل هلق (${edit.statusLabel}). سجّلنا طلب التعديل وبيراجعه الفريق.`,
          };
        }
        if (edit.reason === "EDIT_NEEDS_REVIEW") {
          return {
            handled: true,
            action: "NONE",
            summaryText: `الطلب رقم ${edit.orderNumber} فيه أكثر من منتج — رح يراجع الفريق التعديل المطلوب قبل تطبيقه.`,
          };
        }
        // NO_ORDER → نكمل: مسودة جديدة بالحقول المذكورة.
      }
    }

    const result = await updateDraftFromExtraction(db, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      customerId: params.customerId,
      extraction: draftInput,
      source: params.source ?? "AI",
      allowedProductIds: params.allowedProductIds,
    });

    if ("ambiguousCandidates" in result && result.ambiguousCandidates) {
      return {
        handled: true,
        action: "ASK_MISSING_FIELD",
        summaryText: `لقينا أكثر من منتج مطابق: ${result.ambiguousCandidates.join("، ")}. أي واحد تقصد؟`,
      };
    }

    // Customer CRM merge (confidence-gated, never silently replaces data).
    const merge = await mergeCustomerData(db, { userId: params.actorUserId ?? "ai-agent", workspaceId: params.workspaceId }, params.customerId, {
      customerName: entities.customer_name ? { value: entities.customer_name, confidence: 0.9 } : null,
      phone: entities.phone ? { value: normalizePhone(entities.phone).canonical || entities.phone, confidence: 0.9 } : null,
      address: entities.address ? { value: entities.address, confidence: 0.9 } : null,
      province: entities.province ? { value: entities.province, confidence: 0.9 } : null,
    });

    const refreshed = await getOwnedDraft(db, params.workspaceId, result.draft.id);
    const summaryText = buildDraftSummary(refreshed);

    if (result.becameReady) {
      // Pre-compute duplicate level for transparency; final gate is in rules.
      const dup = await detectDuplicate(db, {
        workspaceId: params.workspaceId,
        customerId: params.customerId,
        conversationId: params.conversationId,
        productId: refreshed.productId,
        quantity: refreshed.quantity,
      });
      await publishDuplicateEvent(params.workspaceId, refreshed.id, dup);

      return {
        handled: true,
        action: "REQUEST_CONFIRMATION",
        summaryText: `${summaryText}\nهل أؤكد الطلب؟`,
        customerNotice: merge.needsConfirmation.join(",") || undefined,
      };
    }

    return {
      handled: true,
      action: refreshed.missingFields.length ? "ASK_MISSING_FIELD" : "DRAFT_UPDATED",
      missingFields: refreshed.missingFields as string[],
      summaryText,
    };
  }

  // 4. Not an order intent — but if an active draft exists and the message
  //    is a bare quantity/product continuation, still collect it.
  const openForContext = await listOpenDrafts(db, params.workspaceId, params.conversationId);
  const draft = openForContext[0] ?? null;
  if (draft && (draft.state === "COLLECTING" || draft.state === "READY")) {
    const q = parseQuantity(params.customerText);
    if (q.value && isProductCandidate(params.customerText) === false) {
      await updateDraftFromExtraction(db, {
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        customerId: params.customerId,
        extraction: { quantity: q.value },
        source: "CONTEXT",
      });
      return { handled: true, action: "DRAFT_UPDATED" };
    }
  }

  return { handled: false, action: "NONE" };
}

/** Product candidates for resolver consumers (used by tests and UI pickers). */
export async function listResolvableProducts(
  db: Db,
  workspaceId: string,
  allowedProductIds?: string[]
): Promise<ResolvableProduct[]> {
  const products = await db.product.findMany({
    where: {
      workspaceId, isActive: true, isArchived: false,
      ...(allowedProductIds ? { id: { in: allowedProductIds } } : {}),
    },
  }) as unknown as ResolvableProduct[];
  return products.map((p) => ({
    ...p,
    aliases: [p.name, ...(((p as unknown as { tags?: string[] }).tags ?? []).filter((t) => t.length > 2))],
  }));
}

export { evaluateOrderRules, aggregateVerdict };


/** اسم مقروء للمسودة من عنصرها الوحيد. */
function draftLabel(draft: { items?: unknown; productName?: string | null }): string {
  const item: DraftItem | undefined = parseDraftItems(draft as never)[0];
  const name = item?.productName || draft.productName || "";
  if (!name) return "بدون منتج";
  return item?.quantity ? `${name} × ${item.quantity}` : name;
}

/** يطابق مسودة بذكر اسم منتجها داخل نص العميل — ولا يخمّن عند التعدد. */
function matchDraftFromText<T extends { items?: unknown; productName?: string | null }>(
  customerText: string,
  drafts: T[]
): T | null {
  const text = customerText.toLowerCase();
  const matches = drafts.filter((d) => {
    const name = (parseDraftItems(d as never)[0]?.productName || d.productName || "").trim();
    return name.length >= 3 && text.includes(name.toLowerCase());
  });
  return matches.length === 1 ? matches[0] : null;
}
