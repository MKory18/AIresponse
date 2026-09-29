-- Durable AI-job idempotency: at most one ACTIVE (PENDING/PROCESSING)
-- BackgroundJob per deterministic idempotency key (e.g. "ai:<messageId>").
--
-- PARTIAL unique index on purpose: a FAILED or DONE job must NOT occupy the
-- key (the orphan sweeper legitimately re-enqueues after exhaustion), while
-- two concurrent recovery paths (sweeper, webhook enqueue, second worker)
-- must never create two active jobs for the same unit of work.
--
-- NOTE FOR FUTURE `prisma migrate dev` RUNS: the partial index cannot be
-- expressed in the Prisma schema DSL. If migrate dev proposes dropping
-- "BackgroundJob_idempotencyKey_active_key", keep the index — re-add it or
-- edit the generated migration to preserve it.
ALTER TABLE "BackgroundJob" ADD COLUMN "idempotencyKey" TEXT;

CREATE INDEX "BackgroundJob_idempotencyKey_idx" ON "BackgroundJob"("idempotencyKey");

CREATE UNIQUE INDEX "BackgroundJob_idempotencyKey_active_key"
  ON "BackgroundJob"("idempotencyKey")
  WHERE "status" IN ('PENDING', 'PROCESSING');