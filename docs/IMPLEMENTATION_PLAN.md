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

## P0 Baseline Note (2026-10-09, commit fd59fc6) — appended, history above preserved

P0 inspection found the "Current State" §1 above **outdated**: the directory is NOT empty/greenfield — it holds a mature multi-tenant Next.js 14 app (41 Prisma models counted, 71 API route files counted, 31 test files / 446 tests, 18 dashboard pages). Treat §1–§4 as historical scaffolding, not current truth.

P0 verified live on this machine: `npm test` 446/446 ✅ · typecheck ✅ · lint ✅ · scan:secrets ✅ · `npm run build` (74/74 static pages) ✅. Local DB `ai_commerce@localhost:5432` reachable but **0/7 migrations applied** (read-only `migrate status`) — API-level local verification needs a migration decision. Dev server boots (`next dev -p 3100`, `/login` 200); port 3000 is occupied by an unrelated app (not this repo). Missing: `01/02/03_SYSTEM7_*_v2.md` (Arabic equivalents in `docs/` serve as spec), `docs/SECURITY-AUDIT.md` (root copy authoritative), `.github/` CI. PII masking utility exists but is NOT wired into the AI provider (B3 remainder). Unified `ChannelAdapter` is interface-only (Messenger not migrated). Full feature map + P1 priorities: see `docs/PROGRESS.md` § "P0 — فحص خط الأساس". No product code was modified during P0.

## P1 Hardening Note (2026-10-10, base fd59fc6) — appended, history preserved

P1 implemented hardening without behavior change (full gates: 476/476 tests · typecheck · lint · scan:secrets · build, all green):
- PII privacy gate (`ai/privacy-gate.ts`) wired into every external-model path (orchestrator, playground, summary jobs, OpenAI embeddings) + `UNVERIFIED_CONTACT` guardrail + 12 provider-path tests.
- Local dev DB diagnosed (dedicated, proven empty) → `migrate deploy` 7/7 → `db:seed` fixed (local `.env` secrets regenerated hex-only after dotenv `#` truncation broke them) → live smoke on real Postgres (health/login/inbox/RAG/rate-limit/worker).
- Real-pgvector bug fixed (`c."workspaceId"` quoting) + SQL regression tests.
- CI added (`.github/workflows/ci.yml`: verify + pgvector migrate-check jobs; Actions run itself BLOCKED on push/PR).
- Rate limiter rewritten as one atomic upsert + explicit fail-closed policy for login/register + 7 tests.
- Splits: `conversations/service.ts` → `inbound.ts`+`threads.ts`+barrel; `orchestrator.ts` → `stages/{state,gating,extraction,response}.ts`+sequencer (verbatim logic, compatible re-exports).
- Real channel registry (`facebook/adapter.ts` + fail-closed `registry.ts`, mock by explicit opt-in only) + 8 tests; migrating live webhook/outbound flows onto it deferred to P5.
- Test hermeticity fixed (`tests/setup.ts` neutralizes Prisma dotenv side-loading of local `.env`).
Full map, evidence and staging checklist: `docs/PROGRESS.md` §P1. Security deltas: root `SECURITY-AUDIT.md` §P1 addendum. No P2 work started.

## P1.1 Closure Note (2026-10-10) — appended, history preserved

P1.1 closed the two P1 remarks without new features (gates: 494/494 tests · typecheck · lint · scan · build, all green):
- Phone-format gap: known values masked in any spelling (normalized digit match + 1–4 digit country prefix), unknown bare 7–8 masked in phone context (±25 chars, safety bias), strict reply scrub with `allowedNumbers` (prices/totals), unified `UNVERIFIED_CONTACT` guardrail; context-free unknown bare runs deliberately left (documented + tested as anti-leak policy) — `tests/p1-phone-formats.test.ts` (14).
- External-AI audit: every live path goes through `sendProtected*`/embedding scrub; `generateVision` has zero callers (dormant, future R02 must gate prompt text); `analyze_feedback` is rule-based; FacebookClient is channel transport, not inference.
- Messenger adapter wired into BOTH live flows: webhook ingest via registry-resolved `receiveNative` (deep-equal output) and `dispatchOutbound` step 7 via registry-resolved sends (same token/recipient/payloads/error classes, graphCode via `raw`); HMAC/idempotency/policy/ordering/recovery untouched; any non-Facebook resolution throws; `tests/p1-channel-registry.test.ts` (12) proves registry-routed receive+send with zero real customer traffic.
Details + blocked items: `docs/PROGRESS.md` §P1.1. No P2 work started.

## P2 OMS Note (2026-10-10) — appended, history preserved

P2 audited and completed the OMS integration locally (gates: 520/520 · typecheck · lint · scan · build, all green; no prod contact, no live OMS calls):
- Contract truth: the Arabic OMS contract marks endpoint names as provisional ("الأسماء النهائية بتنضبط وقت البناء") — nothing invented; paths/auth/pagination/errors/event-ids are documented external requirements (BLOCKED on the OMS side).
- OmsClient: bounded timeout + classified retries (GETs; POSTs only on ambiguous outcomes reusing the idempotencyKey) + read/create/note-only surface.
- Product sync: row validation, per-row isolation, deactivation (never deletion, never on empty feed), oversized-payload refusal, sync timestamps.
- Customers: OMS-true blacklists, OMS-owned lifts only (manual blocks survive), unknown phones skipped.
- Enforcement: blacklist refuses order creation AND handoff (`ORDER_CUSTOMER_BLACKLISTED` + audit); AI still has no direct order path (route-only handoff).
- Handoff: ×100 sequential = 1 POST; ×20 concurrent share one idempotencyKey (server-side dedupe required — external); timeout-then-retry succeeds once.
- Webhook: workspace derived from the order row, HMAC enforced, eventId dedupe via WebhookEvent, stale-out-of-order skip via new nullable `omsStatusAt` (+ migration, dev-only applied).
- Routes: permissions pinned by test (settings.manage / products.write / orders.write); token encrypted, never returned/logged.
Full table + evidence + staging limits: `docs/PROGRESS.md` §P2. No PRODUCTION_VERIFIED for any OMS item. No P3 work started.

## P3 Orgs Note (2026-10-10) — appended, history preserved

P3 audited and completed org/user/team/RBAC locally (gates: 536/536 · typecheck · lint · scan · build, all green; no OMS, no prod):
- Preserved: User/Workspace/WorkspaceMember models, 37-permission RBAC matrix, JWT sessions, fresh per-request auth with ACTIVE-only gate, workspace create/list/switch, server-side enforcement.
- Added (real gaps only): invitation flow reusing WorkspaceMember(INVITED + new nullable `expiresAt`, dev-applied migration) with 7-day expiry/refresh/self-accept; `members/service.ts` (invite/accept/list/update/remove, self-edit ban, SUPER_ADMIN ban, last-owner floor, full audit); 5 member routes + workspace PUT (all permission-pinned, session-derived targets); `/settings/team` UI + nav + settings card (same design/RTL).
- Proven: 6 security test groups (isolation, no self-escalation, suspension lockout via real getAuthContext+HTTP, workspace tamper rejection, audit coverage, leak-free errors) — 16 new tests.
Details: `docs/PROGRESS.md` §P3. No production readiness claimed. No further phases started.

## P4 Inbox Note (2026-10-10) — appended, history preserved

P3 verification first: invite accept/cross-account covered; last-owner race found and fixed (post-write verification with compensation in update/removeMember + concurrency test proving ≥1 owner under all interleavings).
P4 kept the entire existing inbox and added only real gaps (gates: 551/551 · typecheck · lint · scan · build, all green; no Meta/OMS/prod):
- Server filters (priority/assignee/channel/activity-date) + UI filter row.
- Internal notes: Message.isNote (dev migration) + postNote + POST notes route (conversations.reply); excluded from sender/recovery/retry/AI-history/analytics/previews; amber UI with reply/note composer tabs.
- Contact 360: email row, blacklist badge, per-order adSource.
- Conversation detail: openHandoff banner data + audited assignmentHistory (bounded queries, no new N+1).
- Fixed a real first-message race (conversation create P2002 → re-read) + mirrored uniques in the test double.
- 14 new tests (filters/ordering/pagination/notes-separation/360/isolation/RBAC-pins/concurrent identity/hidden-reopen).
Details: `docs/PROGRESS.md` §P4. Browser E2E, live Meta, staging remain BLOCKED. No P5 started.

## P5 Channels Note (2026-10-10) — appended, history preserved

P5 built multi-channel on official APIs only (gates: 598/598 · typecheck · lint · scan · build, all green; no external accounts, no real messages; 2 dev-only migrations):
- Gate first: concurrent auto-channel duplication fixed (partial unique index + P2002 re-read + test).
- Shared contract: explicit capabilities, feature errors, per-provider policies, shared inbound job, provider-scoped identities, refactored ChannelSender (Messenger path verbatim, 85/85 green).
- Per channel: Messenger verified unchanged; FB comments (receive-store + public/private-once/hide + 6 routes); Instagram (client/normalize/HMAC/policy/adapter/webhook/comments/connect); Telegram (Bot API client/secret-header/policy/adapter/webhook/connect with getMe+secret+setWebhook); WhatsApp (Cloud client/wa_id/HMAC/24h+template policy/adapter/webhook/connect); TikTok local-only shapes with connect refused (approval-gated).
- Management: connect (live-validated, encrypted, ownership-proofed), safe disconnect, secret-free list, Arabic UI section.
- 47 new tests; zero silent mocks; zero real traffic.
Details + per-channel table: `docs/PROGRESS.md` §P5. No PRODUCTION_VERIFIED for any new channel. No P6 started.

## P6 AI Studio Note (2026-10-10) — appended, history preserved

P6 completed the AI studio locally on real execution paths (gates: 632/632 = 598 baseline + 34 new · typecheck · lint · scan:secrets · build 91/91 pages, all green; one dev-only migration `p6_ai_studio`; no prod contact, no real keys/messages):
- Workspace provider choice is now EFFECTIVE (`getWorkspaceProvider`: test-injection > real workspace choice > ENV > fail-closed; "mock"/unset defers to ENV so legacy fail-closed behavior is byte-preserved) + EMBEDDING/RETRIEVAL tasks + compatibility validation + explicit opt-in fallback (retryable-only, same privacy gate) + internal OpenAI-compatible endpoint (`delivery: internal`) + PII-free connection probes.
- PersonaVersion snapshots (draft → explicit publish → append-only rollback), channel↔persona binding route, persona priority + version preserved, every usage row carries personaId/personaVersion/fallbackUsed/handoffReason.
- Playground: draft-instruction/version/task testing in-memory only; 9-table production snapshot proves zero side effects.
- Knowledge RAG was already complete — P6 added real-path retrieval/isolation/generation-mismatch/FAILED-status tests only.
- Fixed a REAL F-004 gap: `AIUsageLog.costUsd` was still `NOT NULL DEFAULT 0` (nullable claim unapplied — nulls would have failed silently inside the never-throw catch); now nullable. Also fixed a real leak: usage-log failure logging no longer serializes raw error objects (possible PII) — safe identifiers only.
- Studio UI (`/ai/studio`) shows unconfigured/configured/working/local/failed/needs-key/disabled/published states with live probes; keys never leave the server.
Full map + evidence: `docs/PROGRESS.md` §P6. Live provider connections, Meta/OMS/staging stay BLOCKED. No P7 started.

## P7 Workflows Note (2026-10-10) — appended, history preserved

P7 built the workflow/automation engine locally on the existing durable job queue (gates: 657/657 = 632 baseline + 25 new · typecheck · lint · scan:secrets · build 91/91 pages, all green; one dev-only migration `20261010104800_p7_workflows`; NOT pushed to GitHub per instructions; no prod contact, no real messages):
- Strict closed-set interpreter (no stored JS/eval): triggers, condition fields, and actions are enums; `.strict()` Zod schemas reject unknown keys; policy revalidation before every send (HUMAN_ACTIVE / resolved / blacklist / channel policy) — blocked sends never create an outbound message row; permanent failures carry `WORKFLOW_POLICY:` reasons.
- Exactly-once execution: unique `(automationId, triggerEventId)` claim, per-step idempotency via `stepLog` cursor (crash/resume never re-sends or re-tags), WAIT parks the run (`resumeAt` in metadata) and resumes after it from the frozen cursor; same event ×100 and ×12 concurrency → one execution row.
- Frozen snapshots: publishing validates and freezes an `AutomationVersion`; running/resumed executions keep their `versionId` — mid-flight draft edits can never change behavior; rollback is append-only (old snapshot published as a NEW version).
- Durable bridge: EventBus → `run_workflow_event` jobs keyed `wf-event:{ws}:{eventId}`, loop prevention (ignores `originWorkflowId` payloads and non-replayable `:volatile:` events), deterministic `eventId` plumbed from inbound.
- SSRF guard for `customBaseUrl` (P6 follow-up): sync validation on every save/probe + async DNS re-check (global-unicast only, obfuscated/loopback/LAN/metadata rejected; LAN blocked by documented policy).
- Preview endpoint is a zero-write DRY-RUN over a synthetic sample (snapshot-identity asserted); Builder UI at `/workflows` (trigger/conditions/ordered steps, preview, publish/pause/stop, execution log); stop cancels RUNNING/WAITING executions safely.
Details + evidence: `docs/PROGRESS.md` §P7. Multi-worker Postgres verification, staging, and push stay BLOCKED. No P8 started.

## P8 Sales Intelligence Note (2026-10-10) — appended, history preserved

P8 built the Sales Intelligence Engine locally on top of P7 (gates: 693/693 = 657 baseline + 36 new · typecheck · lint · scan:secrets · build, all green; one dev-only migration `p8_sales_intelligence`; NOT pushed to GitHub per instructions; no live OMS contract, no real messages):
- Deterministic sales plan (`modules/sales/`): primary product + OMS upsell offer + cross-sell (≤2 from `complementarySkus`) + objection classification — every number sourced from the DB, strict Zod schemas, no eval; invalid/expired/no-real-saving offer rows are dropped fail-soft with a closed set of `noOfferReason`s.
- Anti-persistence policy: max 2 offer presses per conversation+SKU (`OFFER_SHOWN` count), explicit customer decline stops offers for that SKU permanently.
- Discount governance: within `Product.discountCap` → direct with `orders.discount`; above cap or unconfigured → supervisor approval (`orders.discount.approve`, requester ≠ decider, 24h TTL, binding to productId + unitPriceAtApproval → INVALIDATED on expiry/price change/product mismatch).
- Wholesale secrecy: never in any prompt or customer-facing text; visibility requires `products.wholesale` (RBAC pins: MANAGER all three, SALES_AGENT discount only, VIEWER none) + final send guard `assertNoWholesaleLeak`.
- Sales Coach inbox panel: internal-only suggestions (REPLY_HINT/OFFER/CROSS_SELL/OBJECTION/DISCOUNT) with draft text the agent explicitly inserts — nothing is ever auto-sent; sending stays on the existing reply path with fresh revalidation; missing data shows an explicit reason, no guessing.
- Ad-source attribution: first-touch-wins `Customer.adSource` from trusted channel referral/postback data only; webhook replays never overwrite; absent attribution stays unknown (null). Orders inherit the customer's adSource.
- Metrics: `SalesEvent` (9 types) — suggested ≠ sent ≠ accepted ≠ ordered; `OFFER_SHOWN` only after delivery, `OFFER_ACCEPTED` only on a confirmed order with quantity ≥ offer quantity; documented, manually computable analytics formulas (`offerAcceptRate = OFFER_ACCEPTED / OFFER_SHOWN`, null when nothing shown).
Details + evidence: `docs/PROGRESS.md` §P8. Real OMS contract verification, staging/E2E, and push stay BLOCKED. No P9 started.

## P9 Marketing Campaigns Note (2026-10-10) — appended, history preserved

P9 built Marketing Campaigns + Audience Segments locally on top of P8 (gates: 742/742 = 693 baseline + 49 new · typecheck · lint · scan:secrets · build 98/98 pages incl. `/api/segments*`, `/api/campaigns*`, `/campaigns`, all green; one dev-only migration `p9_campaigns`; NOT pushed to GitHub per instructions; no real sends, no live Meta template approval):
- Closed-set segment definitions (`modules/campaigns/segment-schemas.ts`): 10 named condition fields only — no SQL, no free text, no stored code; segments are always dynamic; evaluation is deterministic, workspace-scoped, bounded at 5000 candidates, with the noReply condition applied as a deterministic post-filter (column comparison not expressible in Prisma).
- Marketing consent on the customer (`UNKNOWN/OPTED_IN/OPTED_OUT` + `marketingOptOutAt`) — excluded at evaluation AND re-checked per recipient at send time; phone alone is never a channel contact (identity on the campaign's channel type required).
- Closed channel decision: WHATSAPP = TEMPLATE (approved template mandatory — the sole official marketing path via Cloud API), TELEGRAM = DIRECT (bot subscribers), FACEBOOK/INSTAGRAM/WEB → `CHANNEL_NOT_MARKETING_CAPABLE`, TIKTOK → `CHANNEL_NOT_APPROVED`-family refusal — refused, not imitated.
- Named lifecycle transitions only (`canTransition`), append-only content versions, approval pins version + audience hash `v1:{channel}:e{n}:x{n}` — content or audience change after approval → `AUDIENCE_CHANGED` and re-validation; re-scheduling is idempotent on the `campaign:{id}:run` job key.
- Durable runner: `run_campaign` snapshot (idempotent via `skipDuplicates`) → chained `campaign_tick:{seq}` (next tick enqueued before processing — crash-resumable); durable per-minute rate window on the campaign row; batch ≤ 50; ≤ 5 attempts per recipient.
- Every send goes through the existing `dispatchOutbound` (idempotency + policy + transient/permanent classification) with key `campaign:{id}:{recipientRowId}` — retries reclaim the same row, never duplicate; per-recipient revalidation excludes blacklisted/opted-out customers even mid-run; cancel/pause take effect between recipients; campaign conversations are `camp-*` with `HUMAN_ACTIVE` + `aiEnabled:false` (no AI).
- Fixed a real WhatsApp client bug: Graph subcodes ≥ 100000 (131047 outside-window, 132000 template validation) were misclassified TRANSIENT by the numeric `>= 500` check — now PERMANENT; 429/5xx/130429 stay TRANSIENT.
- AI draft suggestion: zero customer data in the prompt (empty PII object, fail-closed masking), no invented prices, approved channels only, mandatory human review; dry-run endpoint is zero-write.
Details + evidence: `docs/PROGRESS.md` §P9. Live Meta template verification, multi-worker Postgres, staging/E2E, and push stay BLOCKED. No P10 started.

## P9 Push Note (2026-10-10) — appended, history preserved

At owner request, P7+P8+P9 were committed (`41eaa67` "feat(system7): P7 workflows + P8 sales intelligence + P9 marketing campaigns", 78 files) and pushed to `origin/main` (github.com/MKory18/AIresponse.git). Verified pre-push backup: `Documents/System7-pre-P10-20261010-152004` (source zip + repo bundle, manifest + verification PASS).

## P10 Analytics Note (2026-10-10) — appended, history preserved

P10 built the unified Analytics & Reporting layer locally on top of P9, reusing every existing primitive (gates: 772/772 = 742 baseline + 30 new · typecheck · lint · scan:secrets · build incl. `/api/analytics/{sales,agents,campaigns,trends,export}` + `/analytics` hub, all green; NO migration needed; NO commit/push per instructions; no fake data anywhere — null means "غير متاح", never zero):
- 5 new read-only endpoints via the existing `analyticsRoute` (optional per-route permission param added): `sales` (first route for the existing `getSalesAnalytics`), `agents` (new RBAC `analytics.agents`, MANAGER-only, pinned), `campaigns`, `trends`, `export` (CSV, same compute functions as UI → deterministic parity, 10k row cap, formula-injection guard, UTF-8 BOM, `analytics.exported` audit).
- Documented attribution for agent performance (`modules/analytics/agents.ts`): assignedAgentId conversations, HUMAN outbound replies only (AI messages never count), median per-agent FRT (first OUTBOUND after first INBOUND, pre-emptive outbound ignored), handoffs by assignedTo, linked orders via assigned conversations (not last-viewer), discount decisions from AuditLog; per-agent offer metrics are UNAVAILABLE (`SALES_EVENT_HAS_NO_ACTOR`).
- Campaign analytics (`campaigns-analytics.ts`): semantic separation enforced — API-accept (SENT) ≠ delivery ≠ read ≠ conversion; delivery/read counted only from `Message.deliveryStatus` with explicit `UNVERIFIED_NO_STATUS_WEBHOOK_DATA` marker (status webhooks not processed since P5); attribution & ROAS UNAVAILABLE (`ORDER_HAS_NO_CAMPAIGN_ATTRIBUTION`).
- Trends read `DailyWorkspaceAnalytics` (built since P6, never read): UTC-day rows, missing day = MISSING (not zero), STALE after 6h, coverage meta + self-heal idempotent rebuild job (`analytics-rebuild:{ws}`).
- Fixed two real bugs: `resolveRange` TZ offset fractional-minute drift (offsets now rounded to whole minutes — boundaries were off by 1ms at day edges); dashboard overview placeholder replaced with real customers count + AI cost null semantics.
- Money sums in cents (`sumMoney`/`avgMoney`) — floating-point safe; CSV export rejects formula-injection cells (`= + - @` + control chars).
- Analytics hub UI (`/analytics`): 8 tabs, range/timezone filters, previous-window comparison, CSV export, explicit "غير متاح" for nulls.
Details + evidence: `docs/PROGRESS.md` §P10. Delivery/read webhooks, campaign attribution, live OMS, staging stay BLOCKED (documented, not faked). No P11 started.

## P11 UI/UX Note (2026-10-10) — appended, history preserved

P11 unified the interface and made it mobile-first locally on top of P10 (gates: 778/778 = 772 baseline + 6 new · typecheck · lint · scan:secrets · build, all green; NO migrations, NO backend/API/schema changes, NO business-logic changes; NOT committed/pushed per instructions; verified pre-work backup `System7-pre-P11-20261010-154500`):
- Full 3-track audit of ~30 pages/components first; the existing design-token system (glass, RTL-native, dark mode) was kept and consolidated — no second UI library. New shared primitives only: `ConfirmDialog` (focus-trapped, busy state), `ErrorState` (error + retry), focus trap + focus restore in `Dialog`, breakpoint-configurable `Drawer` (fixes the 1024–1280px dead zone), Arabic label maps for all workflow/automation/operator/AI-state enums in i18n.
- Inbox (priority): Contact 360 panel now reachable below 1280px via Drawer (was fully inaccessible); stale-response sequence guards for list + thread polling; optimistic PENDING/QUEUED/FAILED rows survive polls (retry button never silently vanishes); loading vs genuinely-empty thread distinguished; note mode has a clear amber composer state; resolve/back-to-AI busy + error toasts (success toast only after server confirms); Sales Coach failure shows an error state, not a fake "no suggestions"; the three hand-rolled overlays moved to shared Dialog/ConfirmDialog; `dvh` height; RTL bubble sides corrected (own message at line end, customer at start — Arabic chat convention); listbox option semantics + bidi-isolated phone numbers.
- Pages: error+retry states added wherever a failed fetch faked an "empty list" (handoffs, follow-ups, channels, settings/ai, workflows, automation, campaigns, personas); confirmation dialogs for destructive actions (order cancel, workflow/automation delete, campaign cancel, persona rollback, follow-up cancel, feedback archive, member remove/suspend — replacing raw `window.confirm`); no fake success: provider test failures surface + "saved status — not live-verified" badge until a ping runs, channel errors styled as danger, AI-settings save failures visible; fixed real bug where analytics passed a string into a number formatter (NaN rendered) and comparison deltas matched on Arabic display labels (label rename would silently break comparison); fixed real Playground bug where the first send created TWO sessions (race); campaign dry-run now per-card (was targeting the globally selected row); workflow condition builder collapses on mobile; auth form surfaces non-JSON failures + proper autocomplete; removed a permanently-lit fake notification dot.
- Mobile verified live (not claimed): real dev server + real login via Playwright, 18 routes at 375×812 with ZERO horizontal overflow (`scrollWidth-clientWidth=0` measured), screenshots in `.playwright-mcp/p11-*.png` (login/dashboard/inbox mobile 375px, analytics/inbox desktop 1366px), zero console errors.
Details + evidence: `docs/PROGRESS.md` §P11. Real-device mobile testing and live-conversation visual testing stay BLOCKED (no channels live; message logic unchanged and covered by P4–P8 tests). No P12 started.
