import type { Db } from "@/modules/customers/service";
import { AppError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import { parseQuantity, parseConfirmation, normalizePhone, type ResolvableProduct } from "./primitives";
import { getOrCreateDraft, updateDraftFromExtraction, buildDraftSummary, getOwnedDraft, recycleDraftForNewOrder } from "./draft-service";
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

  // 1. Explicit cancel.
  if (intent === "ORDER_CANCEL") {
    const draft = await db.orderDraft.findUnique({ where: { conversationId: params.conversationId } });
    if (draft && draft.state !== "CANCELLED" && draft.state !== "CONVERTED") {
      await db.orderDraft.update({ where: { id: draft.id }, data: { state: "CANCELLED" } });
      await recordAudit(db, {
        workspaceId: params.workspaceId,
        action: "order_draft.cancelled",
        entityType: "OrderDraft",
        entityId: draft.id,
      });
      return { handled: true, action: "ORDER_CANCELLED", summaryText: "تم إلغاء الطلب." };
    }
    // Closed draft (order already placed) → the cancel targets the ORDER.
    if (draft && draft.state === "CONVERTED") {
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

  // 2. Confirmation handling — only when a READY/CONFIRMING draft exists.
  if (intent === "ORDER_CREATE" || intent === "ORDER_UPDATE" || intent === "UNKNOWN") {
    const draft = await db.orderDraft.findUnique({ where: { conversationId: params.conversationId } });
    const confirmationRelevant =
      draft && (draft.state === "READY" || draft.state === "CONFIRMING") && draft.productId && draft.quantity;
    if (confirmationRelevant) {
      const signal = parseConfirmation(params.customerText);
      if (signal.signal === "NO") {
        await db.orderDraft.update({
          where: { id: draft.id },
          data: { state: "CANCELLED" },
        });
        await recordAudit(db, {
          workspaceId: params.workspaceId,
          action: "order_draft.cancelled",
          entityType: "OrderDraft",
          entityId: draft.id,
          metadata: { reason: "CUSTOMER_DECLINED" },
        });
        return { handled: true, action: "ORDER_CANCELLED", summaryText: "تم إلغاء الطلب. في شي ثاني بقدر ساعدك فيه؟" };
      }
      if (signal.signal === "YES") {
        // Rules run inside createOrderFromDraft — the AI cannot bypass them.
        const actor = { userId: params.actorUserId ?? "ai-agent", workspaceId: params.workspaceId };
        try {
          const result = await createOrderFromDraft(db, actor, {
            draftId: draft.id,
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
            const refreshed = await getOwnedDraft(db, params.workspaceId, draft.id);
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
      // Ambiguous confirmation in an active draft context → keep collecting.
      if (intent === "ORDER_UPDATE" || intent === "UNKNOWN") {
        return { handled: true, action: "NONE" };
      }
    }
  }

  // 3. Order creation/update → merge extraction into the persisted draft.
  if (intent === "ORDER_CREATE" || intent === "ORDER_UPDATE" || extraction.requestedAction === "CREATE_ORDER") {
    const entities = extraction.entities;
    const draftInput: Parameters<typeof updateDraftFromExtraction>[1]["extraction"] = {
      productName: entities.product ?? null,
      quantity: entities.quantity ?? null,
      customerName: entities.customer_name ?? null,
      phone: entities.phone ?? null,
      rawAddress: entities.address ?? null,
      province: entities.province ?? null,
      notes: entities.notes ?? null,
      confidence: {},
    };

    // Deterministic quantity re-parse from the raw text when AI missed it
    // ("بدي 3" / "ثلاث قطع" / "٣").
    if (!draftInput.quantity) {
      const q = parseQuantity(params.customerText);
      if (q.value) {
        draftInput.quantity = q.value;
        draftInput.confidence!.quantity = q.confidence;
      }
    }

    // Deterministic product re-resolution from raw text when the AI missed it
    // ("بدي 3" after "بدي ماء الكمأة" — context product). Scoped to the page's
    // catalog allowlist the same way the direct merge below is.
    if (!draftInput.productName && !draftInput.productId) {
      const { resolveProduct } = await import("./primitives");
      const products = await listResolvableProducts(db, params.workspaceId, params.allowedProductIds);
      const resolution = resolveProduct(params.customerText, products);
      if (resolution.status === "RESOLVED" && resolution.product) {
        draftInput.productId = resolution.product.id;
      }
    }

    const draft = await getOrCreateDraft(db, params.workspaceId, params.conversationId, params.customerId);

    // MULTI-ORDER: a closed draft (order placed or cart cancelled) is either
    // edited (update of the PLACED order) or recycled into a fresh cart for a
    // new order in the same conversation.
    if (draft.state === "CONVERTED" || draft.state === "CANCELLED") {
      const wantsNewProduct = Boolean(draftInput.productName || draftInput.productId);
      const wantsEdit = Boolean(draftInput.quantity || draftInput.rawAddress || draftInput.province || draftInput.notes);
      if (intent === "ORDER_UPDATE" && !wantsNewProduct) {
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
            summaryText: `الطلب رقم ${edit.orderNumber} وصل مرحلة ما بتنعدل هلق (${edit.statusLabel}).`,
          };
        }
        // NO_ORDER → fall through: open a fresh cart with the given fields.
      } else {
        // A bare confirmation on an empty new cart is chatter, not a new order.
        if (!wantsNewProduct && !wantsEdit && parseConfirmation(params.customerText).signal !== "NONE") {
          return { handled: false, action: "NONE" };
        }
        await recycleDraftForNewOrder(db, params.workspaceId, draft);
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
  const draft = await db.orderDraft.findUnique({ where: { conversationId: params.conversationId } });
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
