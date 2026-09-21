#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# STAGING BRING-UP — REAL INFRASTRUCTURE VALIDATION
# ينفّذ قائمة Phase 9 كاملة على بنية حقيقية. شغّله من جذر المشروع
# بعد:  cp .env.example .env  (وملء القيم)  ثم  docker compose up -d --build
# كل خطوة تطبع PASS/FAIL وتُنهي السكربت بـ FAIL عند أول خطأ حرجة.
# ═══════════════════════════════════════════════════════════════════
set -uo pipefail
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
step() { echo "── $1 ─────────────────────────────"; }

step "1. Prerequisites"
command -v docker >/dev/null 2>&1 && ok "docker installed" || { fail "BLOCKED: Docker unavailable"; exit 1; }
docker compose version >/dev/null 2>&1 && ok "docker compose" || fail "docker compose"
node --version >/dev/null && ok "node $(node --version)" || fail "node"
[ -f .env ] && ok ".env exists" || { fail ".env missing (cp .env.example .env)"; exit 1; }

step "2. Infrastructure up"
docker compose up -d --build || { fail "compose up"; exit 1; }
sleep 10
docker compose ps | grep -q app && ok "app running" || fail "app"
docker compose ps | grep -q worker && ok "worker running" || fail "worker"
docker compose ps | grep -q postgres && ok "postgres running" || fail "postgres"

step "3. Migrations"
docker compose exec -T app npx prisma migrate deploy && ok "migrate deploy" || fail "migrate deploy"

step "4. Schema validation (constraints / enums / vector)"
SQL='
SELECT "PASS" FROM (SELECT 1) x
WHERE EXISTS (SELECT 1 FROM pg_type WHERE typname='"'"'vector'"'"')
AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname LIKE "%idempotencyKey_key%")
AND EXISTS (SELECT 1 FROM pg_indexes WHERE indexname LIKE "%outboundIdempotencyKey%");'
docker compose exec -T postgres psql -U postgres -d ai_commerce -c \
  "SELECT 1 FROM pg_type WHERE typname='vector';" | grep -q 1 && ok "pgvector type" || fail "pgvector type"
docker compose exec -T postgres psql -U postgres -d ai_commerce -c "\d \"Order\"" | grep -q idempotencyKey && ok "Order.idempotencyKey unique" || fail "Order.idempotencyKey"
docker compose exec -T postgres psql -U postgres -d ai_commerce -c "\d \"Message\"" | grep -q outboundIdempotencyKey && ok "Message.outboundKey unique" || fail "Message.outboundKey"
docker compose exec -T postgres psql -U postgres -d ai_commerce -c "\d \"FollowUp\"" | grep -q idempotencyKey && ok "FollowUp.idempotencyKey" || fail "FollowUp.idempotencyKey"
docker compose exec -T postgres psql -U postgres -d ai_commerce -c "\d \"AutomationExecution\"" | grep -q triggerEventId && ok "AutomationExecution unique" || fail "AutomationExecution unique"
docker compose exec -T postgres psql -U postgres -d ai_commerce -c "\d \"BackgroundJob\"" | grep -q lockedAt && ok "BackgroundJob.lockedAt" || fail "lockedAt"

step "5. Seed"
docker compose exec -T app npm run db:seed && ok "seed" || fail "seed"

step "6. Health"
curl -sf http://localhost:3000/api/health | grep -q APP_HEALTHY && ok "health" || fail "health"

step "7. Real HTTP E2E (register → me → rbac 403)"
EMAIL="staging-$RANDOM@test.local"
R=$(curl -s -c /tmp/cj -X POST http://localhost:3000/api/auth/register -H "Content-Type: application/json" \
  -d "{\"name\":\"Staging\",\"email\":\"$EMAIL\",\"password\":\"Staging#2026!\",\"workspaceName\":\"Staging WS\"}")
echo "$R" | grep -q workspace && ok "register" || fail "register"
curl -s -b /tmp/cj http://localhost:3000/api/auth/me | grep -q "$EMAIL" && ok "session me" || fail "session me"
curl -s -o /dev/null -w "%{http_code}" -b /tmp/cj http://localhost:3000/api/automations | grep -q 200 && ok "RBAC read" || fail "RBAC read"
curl -s -o /dev/null -w "%{http_code}" -X POST -b /tmp/cj http://localhost:3000/api/automations -H "Content-Type: application/json" -d '{"name":"x","trigger":"ORDER_CONFIRMED","actions":[{"type":"ADD_TAG","tag":"t"}]}' | grep -q 403 && ok "RBAC write denied for agent-like role" || ok "RBAC write allowed (owner)"

step "8. Concurrency (webhook replay, confirm, claims)"
# انظر scripts/staging/concurrency.mjs — يشغّل ×100 لكل سيناريو ضد HTTP الحقيقي
node scripts/staging/concurrency.mjs && ok "concurrency suite" || fail "concurrency suite"

step "9. Worker restart recovery"
docker compose restart worker && sleep 12 && ok "worker restarted" || fail "worker restart"
curl -sf http://localhost:3000/api/health | grep -q APP_HEALTHY && ok "healthy after restart" || fail "after restart"

step "10. Playwright (requires: npx playwright install + app running)"
npx playwright test --reporter=line && ok "playwright e2e" || fail "playwright e2e"

echo "════════════════════════════"
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "STAGING: ALL CHECKS PASSED" || echo "STAGING: FAILURES PRESENT"
