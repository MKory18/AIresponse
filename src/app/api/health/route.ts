import { NextResponse } from "next/server";
import { prisma } from "@/core/db/prisma";
import { getEnv } from "@/core/env";
import { childLogger } from "@/core/logger";
import { evaluateWorkerHealth } from "@/modules/jobs/worker-health";

const log = childLogger("health");

/**
 * GET /api/health — operational health, no secrets.
 * Distinguishes: APP_HEALTHY / DB_UNHEALTHY / QUEUE_UNHEALTHY /
 * WORKER_STALE / FACEBOOK_CONFIGURATION_MISSING.
 */
export async function GET() {
  const status: Record<string, string> = {};
  let httpStatus = 200;

  // DB
  try {
    await prisma.$queryRaw`SELECT 1`;
    status.database = "APP_HEALTHY";
  } catch (err) {
    status.database = "DB_UNHEALTHY";
    httpStatus = 503;
    log.error({ err }, "health_db_unhealthy");
  }

  // Schema readiness — catches a deployed app running against an older DB
  // (the most common cause of "AI stopped replying" after a migration release).
  if (status.database === "APP_HEALTHY") {
    try {
      const rows = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('Customer', 'Order', 'OrderItem', 'OrderDraft', 'TelegramOrderSettings')
      `;
      const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
      const required = [
        "Customer.memoryResetAt",
        "Customer.memoryVersion",
        "Order.orderBatchId",
        "OrderItem.offerNameSnapshot",
        "OrderDraft.items",
        "TelegramOrderSettings.workspaceId",
      ];
      const missing = required.filter((k) => !have.has(k));
      status.schema = missing.length === 0 ? "APP_HEALTHY" : "DB_SCHEMA_OUTDATED";
      if (missing.length > 0) {
        httpStatus = 503;
        log.error({ missing }, "health_db_schema_outdated");
      }
    } catch {
      status.schema = "DB_SCHEMA_UNKNOWN";
    }
  }

  // Queue depth (only meaningful if DB is reachable)
  if (status.database === "APP_HEALTHY") {
    try {
      const failed = await prisma.backgroundJob.count({ where: { status: "FAILED" } });
      const pending = await prisma.backgroundJob.count({ where: { status: "PENDING" } });
      status.queue = failed > 50 ? "QUEUE_UNHEALTHY" : "APP_HEALTHY";
      status.queueDepth = String(pending);
      status.failedJobs = String(failed);
    } catch {
      status.queue = "QUEUE_UNHEALTHY";
    }

    // المرحلة ٣ — صحة العامل من أحدث نبضة. متوقف = 503 + تنبيه باللوج.
    try {
      const heartbeat = await prisma.workerHeartbeat.findFirst({
        orderBy: { lastCycleAt: "desc" },
        select: { lastCycleAt: true, workerId: true },
      });
      const staleRaw = Number(process.env.WORKER_STALE_MS ?? 120_000);
      const staleMs = Number.isFinite(staleRaw) && staleRaw >= 5_000 ? staleRaw : 120_000;
      const health = evaluateWorkerHealth(heartbeat?.lastCycleAt ?? null, Date.now(), staleMs);
      status.worker = health.status;
      if (health.ageMs != null) status.workerAgeMs = String(health.ageMs);
      if (health.status === "WORKER_STALE") {
        httpStatus = 503;
        log.error({ ageMs: health.ageMs, workerId: heartbeat?.workerId }, "health_worker_stale");
      }
      // No heartbeat at all = the worker was never started (or cannot write
      // its heartbeat). This must be degraded, not silently "healthy".
      if (health.status === "WORKER_UNKNOWN") {
        httpStatus = 503;
        log.error("health_worker_unknown");
      }
    } catch {
      status.worker = "WORKER_UNKNOWN";
    }
  }

  // Facebook configuration (presence only — never values)
  const env = getEnvSafe();
  status.facebook = env.META_APP_ID && env.META_APP_SECRET ? "APP_HEALTHY" : "FACEBOOK_CONFIGURATION_MISSING";

  const healthy = Object.values(status).every(
    (v) => v === "APP_HEALTHY" || v === "FACEBOOK_CONFIGURATION_MISSING"
  );
  return NextResponse.json(
    { status: healthy && httpStatus === 200 ? "APP_HEALTHY" : "DEGRADED", checks: status },
    { status: httpStatus }
  );
}

function getEnvSafe(): Record<string, string | undefined> {
  try {
    const env = getEnv();
    return { META_APP_ID: env.META_APP_ID, META_APP_SECRET: env.META_APP_SECRET };
  } catch {
    return {};
  }
}
