/**
 * Domain EventBus abstraction.
 *
 * Phase 2 ships an in-process implementation; the same interface can be backed
 * by Redis pub/sub / BullMQ events / SSE later without touching publishers.
 * Handler errors are isolated and logged — a failing listener must never break
 * the publishing operation.
 */
import { childLogger } from "@/core/logger";

const log = childLogger("events");

export const DOMAIN_EVENTS = [
  "CustomerCreated",
  "CustomerUpdated",
  "ConversationCreated",
  "ConversationUpdated",
  "ConversationAssigned",
  "ConversationResolved",
  "MessageReceived",
  "MessageCreated",
  "MessageRead",
  "ProductCreated",
  "ProductUpdated",
  "MediaCreated",
  "MediaDeleted",
  "FeedbackCreated",
  "FeedbackUpdated",
  "KnowledgeDocumentCreated",
  "KnowledgeDocumentUpdated",
  "OrderDraftCreated",
  "OrderDraftUpdated",
  "OrderReadyForConfirmation",
  "OrderConfirmed",
  "OrderCreated",
  "OrderCancelled",
  "OrderDuplicateDetected",
  "OrderStateChanged",
  // P12 — الطلب انربط بالـ OMS يدويًا (مش تحديث حالة — ما بيشغّل محفّزات الحالة).
  "OrderOmsLinked",
] as const;

export type DomainEventName = (typeof DOMAIN_EVENTS)[number];

export interface DomainEvent<T = Record<string, unknown>> {
  name: DomainEventName;
  workspaceId: string;
  payload: T;
  occurredAt: Date;
  /**
   * P7: deterministic trigger identity (e.g. "MessageReceived:msg-c1").
   * Durable automation/workflow bridges use it as their idempotency key so a
   * redelivered/replayed event can never start a second execution. Events
   * published without one get a NON-deterministic id explicitly marked
   * "volatile" — the bridge must then derive determinism from the payload.
   */
  eventId?: string;
}

/** Derives a stable trigger id from a payload (used when eventId is absent). */
export function deriveEventId(event: Pick<DomainEvent, "name" | "workspaceId" | "payload">): string {
  const p = event.payload as Record<string, unknown>;
  const anchor =
    p.messageId ?? p.orderId ?? p.conversationId ?? p.customerId ?? p.mediaId ?? p.feedbackId ?? p.documentId ?? p.draftId;
  if (typeof anchor === "string" && anchor) return `${event.name}:${anchor}`;
  // Explicitly volatile: only safe for events whose handlers are idempotent.
  return `${event.name}:volatile:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

type EventHandler = (event: DomainEvent) => void | Promise<void>;

type BusBackend = {
  publish(event: DomainEvent): Promise<void>;
  subscribe(name: DomainEventName | "*", handler: EventHandler): () => void;
};

class InMemoryEventBus implements BusBackend {
  private handlers = new Map<string, Set<EventHandler>>();

  subscribe(name: DomainEventName | "*", handler: EventHandler): () => void {
    const key = name === "*" ? "*" : name;
    if (!this.handlers.has(key)) this.handlers.set(key, new Set());
    this.handlers.get(key)!.add(handler);
    return () => this.handlers.get(key)?.delete(handler);
  }

  async publish(event: DomainEvent): Promise<void> {
    const targets = [
      ...(this.handlers.get(event.name) ?? []),
      ...(this.handlers.get("*") ?? []),
    ];
    for (const handler of targets) {
      try {
        await handler(event);
      } catch (err) {
        log.error({ err, event: event.name }, "event_handler_failed");
      }
    }
  }
}

const globalForBus = globalThis as typeof globalThis & {
  __acreEventBus?: BusBackend;
};

export const eventBus: BusBackend = globalForBus.__acreEventBus ?? new InMemoryEventBus();

if (process.env.NODE_ENV !== "production") {
  globalForBus.__acreEventBus = eventBus;
}

export function makeEvent<T extends Record<string, unknown>>(
  name: DomainEventName,
  workspaceId: string,
  payload: T
): DomainEvent<T> {
  return { name, workspaceId, payload, occurredAt: new Date() };
}
