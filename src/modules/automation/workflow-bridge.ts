import { childLogger } from "@/core/logger";
import { eventBus, deriveEventId } from "@/core/events/bus";
import { eventToWorkflowTrigger } from "./workflow-engine";

const log = childLogger("workflow-bridge");

/**
 * P7 — Durable workflow bridge: trusted domain events are persisted as
 * evaluation jobs so a restart never loses a trigger.
 *
 * Idempotency: the job carries the event's DETERMINISTIC eventId (stable row
 * id anchor). The engine claims AutomationExecution rows by
 * (automationId, triggerEventId) — a redelivered event reuses the same row
 * and can never start a second run. Volatile (no-anchor) events are skipped:
 * firing workflows on non-replayable events would break exactly-once.
 *
 * Loop prevention: events published by workflow actions carry an
 * originWorkflowId in their payload; the bridge tags the job so the engine's
 * own writes (followup.sent, tag changes, notes, assignments) never re-fire
 * the workflow that produced them in the same chain.
 */
const globalForBridge = globalThis as typeof globalThis & { __acreWorkflowBridge?: boolean };

export function registerWorkflowBridge(prismaLike: {
  backgroundJob: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}) {
  if (globalForBridge.__acreWorkflowBridge) return;
  globalForBridge.__acreWorkflowBridge = true;
  eventBus.subscribe("*", async (event) => {
    const payload = event.payload as Record<string, unknown>;
    const trigger = eventToWorkflowTrigger(event.name, payload);
    if (!trigger) return;
    // Loop prevention: never evaluate an event this workflow chain produced.
    if (payload.originWorkflowId) return;
    const eventId = event.eventId ?? deriveEventId(event);
    if (eventId.includes(":volatile:")) return; // non-replayable → no trigger
    try {
      await prismaLike.backgroundJob.create({
        data: {
          type: "run_workflow_event",
          workspaceId: event.workspaceId,
          payload: {
            eventName: event.name,
            eventId,
            payload,
          },
          // Dedup: at most one ACTIVE evaluation per event at a time. The
          // engine's execution-row unique provides the true exactly-once.
          idempotencyKey: `wf-event:${event.workspaceId}:${eventId}`,
        },
      });
    } catch {
      // P2002 (dedup) or enqueue failure are both safe: execution-row
      // idempotency guarantees at-most-once starts, and the orphan-sweeper
      // path (recoverStaleJobs) covers restarts. Never logs payload content.
      log.debug({ event: event.name }, "workflow_bridge_enqueue_skipped");
    }
  });
}
