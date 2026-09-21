import { makeEvent, eventBus } from "@/core/events/bus";
import type { Db } from "@/modules/customers/service";

export type RuleVerdict = "ALLOW" | "DENY" | "REQUIRE_INPUT" | "REQUIRE_HUMAN";

export interface RuleResult {
  rule: string;
  verdict: RuleVerdict;
  reason?: string;
  /** For REQUIRE_INPUT: which draft fields are missing. */
  missingFields?: string[];
}

/**
 * Rules Engine — every order action passes through here. The AI can propose;
 * these rules decide. Verdict priority: DENY > REQUIRE_HUMAN > REQUIRE_INPUT > ALLOW.
 */
export async function evaluateOrderRules(
  db: Db,
  params: {
    workspaceId: string;
    draft: {
      productId: string | null;
      quantity: number | null;
      phone: string | null;
      rawAddress: string | null;
      province: string | null;
      missingFields: string[];
      customerId: string;
      conversationId: string;
    };
    maxQuantity?: number;
  }
): Promise<RuleResult[]> {
  const results: RuleResult[] = [];
  const maxQuantity = params.maxQuantity ?? Number(process.env.MAX_ORDER_QUANTITY ?? 100);

  // 1. Required fields
  if (params.draft.missingFields.length > 0) {
    results.push({
      rule: "required_fields",
      verdict: "REQUIRE_INPUT",
      missingFields: params.draft.missingFields,
      reason: "MISSING_FIELDS",
    });
  }

  // 2. Product exists + active + in stock
  if (params.draft.productId) {
    const product = await db.product.findUnique({ where: { id: params.draft.productId } });
    if (!product || product.workspaceId !== params.workspaceId) {
      results.push({ rule: "product_exists", verdict: "DENY", reason: "PRODUCT_NOT_FOUND" });
    } else if (!product.isActive || product.isArchived) {
      results.push({ rule: "product_active", verdict: "DENY", reason: "PRODUCT_INACTIVE" });
    } else if (product.stockStatus === "OUT_OF_STOCK" || product.stockStatus === "DISCONTINUED") {
      results.push({ rule: "product_availability", verdict: "DENY", reason: "OUT_OF_STOCK" });
    }
  }

  // 3. Quantity bounds
  if (params.draft.quantity) {
    if (params.draft.quantity <= 0) {
      results.push({ rule: "quantity_bounds", verdict: "DENY", reason: "NON_POSITIVE" });
    } else if (params.draft.quantity > maxQuantity) {
      results.push({ rule: "quantity_bounds", verdict: "DENY", reason: "EXCEEDS_MAX" });
    }
  }

  // 4. Delivery availability
  if (params.draft.province) {
    const rule = await db.deliveryRule.findFirst({
      where: { workspaceId: params.workspaceId, province: params.draft.province },
    });
    if (rule && !rule.isAvailable) {
      results.push({ rule: "delivery_availability", verdict: "DENY", reason: "PROVINCE_NOT_SERVED" });
    }
  }

  // 5. Duplicate detection
  const duplicate = await detectDuplicate(db, {
    workspaceId: params.workspaceId,
    customerId: params.draft.customerId,
    conversationId: params.draft.conversationId,
    productId: params.draft.productId,
    quantity: params.draft.quantity,
  });
  if (duplicate === "LIKELY") {
    results.push({ rule: "duplicate_order", verdict: "REQUIRE_HUMAN", reason: "DUPLICATE_LIKELY" });
  } else if (duplicate === "POSSIBLE") {
    results.push({ rule: "duplicate_order", verdict: "REQUIRE_INPUT", reason: "DUPLICATE_POSSIBLE" });
  }

  if (results.length === 0) {
    results.push({ rule: "all_checks", verdict: "ALLOW" });
  }
  return results;
}

export function aggregateVerdict(results: RuleResult[]): RuleVerdict {
  if (results.some((r) => r.verdict === "DENY")) return "DENY";
  if (results.some((r) => r.verdict === "REQUIRE_HUMAN")) return "REQUIRE_HUMAN";
  if (results.some((r) => r.verdict === "REQUIRE_INPUT")) return "REQUIRE_INPUT";
  return "ALLOW";
}

export type DuplicateLevel = "NONE" | "POSSIBLE" | "LIKELY";

/**
 * DuplicateDetector — signals: same conversation, same customer+product
 * within a time window, same phone+product. LIKELY blocks auto-creation.
 */
export async function detectDuplicate(
  db: Db,
  params: {
    workspaceId: string;
    customerId: string;
    conversationId: string;
    productId: string | null;
    quantity: number | null;
    windowHours?: number;
  }
): Promise<DuplicateLevel> {
  const windowHours = params.windowHours ?? 24;
  const since = new Date(Date.now() - windowHours * 3600_000);

  // Same conversation with a recent non-cancelled order → LIKELY.
  const conversationOrders = await db.order.findMany({
    where: {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      createdAt: { gte: since },
      status: { notIn: ["CANCELLED", "FAILED"] },
    },
    take: 1,
    select: { id: true },
  });
  if (conversationOrders.length > 0) return "LIKELY";

  // Same customer + same product recently → POSSIBLE (LIKELY if same quantity).
  if (params.productId) {
    const recent = await db.order.findMany({
      where: {
        workspaceId: params.workspaceId,
        customerId: params.customerId,
        createdAt: { gte: since },
        status: { notIn: ["CANCELLED", "FAILED"] },
        items: { some: { productId: params.productId } },
      },
      include: { items: { where: { productId: params.productId }, select: { quantity: true } } },
      take: 5,
      orderBy: { createdAt: "desc" },
    });
    if (recent.length > 0) {
      if (
        params.quantity &&
        recent.some((o) => o.items.some((i) => i.quantity === params.quantity))
      ) {
        return "LIKELY";
      }
      return "POSSIBLE";
    }
  }

  return "NONE";
}

export async function publishDuplicateEvent(workspaceId: string, draftId: string, level: DuplicateLevel) {
  if (level !== "NONE") {
    await eventBus.publish(
      makeEvent("ConversationUpdated", workspaceId, { type: "OrderDuplicateDetected", draftId, level })
    );
  }
}
