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
import { prisma } from "../src/core/db/prisma";
import { runJobs } from "../src/modules/jobs/handlers";
import { processDueFollowUps } from "../src/modules/automation/followup-service";
import { registerAutomationBridge } from "../src/modules/automation/engine";
import { childLogger } from "../src/core/logger";

const log = childLogger("worker");
const POLL_INTERVAL_RAW = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const POLL_INTERVAL_MS =
  Number.isFinite(POLL_INTERVAL_RAW) && POLL_INTERVAL_RAW >= 1000 ? POLL_INTERVAL_RAW : 5000;
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
  const result = await runJobs(prisma, { limit: 10, workerId: WORKER_ID });
  lastProcessed = result.processed;
  lastFailed = result.failed;
  await processDueFollowUps(prisma, 10);
  cycles += 1;
  if (cycles % HEARTBEAT_EVERY_CYCLES === 0) {
    log.info(
      {
        workerId: WORKER_ID,
        uptimeMs: Date.now() - startedAt,
        cycles,
        lastProcessed,
        lastFailed,
        pollIntervalMs: POLL_INTERVAL_MS,
      },
      "worker_heartbeat"
    );
  }
}

async function main(): Promise<void> {
  log.info({ workerId: WORKER_ID, pollIntervalMs: POLL_INTERVAL_MS }, "worker_started");
  registerAutomationBridge(prisma);

  while (!stopping) {
    currentCycle = cycle();
    try {
      await currentCycle;
    } catch (err) {
      log.error({ err }, "worker_cycle_failed");
    } finally {
      currentCycle = null;
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
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

void main();
