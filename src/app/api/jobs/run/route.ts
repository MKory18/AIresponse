import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { runJobs } from "@/modules/jobs/handlers";
import { registerAutomationBridge } from "@/modules/automation/engine";
import { timingSafeEqual } from "@/core/crypto";

/**
 * Worker endpoint: processes pending background jobs. In production this is
 * called by a cron/scheduler or a dedicated worker process — never by end
 * users' requests. Protected by a shared secret to keep it simple here.
 */
export const POST = createHandler(
  {
    body: undefined,
    public: true,
    rateLimit: { limit: 30, windowMs: 60_000 },
  },
  async ({ req }) => {
    const secret = process.env.JOBS_SECRET;
    if (secret) {
      const provided = req.headers.get("x-jobs-secret");
      // timing-safe: مقارنة السلاسل مباشرة كانت تفتح قياس زمن التسريب.
      if (!provided || !timingSafeEqual(secret, provided)) {
        return new Response(JSON.stringify({ error: "AUTHORIZATION_ERROR" }), { status: 403 });
      }
    } else if (process.env.NODE_ENV === "production") {
      // Open job-runner in production = remote job-execution trigger.
      return new Response(JSON.stringify({ error: "JOBS_SECRET_NOT_CONFIGURED" }), { status: 403 });
    }
    // Durable automation bridge: trusted domain events → evaluation jobs.
    registerAutomationBridge(prisma);
    const result = await runJobs(prisma, { limit: 10 });
    return ok(result);
  }
);
