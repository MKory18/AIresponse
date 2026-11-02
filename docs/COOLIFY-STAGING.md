# Coolify Staging Deployment Guide

Scope: exact setup for this project (`ai-commerce-response-engine`) on Coolify.
No secrets belong in this document. Status before first real deployment: **STAGING = NOT VERIFIED**.

Architecture (unchanged):

```
GitHub → Coolify → Docker
                  ├── app      (Next.js production build, port 3000)
                  ├── worker   (tsx scripts/worker.ts — durable DB-backed jobs)
                  └── PostgreSQL 16 + pgvector  (separate resource, NOT Odoo's PostgreSQL)
```

No Redis is required. Background jobs are DB-backed (`BackgroundJob` with `lockedAt`/`lockedBy`).

---

## 1. Create PostgreSQL (separate resource)

1. Coolify → **New Resource → Docker Compose / Database → PostgreSQL**.
2. Use an image with pgvector support, e.g. `pgvector/pgvector:pg16` (the plain `postgres:16` image does NOT include the extension — do not use it).
3. Set DB name (e.g. `ai_commerce`), user, and a strong password.
4. Attach a persistent volume to `/var/lib/postgresql/data`.
5. Do **not** expose the DB port publicly unless needed for admin; keep it on the Coolify network.

## 2. Enable pgvector

Before the first `prisma migrate deploy` (the baseline migration now runs
`CREATE EXTENSION IF NOT EXISTS vector;` itself, so the image must ship the
extension — the SQL alone cannot add it to a plain Postgres image).

Confirm the running container is actually a pgvector image (Coolify's
"PGVector" template label is NOT proof — a stale container with the old
`postgres:16` image will still fail with `extension "vector" is not available`):

```sql
SELECT name FROM pg_available_extensions WHERE name = 'vector';  -- must return a row
```

If it returns no rows: change the image to e.g. `pgvector/pgvector:pg16`
(or the PGVector 18 image), **stop and redeploy the database container**, then
re-check. Do not drop the volume.

Verify inside the container:

```bash
psql -U <user> -d ai_commerce -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extname FROM pg_extension WHERE extname='vector';"
```

## 3. Create the Application from GitHub

1. Coolify → **New Resource → Application (GitHub)**, select the repo and branch (default `main`).
2. Build type: **Dockerfile** (the repo's `Dockerfile` handles multi-stage build, prisma generate, and runs as non-root).
3. Port: `3000`.

## 4. Environment Variables

Set on the Coolify application (Values marked SECRET must be generated, never committed):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | **Must point to the Coolify PostgreSQL service hostname**, e.g. `postgresql://<user>:<pass>@<postgres-service>:5432/ai_commerce?schema=public`. Inside Docker, `localhost` is NOT the database. |
| `JWT_SECRET` | SECRET — `openssl rand -hex 32` (min 32 chars). |
| `ENCRYPTION_KEY` | SECRET — `openssl rand -hex 32` (min 32 chars). |
| `APP_URL` | Public staging URL, e.g. `https://staging.example.com` (no trailing slash). |
| `JOBS_SECRET` | SECRET — shared secret for `POST /api/jobs/run`. |
| `WORKER_POLL_INTERVAL_MS` | e.g. `5000`. |
| `STORAGE_PROVIDER` | `local`. |
| `STORAGE_DIR` | e.g. `/app/.data/storage` (must be a persistent volume — see §6). |
| `LOG_LEVEL` | `info`. |
| `AI_PROVIDER` | `openai` (or the provider used in staging). |
| `OPENAI_API_KEY` / other provider keys | SECRET — as configured. |
| `META_APP_ID`, `META_APP_SECRET` | SECRET — required for the real Meta flow; health reports `FACEBOOK_CONFIGURATION_MISSING` without them. |
| `META_WEBHOOK_VERIFY_TOKEN` | SECRET — the token entered in the Meta App webhook UI. |
| `META_REDIRECT_URI`, `META_GRAPH_VERSION` | Optional; defaults derive from `APP_URL` / `v21.0`. |

`REDIS_URL` is optional and unused by the current queue architecture.

## 5. Build / Start Commands

Handled by the Dockerfile — no override needed:

- Build: `npx prisma generate && npm run build`
- App container start: `npx prisma migrate deploy && npm start`
- Worker container: `npx prisma migrate deploy && npm run worker` (`tsx scripts/worker.ts`)

Migrations use `prisma migrate deploy` only (never `db push`).

## 6. Worker

**Recommended path:** deploy the repo's `docker-compose.yml` as a Coolify
**"Docker Compose" resource** — it already defines `app` + `worker` (+ `postgres`)
from this same Dockerfile, with the correct worker start command
(`npx prisma migrate deploy && npm run worker`), shared storage volume,
`restart: unless-stopped`, and no HTTP healthcheck on the worker. No extra
service setup is needed; just set the environment variables (§4) on the
resource — `${DATABASE_URL:-...}` interpolation in the compose file guarantees
the platform-provided `DATABASE_URL` always wins over the local default.

**Alternative (Dockerfile-type app):** add a **second service** from the same
Dockerfile:

- Same image and env vars (including `DATABASE_URL`).
- Start command override: `npx prisma migrate deploy && npm run worker`.
- No inbound port.
- `restart: unless-stopped`.
- **Healthcheck:** the image contains no Dockerfile `HEALTHCHECK` (it is shared by
  the web and worker containers, and an image-level check cannot differ per service).
  Configure health checks per service in Coolify instead:
  - **Web app:** Coolify-managed health check → path `/api/health`, port `3000`
    (30s interval, ~30s start period, 3 retries).
  - **Worker:** health check disabled (non-HTTP process; liveness is visible via the
    `worker_started` / `worker_stopped_cleanly` logs).

The worker must never share the Next.js process — it polls `BackgroundJob` and claims jobs atomically via `lockedAt`/`lockedBy`.

**Env parity is mandatory, not optional.** The worker validates its environment
at runtime (`src/core/env.ts` throws unless `DATABASE_URL`, `JWT_SECRET` (32+),
and `ENCRYPTION_KEY` (32+) are set). A worker service missing any of these
crash-loops (or spins `worker_cycle_failed` without processing jobs) while the
web app keeps running — if `worker_started` never appears in the worker logs,
check env vars first, then the start command.

## 7. Persistent Volumes

| Service | Mount | Purpose |
|---|---|---|
| PostgreSQL | `/var/lib/postgresql/data` | DB data survives restarts. |
| app | `/app/.data/storage` | `LocalStorageProvider` uploads (`STORAGE_DIR`) survive restarts. |
| worker | `/app/.data/storage` (same shared volume) | `process_media` reads asset bytes from storage; job state itself lives in PostgreSQL only. |

## 8–9. Domain & HTTPS

1. Coolify → App → **Domains**: add the staging domain, enable **Let's Encrypt / HTTPS**.
2. Set `APP_URL` to exactly this HTTPS URL (Meta OAuth and webhook callbacks depend on it).

## 10. Health Check

Endpoint: `GET /api/health` (Coolify-managed — the image has no Dockerfile
`HEALTHCHECK`; configure it in Coolify: path `/api/health`, port `3000`,
30s interval, ~30s start period, 3 retries).

- Returns `503` only when the database is unreachable (`DB_UNHEALTHY`).
- Queue pressure is reported WITHOUT failing the probe: `queue: QUEUE_UNHEALTHY`
  (HTTP 200, top-level `DEGRADED`) when `failedJobs > 50`, plus `queueDepth`
  (PENDING count) / `failedJobs` for alerting. A choked queue must page the
  operator (check the worker), never restart-loop the web app.
- In Coolify, set the health check path to `/api/health`.
- "Container running" ≠ healthy; rely on the health endpoint status.

## 11. Migrations

Run automatically at container start via `prisma migrate deploy`.
To run manually from the Coolify terminal on the app container:

```bash
npx prisma migrate deploy
```

## 12. Seed

Idempotent seed:

```bash
npm run db:seed
```

Run once from the app container after migrations. Re-running must not duplicate data.

## 13. Staging Validation (after first deploy)

```bash
bash scripts/staging/validate-staging.sh
```

Then, from a machine that can reach the staging domain:

```bash
BASE_URL=https://STAGING_DOMAIN \
META_APP_SECRET=... \
node scripts/staging/concurrency.mjs
```

Only after these pass is STAGING status upgraded from NOT VERIFIED.

---

## Rules enforced

- Never point `DATABASE_URL` at the Odoo PostgreSQL instance.
- No `prisma db push` in staging/production.
- No secrets in git or in this document.
- App and worker run as separate containers.
