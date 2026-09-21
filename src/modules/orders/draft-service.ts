import type { Prisma, OrderDraftState } from "@prisma/client";
import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { assertDraftTransition } from "./state-machine";
import { normalizePhone } from "./primitives";
import { resolveProduct, type ResolvableProduct } from "./primitives";

export const REQUIRED_DRAFT_FIELDS = ["product", "quantity", "phone", "address"] as const;
export type RequiredDraftField = (typeof REQUIRED_DRAFT_FIELDS)[number];

export interface DraftExtractionInput {
  productName?: string | null;
  productId?: string | null;
  quantity?: number | null;
  customerName?: string | null;
  phone?: string | null;
  rawAddress?: string | null;
  province?: string | null;
  notes?: string | null;
  confidence?: Record<string, number>;
}

export async function getOrCreateDraft(db: Db, workspaceId: string, conversationId: string, customerId: string) {
  let draft = await db.orderDraft.findUnique({ where: { conversationId } });
  if (!draft) {
    draft = await db.orderDraft.create({
      data: { workspaceId, conversationId, customerId, state: "COLLECTING" },
    });
    await eventBus.publish(makeEvent("OrderDraftCreated", workspaceId, { draftId: draft.id, conversationId }));
  }
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
  }
) {
  const draft = await getOrCreateDraft(db, params.workspaceId, params.conversationId, params.customerId);
  if (draft.state === "CANCELLED" || draft.state === "CONVERTED") {
    throw new AppError("Draft is closed", 422, "DRAFT_CLOSED");
  }

  const data: Prisma.OrderDraftUncheckedUpdateInput = {};

  // Product resolution (deterministic, DB-backed).
  let resolvedProductId = draft.productId;
  if (params.extraction.productName || params.extraction.productId) {
    if (params.extraction.productId) {
      resolvedProductId = params.extraction.productId;
    } else {
      const products = (await db.product.findMany({
        where: { workspaceId: params.workspaceId, isActive: true, isArchived: false },
      })) as unknown as ResolvableProduct[];
      const withAliases = products.map((p) => ({
        ...p,
        aliases: [p.name, ...(((p as unknown as { tags?: string[] }).tags ?? []).filter((t) => t.length > 2))],
      }));
      const resolution = resolveProduct(params.extraction.productName!, withAliases);
      if (resolution.status === "RESOLVED") resolvedProductId = resolution.product!.id;
      else if (resolution.status === "AMBIGUOUS") {
        // Ambiguity → ask, never guess.
        await eventBus.publish(makeEvent("OrderDraftUpdated", params.workspaceId, { draftId: draft.id, ambiguous: true }));
        return { draft, ambiguousCandidates: resolution.candidates!.map((c) => c.name) };
      }
      // NOT_FOUND keeps the previous product (contextual continuation).
    }
  }
  if (resolvedProductId && resolvedProductId !== draft.productId) data.productId = resolvedProductId;

  if (params.extraction.quantity && params.extraction.quantity > 0) {
    data.quantity = params.extraction.quantity;
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
  const refreshed = await db.orderDraft.findUniqueOrThrow({ where: { id: draft.id } }) as typeof draft;
  const missing = computeMissingFields(refreshed);
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
    await eventBus.publish(makeEvent("OrderReadyForConfirmation", params.workspaceId, { draftId: draft.id }));
    return { draft: ready, missingFields: missing, becameReady: true };
  }

  return { draft: final, missingFields: missing };
}

export function computeMissingFields(draft: {
  productId: string | null;
  quantity: number | null;
  phone: string | null;
  rawAddress: string | null;
  province: string | null;
}): RequiredDraftField[] {
  const missing: RequiredDraftField[] = [];
  if (!draft.productId) missing.push("product");
  if (!draft.quantity || draft.quantity <= 0) missing.push("quantity");
  if (!draft.phone) missing.push("phone");
  if (!draft.rawAddress && !draft.province) missing.push("address");
  return missing;
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
  productName?: string | null;
  quantity: number | null;
  phone: string | null;
  rawAddress: string | null;
  province: string | null;
  missingFields: string[];
}): string {
  const lines: string[] = [];
  if (draft.productName) lines.push(`المنتج: ${draft.productName}`);
  if (draft.quantity) lines.push(`الكمية: ${draft.quantity}`);
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
