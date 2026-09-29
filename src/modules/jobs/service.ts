import type { Prisma } from "@prisma/client";
import { childLogger } from "@/core/logger";
import { recoverStuckOutboundMessages } from "@/modules/channels/outbound";

const log = childLogger("jobs");

export type Db = Prisma.TransactionClient;

export const JOB_TYPES = [
  "process_knowledge_document",
  "analyze_feedback",
  "process_media",
  "process_ai_message",
  "generate_summary",
  "process_webhook_event",
  "evaluate_automation",
  "process_due_followups",
  "aggregate_workspace_analytics",
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export interface EnqueuedJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export async function enqueueJob(
  db: Db,
  params: { workspaceId: string; type: JobType; payload: Record<string, unknown>; runAfter?: Date }
): Promise<EnqueuedJob> {
  const job = await db.backgroundJob.create({
    data: {
      type: params.type,
      workspaceId: params.workspaceId,
      payload: params.payload as Prisma.InputJsonValue,
      ...(params.runAfter ? { runAfter: params.runAfter } : {}),
    },
  });
  log.info({ jobId: job.id, type: params.type }, "job_enqueued");
  return { id: job.id, type: params.type, payload: params.payload };
}

export interface JobResult {
  success: boolean;
  error?: string;
}

export type JobHandler = (payload: Record<string, unknown>, jobId: string) => Promise<JobResult>;

/**
 * Processes pending jobs (oldest first). Each job is claimed atomically-ish by
 * transitioning PENDING → PROCESSING, executed with its handler, and retried
 * up to maxAttempts on failure. Handlers come from the registry passed in, so
 * this module stays free of domain imports (no cycles).
 */
/**
 * Recovers stale PROCESSING jobs (worker crashed mid-run): anything locked
 * longer than leaseMinutes goes back to PENDING. Handlers are idempotent,
 * so re-execution is safe (outbound keys, follow-up claims, etc.).
 */
export async function recoverStaleJobs(db: Db, leaseMinutes = 10): Promise<number> {
  const cutoff = new Date(Date.now() - leaseMinutes * 60_000);
  const res = await db.backgroundJob.updateMany({
    where: { status: "PROCESSING", lockedAt: { lt: cutoff } },
    data: { status: "PENDING", lockedAt: null, lockedBy: null },
  });
  if (res.count > 0) log.warn({ recovered: res.count }, "stale_jobs_recovered");
  return res.count;
}

/**
 * Recovers inbound customer messages that never produced a terminal AI
 * decision and have no live AI job — the "never silent" backstop.
 *
 * Covered orphans:
 * - AI-job enqueue failed after the message was persisted (catch+log path).
 * - AI job exhausted all attempts before the AI could answer (pre-send
 *   failures leave no outbound row for the stuck-message recovery).
 * - Worker was down when the message arrived; job row never created.
 *
 * Never re-enqueues:
 * - messages with a terminal RESPONSE decision (SUCCESS/HANDOFF/AI_DISABLED —
 *   replying again would violate handoff/duplicate guarantees);
 * - messages with a live (PENDING/PROCESSING) AI job;
 * - messages in non-AI conversations (disabled/takeover — human track);
 * - messages older than maxAgeHours (no zombie replies to stale threads);
 * - recent AI_FAILED attempts still inside exponential backoff.
 *
 * Retry safety comes from the existing idempotency: a re-run that finds the
 * reply already sent returns SKIPPED_DUPLICATE — never a second customer
 * message. Permanent configuration failures stay visible (OPEN handoff +
 * TRANSIENT/PERMANENT error category in AIUsageLog) and resume automatically
 * once configuration is corrected.
 */
const ORPHAN_MAX_AGE_HOURS = 24;
const ORPHAN_RETRY_BASE_MS = 30_000;
const ORPHAN_RETRY_MAX_MS = 2 * 3600_000;

export async function recoverOrphanedInboundMessages(
  db: Db,
  opts: { maxAgeHours?: number; limit?: number } = {}
): Promise<{ recovered: number; skipped: number }> {
  const maxAgeHours = opts.maxAgeHours ?? ORPHAN_MAX_AGE_HOURS;
  const limit = opts.limit ?? 20;
  const now = Date.now();
  const cutoff = new Date(now - maxAgeHours * 3600_000);

  const candidates = await (db as any).message.findMany({
    where: {
      direction: "INBOUND",
      senderType: "CUSTOMER",
      deletedAt: null,
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "asc" },
    take: limit * 3,
    select: { id: true, conversationId: true, workspaceId: true, createdAt: true },
  });
  if (candidates.length === 0) return { recovered: 0, skipped: 0 };

  const convIds = [...new Set(candidates.map((m: { conversationId: string }) => m.conversationId))];
  const conversations = await (db as any).conversation.findMany({
    where: { id: { in: convIds } },
    select: { id: true, workspaceId: true, aiState: true, aiEnabled: true },
  });
  const convById = new Map(conversations.map((c: { id: string }) => [c.id, c]));

  const messageIds = candidates.map((m: { id: string }) => m.id);
  const logs = await (db as any).aIUsageLog.findMany({
    where: { messageId: { in: messageIds }, purpose: "RESPONSE" },
    select: { messageId: true, status: true, createdAt: true },
  });
  const logsByMessage = new Map<string, { decided: boolean; failCount: number; lastFailureAt: number }>();
  for (const l of logs) {
    const entry = logsByMessage.get(l.messageId) ?? { decided: false, failCount: 0, lastFailureAt: 0 };
    if (l.status === "SUCCESS" || l.status === "HANDOFF" || l.status === "AI_DISABLED") {
      entry.decided = true;
    } else if (l.status === "AI_FAILED") {
      entry.failCount += 1;
      entry.lastFailureAt = Math.max(entry.lastFailureAt, new Date(l.createdAt).getTime() || 0);
    }
    logsByMessage.set(l.messageId, entry);
  }

  // Live AI jobs (a redelivery race reuses the same idempotency — but don't
  // stack duplicate jobs when one is already queued/running).
  const liveJobs = await (db as any).backgroundJob.findMany({
    where: { type: "process_ai_message", status: { in: ["PENDING", "PROCESSING"] } },
    take: 200,
    select: { payload: true },
  });
  const liveMessageIds = new Set<string>();
  for (const j of liveJobs) {
    const mid = (j.payload as { messageId?: unknown } | null)?.messageId;
    if (typeof mid === "string") liveMessageIds.add(mid);
  }

  let recovered = 0;
  let skipped = 0;
  for (const m of candidates) {
    if (recovered >= limit) break;
    const conv = convById.get(m.conversationId) as
      | { workspaceId: string; aiState: string; aiEnabled: boolean }
      | undefined;
    if (!conv || conv.workspaceId !== m.workspaceId || !conv.aiEnabled || conv.aiState !== "AI_ACTIVE") {
      skipped += 1;
      continue;
    }
    const state = logsByMessage.get(m.id);
    if (state?.decided || liveMessageIds.has(m.id)) {
      skipped += 1;
      continue;
    }
    if (state && state.failCount > 0) {
      const backoffMs = Math.min(ORPHAN_RETRY_BASE_MS * 2 ** Math.min(state.failCount, 10), ORPHAN_RETRY_MAX_MS);
      if (now - state.lastFailureAt < backoffMs) {
        skipped += 1;
        continue;
      }
    }
    await enqueueJob(db, {
      workspaceId: m.workspaceId,
      type: "process_ai_message",
      payload: { conversationId: m.conversationId, messageId: m.id, recovered: "orphan-sweep" },
    });
    recovered += 1;
  }

  if (recovered > 0) {
    log.info({ recovered, skipped }, "orphaned_inbound_recovered");
  }
  return { recovered, skipped };
}

export async function processPendingJobs(
  db: Db,
  handlers: Record<string, JobHandler>,
  opts: { limit?: number; workerId?: string } = {}
): Promise<{ processed: number; failed: number }> {
  await recoverStaleJobs(db);
  // Recover stuck outbound messages across all workspaces before processing new jobs
  await recoverStuckOutboundMessages(db, { maxAgeMinutes: 10, limit: 20 });
  // Durable backstop: re-queue inbound messages that never reached a terminal
  // AI decision (enqueue failure, exhausted job attempts, worker downtime).
  await recoverOrphanedInboundMessages(db, { maxAgeHours: 24, limit: 20 });
  const jobs = await db.backgroundJob.findMany({
    where: { status: "PENDING", runAfter: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 10,
  });

  let processed = 0;
  let failed = 0;

  for (const job of jobs) {
    // Atomic claim: only PENDING jobs can transition. Concurrent workers
    // racing on the same row get count===0 and skip it.
    const claimed = await db.backgroundJob.updateMany({
      where: { id: job.id, status: "PENDING" },
      data: {
        status: "PROCESSING",
        startedAt: new Date(),
        attempts: { increment: 1 },
        lockedAt: new Date(),
        lockedBy: opts.workerId ?? "worker",
      },
    });
    if (claimed.count === 0) continue;

    const handler = handlers[job.type];
    let result: JobResult;
    try {
      if (!handler) {
        result = { success: false, error: `No handler registered for job type ${job.type}` };
      } else {
        result = await handler(job.payload as Record<string, unknown>, job.id);
      }
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (result.success) {
      await db.backgroundJob.update({
        where: { id: job.id },
        data: { status: "DONE", finishedAt: new Date(), lastError: null },
      });
      processed += 1;
    } else {
      failed += 1;
      // attempts was incremented at claim time; re-read for accuracy.
      const fresh = await db.backgroundJob.findUnique({
        where: { id: job.id },
        select: { attempts: true, maxAttempts: true },
      });
      const attempts = fresh?.attempts ?? job.attempts + 1;
      const maxAttempts = fresh?.maxAttempts ?? job.maxAttempts;
      const exhausted = attempts >= maxAttempts;
      // Exponential backoff: 30s, 60s, 120s... capped at 10min.
      const backoffMs = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 600_000);
      await db.backgroundJob.update({
        where: { id: job.id },
        data: {
          status: exhausted ? "FAILED" : "PENDING",
          lastError: result.error ?? "unknown error",
          ...(exhausted ? { finishedAt: new Date() } : { runAfter: new Date(Date.now() + backoffMs), lockedAt: null, lockedBy: null }),
        },
      });
      log.warn({ jobId: job.id, type: job.type, error: result.error, exhausted }, "job_failed");
    }
  }

  return { processed, failed };
}
