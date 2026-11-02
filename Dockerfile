# syntax=docker/dockerfile:1

# ── deps ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
# openssl3 + libc6-compat: required so Prisma 5.22 detects OpenSSL on musl
# (prevents the libquery_engine-linux-musl.so.node fallback failure).
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
# OCR-2026-10-16: npm ci فقط — انحراف الاتزان (package-lock.json) يقف
# صريحًا بدل بناء بصمت بمكتبات مختلفة عن الـ CI.
RUN npm ci

# ── build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# No secrets at build time: all getEnv() calls happen at request time,
# so `next build` does not need DATABASE_URL / JWT_SECRET / ENCRYPTION_KEY.
RUN npx prisma generate && npm run build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
# src is required at runtime only by prisma/seed.ts (npm run db:seed),
# which tsx executes from source (no tsconfig path aliases used).
COPY --from=builder /app/src ./src
# scripts/worker.ts is the background-job consumer (npm run worker) for the
# separate worker container; tsx runs it from source.
# Production dependency guard: `tsx` and the `prisma` CLI MUST stay in
# package.json `dependencies` (not devDependencies) — the worker start command
# (`npx prisma migrate deploy && npm run worker`) needs both, while the web
# app (`npm start`) needs neither. Any production prune of devDependencies
# would otherwise silently kill the worker while the web app keeps running.
COPY --from=builder /app/scripts ./scripts
# tsconfig.json defines the @/* path aliases used by src/** imports; tsx
# (worker, seed) resolves them by reading tsconfig.json at runtime.
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# No image-level health probe: this image is shared by the web container and the
# non-HTTP worker container. Health checks are managed per-service in Coolify
# instead (web: GET /api/health; worker: none). See docs/COOLIFY-STAGING.md.
# Writable data dir for LocalStorageProvider (STORAGE_DIR=/app/.data/storage).
# Pre-created + owned by nextjs so bind/volume mounts inherit usable
# ownership on first mount and uploads never fail with EACCES as non-root.
RUN mkdir -p /app/.data/storage && chown -R nextjs:nodejs /app/.data
USER nextjs
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
