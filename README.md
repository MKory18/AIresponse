# AI Commerce Response Engine

منصة SaaS متعددة المستأجرين (Multi-Tenant) تجمع بين: AI Sales Agent (فيسبوك ميسنجر فقط) + Customer Support Inbox + CRM + Product Knowledge Base (RAG) + Order Intelligence + Automation/Follow-ups + Analytics.

**الحالة:** Phases 1–8 مكتملة + Phase 9 hardening (security fixes, worker, headers, secret scan). انظر [SECURITY-AUDIT.md](SECURITY-AUDIT.md) و[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) — بما فيها قائمة **NOT VERIFIED** الصادقة.

## Architecture

```text
Facebook Messenger → Meta Webhook (HMAC verify + idempotency)
  → Conversation Engine (customers via ChannelIdentity, drafts)
  → AI Orchestrator (providers → router → persona → prompts w/ trust boundaries
     → intent/entities (Zod) → memory → RAG → guardrails)
  → Order Intelligence → Rules Engine → OrderService (snapshots, idempotent)
  → Automation Engine → Follow-up Scheduler (atomic claims)
  → HumanHandoff (claim/route/resolve, AI pause invariant)
  → ChannelSender (MessagingPolicy + outbound idempotency) → Graph API
```

**الثوابت:** AI يقترح فقط — لا mutations ولا Graph API مباشرة ولا تحديد recipient/price. Rules = القرار. Services = التنفيذ. DB = مصدر الحقيقة. `HUMAN_ACTIVE` ⇒ صفر ردود AI.

## Stack

Next.js 14 (TypeScript, App Router, RTL) · PostgreSQL + Prisma (+ pgvector) · JWT sessions (jose, HttpOnly cookies) · RBAC granular · Zod · pino · Vitest · Docker.

## Local setup

```bash
cp .env.example .env      # املأ JWT_SECRET + ENCRYPTION_KEY (openssl rand -hex 32)

docker compose up         # app + worker + postgres(pgvector) + redis
# أو للتطوير:
docker compose up -d postgres redis
npm install
npx prisma migrate dev    # migrations
npm run db:seed           # demo: admin@demo.local / Demo#2026!
npm run dev
```

## Worker / Cron

العمليات الخلفية (AI processing, webhook events, follow-ups, automation, aggregation) تُخزن في `BackgroundJob` وتُعالج بواسطة:

- **Worker process** (موصى به): `docker compose up worker` أو `npm run worker` — مع lease recovery للمهام المعلقة وgraceful shutdown (SIGTERM).
- أو cron خارجي: `POST /api/jobs/run` برأس `x-jobs-secret: $JOBS_SECRET`.

## Migrations

```bash
npx prisma migrate dev      # development
npx prisma migrate deploy   # production (يعمل تلقائيًا في Docker)
```

> pgvector: صورة compose تفعّل extension تلقائيًا (`prisma/init/`). لقاعدة خارجية نفّذ `CREATE EXTENSION IF NOT EXISTS vector;` أولًا.

## Meta / Facebook setup (القناة الوحيدة)

1. أنشئ Meta App + أضف Messenger product.
2. `.env`: `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_REDIRECT_URI`.
3. Webhook URL: `https://YOUR_DOMAIN/api/webhooks/meta` — حقول `messages`.
4. من `/channels`: زر «ربط صفحة Facebook» → OAuth → اختيار الصفحة (token يُخزن مشفرًا AES-256-GCM).
5. Smoke test: زر «اختبار الاتصال» (لا يرسل للعملاء).

## Environment variables

مقسمة في [.env.example](.env.example): DATABASE / AUTH / ENCRYPTION / AI (مع model routing) / META / QUEUE / WORKER / STORAGE / OBSERVABILITY. **لا مفاتيح حقيقية في Git — `npm run scan:secrets` للفحص.**

## Testing

```bash
npm test              # 210 tests (unit + integration-style over fake DB + mock Meta/AI)
npm run scan:secrets  # secret scanning
npm run typecheck && npm run lint && npm run build
```

سلاسل E2E مُغطاة بالـ mocks: Facebook webhook → customer/conversation → AI → order draft → confirmation → Rules → Order → automation → follow-up → Facebook send — مع idempotency وتزامن (replay ×100، claims ×100، HUMAN_ACTIVE ×100).

## Deployment

`docker compose up` يشغّل: app (healthcheck `/api/health`) + worker + postgres(pgvector) + redis. Migrations تُطبق عند الإقلاع. **لا يُعتبر Production-Ready حتى تنفيذ قائمة NOT VERIFIED في SECURITY-AUDIT.md** (real DB/HTTP E2E, load, backup/restore, Meta credentials).

## Security

- Sessions HttpOnly/Secure/SameSite · CSRF origin check · CSP/security headers · payload limits.
- RBAC granular (~35 permission) + workspace scope server-side في كل query.
- Secrets مشفرة (AES-256-GCM)، redaction في logs، error handler لا يسرّب internals.
- Webhook HMAC-SHA256 constant-time · OAuth state موقّع 10m · outbound idempotent.
- التفاصيل: [SECURITY-AUDIT.md](SECURITY-AUDIT.md).

## Troubleshooting

- `Invalid environment configuration` → أكمل `.env`.
- Migration يفشل على `vector(1536)` → pgvector غير مثبت (انظر أعلاه).
- رسائل لا تُرسل → افحص `/channels` (اتصال/توكن) و`/api/analytics/queue` للـ backlog.
- Follow-ups لا تُرسل → تأكد أن worker يعمل وأن نافذة 24h مفتوحة (MessagingPolicy).
