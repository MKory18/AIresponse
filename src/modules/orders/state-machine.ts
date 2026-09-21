import type { OrderStatus, OrderDraftState } from "@prisma/client";
import { AppError } from "@/core/errors";

/**
 * OrderStateMachine — transitions are validated, never arbitrary.
 * AI cannot move an order through invalid paths.
 */
const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  NEW: ["CONFIRMATION_PENDING", "CONFIRMED", "CANCELLED", "FAILED"],
  CONFIRMATION_PENDING: ["CONFIRMED", "CANCELLED", "FAILED"],
  CONFIRMED: ["PROCESSING", "CANCELLED", "FAILED"],
  PROCESSING: ["OUT_FOR_DELIVERY", "CANCELLED", "FAILED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED", "RETURNED"],
  DELIVERED: ["RETURNED"],
  CANCELLED: [],
  FAILED: [],
  RETURNED: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) {
    throw new AppError(
      `Invalid order transition: ${from} → ${to}`,
      422,
      "INVALID_ORDER_TRANSITION"
    );
  }
}

const DRAFT_TRANSITIONS: Record<OrderDraftState, OrderDraftState[]> = {
  EMPTY: ["COLLECTING", "CANCELLED"],
  COLLECTING: ["READY", "CANCELLED"],
  READY: ["CONFIRMING", "COLLECTING", "CANCELLED"],
  CONFIRMING: ["CONFIRMED", "COLLECTING", "CANCELLED"],
  CONFIRMED: ["CONVERTED", "CANCELLED"],
  CONVERTED: [],
  CANCELLED: [],
};

export function canTransitionDraft(from: OrderDraftState, to: OrderDraftState): boolean {
  return DRAFT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertDraftTransition(from: OrderDraftState, to: OrderDraftState): void {
  if (!canTransitionDraft(from, to)) {
    throw new AppError(
      `Invalid draft transition: ${from} → ${to}`,
      422,
      "INVALID_DRAFT_TRANSITION"
    );
  }
}
