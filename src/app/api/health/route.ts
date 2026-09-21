import { NextResponse } from "next/server";
import { prisma } from "@/core/db/prisma";
import { getEnv } from "@/core/env";
import { childLogger } from "@/core/logger";

const log = childLogger("health");

/**
 * GET /api/health — operational health, no secrets.
 * Distinguishes: APP_HEALTHY / DB_UNHEALTHY / QUEUE_UNHEALTHY /
 * FACEBOOK_CONFIGURATION_MISSING.
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
  }

  // Facebook configuration (presence only — never values)
  const env = getEnvSafe();
  status.facebook = env.META_APP_ID && env.META_APP_SECRET ? "APP_HEALTHY" : "FACEBOOK_CONFIGURATION_MISSING";

  return NextResponse.json(
    { status: Object.values(status).every((v) => v === "APP_HEALTHY" || v === "FACEBOOK_CONFIGURATION_MISSING") ? "APP_HEALTHY" : "DEGRADED", checks: status },
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
