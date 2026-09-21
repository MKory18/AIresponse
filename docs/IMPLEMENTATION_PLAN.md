# Implementation Plan — AI Commerce Response Engine

## 1. Current State (Audit)

- Working directory was **empty**: no `package.json`, no database, no Prisma, no Docker, no existing UI/API.
- **No existing Order Intelligence Engine found** — the module will be built from scratch as part of the domain modules (Phase 5).
- Conclusion: greenfield build. Nothing to preserve; the plan below defines the full target architecture and the phased path to it.

## 2. Architecture Decision

A single **Next.js (App Router, TypeScript)** application with strict internal layering, instead of a heavy multi-package monorepo at this stage. Rationale:

- Same isolation guarantees (domain modules never import each other's internals; cross-module access only via service interfaces), with far less build/CI overhead.
- Every module boundary is a future extraction point into `packages/*` when scale demands it.

```text
src/
  app/                    # Next.js App Router (UI + API routes = thin controllers)
    (auth)/               # login, register
    (dashboard)/          # dashboard, conversations, orders, products, ... 
    api/                  # REST endpoints — validation + permission check + delegate to services
  core/                   # cross-cutting infrastructure (NO business logic)
    db/                   # prisma client singleton
    env.ts                # zod-validated environment
    logger.ts             # pino structured logging
    errors.ts             # typed error hierarchy + centralized handler
    crypto.ts             # AES-256-GCM secret encryption
    config/               # constants (limits, thresholds)
  modules/
    auth/                 # sessions, passwords, JWT
    workspaces/           # workspace + members + invitations
    rbac/                 # roles, permissions, guards
    customers/            # customer profiles + memory
    conversations/        # conversations + messages + inbox
    products/             # products, variants, media
    media/                # media library
    feedback/             # feedback + testimonials
    knowledge/            # KB + RAG (pgvector)
    orders/               # order intelligence, extraction, state machine, duplicates
    ai/                   # provider abstraction, router, orchestrator, structured output, persona
    channels/             # ChannelAdapter interface + meta/whatsapp/telegram adapters + policies
    rules/                # rules engine (validates every AI action before execution)
    jobs/                 # BullMQ queues + workers
    analytics/            # event tracking + usage
    webhooks/             # signature verification, idempotency, raw event store
  lib/                    # small shared utils

prisma/                   # schema + migrations + seed
tests/                    # unit + integration (vitest), e2e (playwright later phases)
```

**Flow principle (anti-hallucination):**

`UI/API route` → `Zod validation` → `RBAC guard (permission + workspace scope)` → `module service` → `Prisma (every query scoped by workspaceId)`.

The AI is never a source of truth: it **proposes** (structured Zod-validated JSON), the **Rules Engine verifies** (product exists, price current, stock, duplicates, channel policy), and the **Executor acts**.

## 3. Target Stack

| Layer | Choice |
|---|---|
| Frontend/Backend | Next.js 14 (App Router) + TypeScript |
| UI | Tailwind CSS + shadcn/ui, RTL-first |
| DB | PostgreSQL + Prisma ORM (+ pgvector for RAG) |
| Queue | Redis + BullMQ |
| Auth | HttpOnly session cookies (JWT via `jose`), bcrypt password hashing |
| Validation | Zod (input, output, AI structured output) |
| Logging | pino (structured, secret-redacting) |
| Tests | Vitest (unit/integration), Playwright (e2e, later phases) |
| Deploy | Docker + docker-compose (app, postgres, redis) |

## 4. Multi-Tenancy & RBAC

- Every tenant-owned row carries `workspaceId`; **all** service queries are workspace-scoped (enforced by a Prisma extension in later phases + explicit service discipline now).
- Roles: `SUPER_ADMIN, OWNER, ADMIN, MANAGER, SALES_AGENT, SUPPORT_AGENT, VIEWER`.
- Granular permissions (`customers.read`, `orders.write`, `ai.configure`, …) mapped to roles in a single matrix (`src/modules/rbac`); every API route checks permission server-side.

## 5. Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: config, DB schema, auth, workspaces, RBAC, Docker, logging, error handling, tests | ✅ done |
| 2 | Customers (ChannelIdentity), conversations, messages, Inbox UI, EventBus, pipeline | ✅ done |
| 3 | Products studio, Media library + uploads + storage abstraction, Feedback, Knowledge Base + RAG (pgvector), background jobs, AI context builder | ✅ done |
| 4 | AI Response Engine: providers (OpenAI/OpenRouter/Mock), model router, persona, versioned prompts + trust boundaries, intent/entities (Zod-validated), customer memory, summaries, guardrails, orchestrator + queue integration, playground UI | ✅ done |
| 5 | Order Intelligence: OrderDraft persistence, deterministic primitives (phone/quantity/product resolver/confirmation), Pricing + Delivery rules, Rules Engine (ALLOW/DENY/REQUIRE_INPUT/REQUIRE_HUMAN), DuplicateDetector, idempotent OrderService with snapshots, state machines, CRM merge, orders UI + draft card | ✅ done |
| 6 | Facebook Messenger ONLY: official Graph API client, OAuth (signed state, page selection), webhook (HMAC signature, raw persistence, idempotency, fast 200), normalizer, messaging policy (24h window), idempotent outbound sender, connection health/test/disconnect, channels UI | ✅ done |
| 7 | Automation Engine (durable event bridge, deterministic conditions, allowlist templates, idempotent executions, loop prevention, failure isolation), Follow-up scheduler (atomic claim, policy-enforced sends, retry), HumanHandoff (typed reasons, priority floors, atomic claim, routing), human replies via ChannelSender, APIs + UI | ✅ done |
| 8 | Analytics + Usage + Observability: workspace usage metering (event-time increments), DailyWorkspaceAnalytics idempotent rebuild (late events), timezone-aware ranges, FRT/resolution medians, snapshot-based product revenue, funnel with null-safe rates, SLA (configurable), AI cost semantics (null when unpriced), queue metrics, health endpoint, analytics APIs + dashboard pages | ✅ done |
| 9 | Hardening: race-condition fix (concurrent webhook idempotency P2002), stale-job lease recovery + real worker process (SIGTERM), CSRF origin check, CSP/security headers, payload limits, transactions on order creation, secret scan, tenant-isolation sweep + authz matrix + replay/HUMAN tests (×100), SECURITY-AUDIT.md, compose worker service | ✅ done (code) — real-infra verification: NOT VERIFIED (no Docker on this machine) |
| 10 | Staging bring-up: pre-flight نُفّذ — **BLOCKED: Docker unavailable** (لا Postgres credentials متاحة أيضًا). Kit تنفيذي كامل جاهز: `scripts/staging/validate-staging.sh` + `concurrency.mjs` (يُنتج تقرير PASS/FAIL لكل بند فور توفر البيئة) | ⏸ BLOCKED (awaiting infrastructure) |
| 2 | Customers, conversations, messages, inbox UI | next |
| 3 | Products, media library, feedback, knowledge base (RAG) | pending |
| 4 | AI engine: providers, router, persona, orchestrator, structured extraction, memory | pending |
| 5 | Orders: intelligence, extraction, rules engine, state machine, duplicates | pending |
| 6 | Meta (Messenger/IG), WhatsApp Cloud, Telegram adapters + webhooks | pending |
| 7 | Automation, follow-ups, human handoff | pending |
| 8 | Analytics, usage tracking, observability | pending |
| 9 | Security audit, performance, full test matrix | pending |
| 10 | Production deployment | pending |

## 6. Database (Phase 1 deliverable)

Full schema delivered up front (single migration baseline) so later phases add columns/logic, not structural churn: users, workspaces, members (role enum + custom permission overrides), channels + encrypted channel accounts, customers + customer memory (typed: FACT/PREFERENCE/ORDER/SUMMARY/NOTE with source+confidence), conversations/messages, products/variants/media, knowledge docs, feedback, personas, AI settings, orders/items, follow-ups, automations, audit/system/AI-usage logs, webhook events (external event idempotency).

## 7. Security (non-negotiables)

- Zod validation on every input; typed error hierarchy with a single centralized handler.
- Channel credentials encrypted at rest with `ENCRYPTION_KEY` (AES-256-GCM); never logged.
- Webhook signature verification + `externalEventId` idempotency before processing (Phase 6).
- Rate limiting, secure cookies, tenant isolation tests (Phases 6/9).

## 8. Quality Gates

`npm run lint && npm run typecheck && npm test && npm run build` must pass after every phase.
