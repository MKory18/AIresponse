# syntax=docker/dockerfile:1

# ── deps ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
# openssl3 + libc6-compat: required so Prisma 5.22 detects OpenSSL on musl
# (prevents the libquery_engine-linux-musl.so.node fallback failure).
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# ── build ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# No secrets at build time: all getEnv() calls happen at request time,
# so `next build` does not need DATABASE_URL / JWT_SECRET / ENCRYPTION_KEY.
RUN npx prisma generate && npm run build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
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
COPY --from=builder /app/scripts ./scripts

USER nextjs
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
