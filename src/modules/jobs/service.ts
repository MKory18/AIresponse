import type { Prisma } from "@prisma/client";
import { childLogger } from "@/core/logger";

const log = childLogger("jobs");

export type Db = Prisma.TransactionClient;

export const JOB_TYPES = [
  "process_knowledge_document",
  "analyze_feedback",
  "process_media",
  "process_ai_message",
  "generate_summary",
  "process_webhook_event",
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

export async function processPendingJobs(
  db: Db,
  handlers: Record<string, JobHandler>,
  opts: { limit?: number; workerId?: string } = {}
): Promise<{ processed: number; failed: number }> {
  await recoverStaleJobs(db);
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
