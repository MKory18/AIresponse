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
    } catch {
      status.worker = "WORKER_UNKNOWN";
    }
  }

  // Facebook configuration (presence only — never values)
  const env = getEnvSafe();
  status.facebook = env.META_APP_ID && env.META_APP_SECRET ? "APP_HEALTHY" : "FACEBOOK_CONFIGURATION_MISSING";

  const healthy = Object.values(status).every(
    (v) => v === "APP_HEALTHY" || v === "FACEBOOK_CONFIGURATION_MISSING" || v === "WORKER_UNKNOWN"
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
