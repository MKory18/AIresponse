/**
 * Production worker process.
 *
 *   node --import tsx scripts/worker.ts     (or npm run worker)
 *
 * Loop: recover stale jobs → run pending jobs → process due follow-ups →
 * sleep. Survives restarts: every unit of work is persisted in the DB and
 * every handler is idempotent.
 *
 * Graceful shutdown on SIGTERM/SIGINT: stop claiming new work, finish the
 * current cycle, close the DB connection, exit 0.
 */
import cluster from "node:cluster";
import { prisma } from "../src/core/db/prisma";
import { runJobs } from "../src/modules/jobs/handlers";
import { nextPollDelayMs, resolveWorkerProcesses, shouldRunMaintenance } from "../src/modules/jobs/service";
import { processDueFollowUps } from "../src/modules/automation/followup-service";
import { registerAutomationBridge } from "../src/modules/automation/engine";
import { registerWorkflowBridge } from "../src/modules/automation/workflow-bridge";
import { runIntegrationScheduler } from "../src/modules/integrations/scheduler";
import { childLogger } from "../src/core/logger";

const log = childLogger("worker");
const POLL_INTERVAL_RAW = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 500);
const POLL_INTERVAL_MS =
  Number.isFinite(POLL_INTERVAL_RAW) && POLL_INTERVAL_RAW >= 250 ? POLL_INTERVAL_RAW : 500;
// PERF — short re-poll after a full batch (backlog draining); idle cadence
// unchanged. Tunable without code changes; safe default.
const BUSY_POLL_RAW = Number(process.env.WORKER_BUSY_POLL_MS ?? 250);
const BUSY_POLL_MS = Number.isFinite(BUSY_POLL_RAW) && BUSY_POLL_RAW >= 50 ? BUSY_POLL_RAW : 250;
// PERF — heavy maintenance sweeps (stale jobs · stuck outbound · orphaned
// inbound) are backstops, not per-reply work: run once every N cycles instead
// of every cycle. Bounded to >=1; `1` = old behaviour (every cycle).
const MAINTENANCE_EVERY_RAW = Number(process.env.WORKER_MAINTENANCE_EVERY_CYCLES ?? 10);
const MAINTENANCE_EVERY =
  Number.isFinite(MAINTENANCE_EVERY_RAW) && MAINTENANCE_EVERY_RAW >= 1 ? Math.trunc(MAINTENANCE_EVERY_RAW) : 10;
// Jobs per fetch (reply jobs and other jobs each take up to this many).
const CYCLE_LIMIT_RAW = Number(process.env.WORKER_CYCLE_LIMIT ?? 50);
const CYCLE_LIMIT =
  Number.isFinite(CYCLE_LIMIT_RAW) && CYCLE_LIMIT_RAW >= 1 ? Math.min(500, Math.trunc(CYCLE_LIMIT_RAW)) : 50;
let consecutiveFailures = 0;
const WORKER_ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;

let stopping = false;
let currentCycle: Promise<void> | null = null;

// Liveness heartbeat: proves the loop is alive and draining (not just the
// process existing). Safe fields only — ids, counts, durations.
const HEARTBEAT_EVERY_CYCLES = 12;
const startedAt = Date.now();
let cycles = 0;
let lastProcessed = 0;
let lastFailed = 0;

async function cycle(): Promise<void> {
  // Finally-safe liveness: the heartbeat counts EVERY cycle attempt, even when
  // a sub-step (jobs or follow-ups) keeps failing — a half-dead worker must
  // never look alive-or-dead ambiguously to operators.
  let jobOutcome: "ok" | "failed" = "ok";
  let followUpOutcome: "ok" | "failed" = "ok";
  try {
    try {
      const result = await runJobs(prisma, {
        limit: CYCLE_LIMIT,
        workerId: WORKER_ID,
        sameCycle: true,
        maintenance: shouldRunMaintenance(cycles, MAINTENANCE_EVERY),
      });
      lastProcessed = result.processed;
      lastFailed = result.failed;
    } catch (err) {
      jobOutcome = "failed";
      throw err;
    } finally {
      try {
        await processDueFollowUps(prisma, 10);
      } catch (err) {
        followUpOutcome = "failed";
        log.error({ err }, "worker_followups_failed");
      }
      // P12 — صندوق الصادر للأنظمة + الإنذارات والتقارير الدورية (idempotent).
      try {
        await runIntegrationScheduler(prisma);
      } catch (err) {
        log.error({ err }, "worker_integrations_failed");
      }
      cycles += 1;
      if (cycles % HEARTBEAT_EVERY_CYCLES === 0) {
        log.info(
          {
            workerId: WORKER_ID,
            uptimeMs: Date.now() - startedAt,
            cycles,
            lastProcessed,
            lastFailed,
            jobOutcome,
            followUpOutcome,
            pollIntervalMs: POLL_INTERVAL_MS,
          },
          jobOutcome === "ok" ? "worker_heartbeat" : "worker_cycle_failed"
        );
      }
    }
  } finally {
    if (jobOutcome === "ok" && followUpOutcome === "ok") {
      log.info({ workerId: WORKER_ID, cycles, processed: lastProcessed, failed: lastFailed }, "worker_cycle_completed");
    }
  }
}

async function main(): Promise<void> {
  log.info({ workerId: WORKER_ID, pollIntervalMs: POLL_INTERVAL_MS }, "worker_started");
  registerAutomationBridge(prisma);
  registerWorkflowBridge(prisma);

  while (!stopping) {
    currentCycle = cycle();
    try {
      await currentCycle;
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      log.error({ err, consecutiveFailures }, "worker_cycle_failed");
    } finally {
      currentCycle = null;
    }
    if (stopping) break;
    // نبضة العامل — إثبات أن الحلقة حيّة (فحص /health). best-effort.
    try {
      await prisma.workerHeartbeat.upsert({
        where: { workerId: WORKER_ID },
        update: { lastCycleAt: new Date(), cycles, processed: lastProcessed, failed: lastFailed },
        create: { workerId: WORKER_ID, lastCycleAt: new Date(), cycles, processed: lastProcessed, failed: lastFailed },
      });
    } catch (err) {
      log.error({ err }, "worker_heartbeat_failed");
    }
    // PERF — backlog-aware polling: a full batch means more work is likely
    // waiting, so re-poll quickly; otherwise keep the idle cadence exactly.
    // DB outage → back off (max 15s) instead of hammering; never exit.
    const outageDelay = consecutiveFailures > 0 ? Math.min(15_000, 1000 * 2 ** Math.min(consecutiveFailures, 4)) : 0;
    await new Promise((r) =>
      setTimeout(r, outageDelay || nextPollDelayMs({ processed: lastProcessed, failed: lastFailed, limit: CYCLE_LIMIT, idleMs: POLL_INTERVAL_MS, busyMs: BUSY_POLL_MS }))
    );
  }

  // Graceful: wait for the in-flight cycle (bounded).
  const timeout = new Promise((r) => setTimeout(r, 30_000));
  await Promise.race([currentCycle ?? Promise.resolve(), timeout]);
  await prisma.$disconnect();
  log.info({ workerId: WORKER_ID }, "worker_stopped_cleanly");
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "worker_shutdown_requested");
  });
}

/** Runs N worker processes in this container and replaces any that die. */
function superviseWorkerProcesses(count: number): void {
  log.info({ count }, "worker_supervisor_started");
  let shuttingDown = false;
  for (let i = 0; i < count; i++) cluster.fork();
  cluster.on("exit", (child, code, signal) => {
    if (shuttingDown) {
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
      return;
    }
    log.error({ pid: child.process.pid, code, signal }, "worker_process_exited_restarting");
    setTimeout(() => cluster.fork(), 1000);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const child of Object.values(cluster.workers ?? {})) child?.process.kill(signal);
      setTimeout(() => process.exit(0), 35_000);
    });
  }
}

// A transient DB error (e.g. P1001) escaping a detached promise must never kill
// the worker — jobs are durable and recovered by the stale-job sweep.
process.on("unhandledRejection", (err) => {
  log.error({ err }, "worker_unhandled_rejection");
});
process.on("uncaughtException", (err) => {
  log.error({ err }, "worker_uncaught_exception");
});

const WORKER_PROCESSES = resolveWorkerProcesses(process.env.WORKER_PROCESSES);
if (cluster.isPrimary && WORKER_PROCESSES > 1) superviseWorkerProcesses(WORKER_PROCESSES);
else void main();
