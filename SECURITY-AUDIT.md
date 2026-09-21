# Security Audit — AI Commerce Response Engine

**تاريخ المراجعة:** 2026-09-21 · **النطاق:** Phases 1–8 + Phase 9 hardening
**المنهجية:** فحص ثابت للكود، unit/integration tests (210)، secret scan آلي، مراجعة يدوية للـ invariants.
**بيئة الاختبار:** Node 24 / Windows (development) — **PostgreSQL/pgvector حقيقي وDocker غير متاحين على هذه الآلة** (انظر NOT VERIFIED).

---

## Findings

| ID | Severity | Component | Description | Status |
|---|---|---|---|---|
| F-001 | **HIGH** | Conversation pipeline | Concurrent duplicate webhook deliveries ربحت السباق على `message.create` → P2002 uncaught → 500 من Meta. | **FIXED** — create يُحاط بـ P2002 catch ويعيد الرسالة الرابحة (duplicate). Regression test: `phase9-security.test.ts` (replay ×100 concurrent). |
| F-002 | MEDIUM | Rate limiting | Rate limiter in-memory per process — لا يعمل عبر multiple instances. | **DOCUMENTED** — كافٍ لعملية واحدة؛ النقل إلى Redis مطلوب عند التوسع الأفقي. |
| F-003 | MEDIUM | Background jobs | قبل Phase 9: لا يوجد lease/recovery للمهام PROCESSING بعد crash. | **FIXED** — `lockedAt/lockedBy` + `recoverStaleJobs` (lease 10 دقائق) في كل دورة worker. |
| F-004 | LOW | AIUsageLog.costUsd | كان default 0 — قد يُقرأ كتكلفة فعلية. | **FIXED** — nullable؛ null عندما لا يوجد pricing مُعد. |
| F-005 | LOW | Knowledge `sourceUrl` | يُقبل أي URL ويُخزن — لا يُجلب server-side حاليًا (لا SSRF فعلي) لكن أضف SSRF guard قبل أي مستقبل fetch. | **OPEN (documented)** |
| F-006 | INFO | CSP | `unsafe-inline` للـ scripts مطلوب لـ Next.js runtime؛ أزِل في production عند إضافة nonces. | **OPEN (documented)** |
| F-007 | INFO | Worker | حلقة polling واحدة — التوسع الأفقي ممكن (atomic claims) لكن لم يُختبر بـ workers متعددة على DB حقيقي. | **NOT VERIFIED** |

## Verified controls (with evidence — tests)

- **Tenant isolation**: sweep عبر 13 نوع resource (customer/conversation/message/product/feedback/knowledge/order/draft/media/handoff/follow-up/automation/order-transition) — كلها 404/403 (phase9).
- **Webhook idempotency**: replay ×100 متزامن → message واحدة (phase9، بعد إصلاح F-001).
- **Outbound idempotency**: unique `outboundIdempotencyKey` — إرسال واحد (phase6).
- **Order integrity**: duplicate draft conversion → order واحدة (phase5)؛ AI price injection → سعر DB (phase5/6 E2E)؛ snapshots معزولة (phase5/8).
- **Handoff/follow-up atomic claims**: 100 متزامن → فائز واحد (phase7).
- **HUMAN_ACTIVE invariant**: ×100 رسالة واردة → 0 ردود AI (phase9).
- **Prompt injection**: كشف → handoff، لا تسريب system prompt (phase4/6).
- **Template allowlist**: constructor/prototype/passwordHash مرفوضة (phase7/8).
- **Encryption**: AES-256-GCM، tamper rejection، لا plaintext fallback (phase1 tests).
- **Secrets scanning**: `npm run scan:secrets` — clean.
- **RBAC**: كل route عبر permission + workspace scope؛ matrix tests (phase9).
- **Input validation**: Zod على كل route؛ deep nesting + huge strings مرفوضة (phase9).

## NOT VERIFIED (يتطلب بنية حقيقية غير متوفرة في بيئة التطوير هذه)

> **STAGING PRE-FLIGHT (2026-09-21):**
> - Docker: **NOT INSTALLED** (فحص Program Files + PATH) → **BLOCKED: Docker unavailable**
> - PostgreSQL محلي موجود (خدمة Odoo على 5432) لكن بلا credentials — و**لن يُلمس** (قاعدة بيانات نظام آخر).
> - Node 24.12 / npm 11.7 / Prisma 5.22 ✅ · Disk ✅ · `.env` غير موجود محليًا (gitignored).
> - **Kit التنفيذ الكامل جاهز:** `scripts/staging/validate-staging.sh` (10 خطوات) + `scripts/staging/concurrency.mjs` (webhook replay ×100، confirm ×100، handoff claim ×100 مع p50/p95/p99) — يُشغّلها مشغّل البيئة فور توفر Docker/credentials ويُنتج تقرير PASS/FAIL لكل بند.

- تشغيل migrations فعليًا على PostgreSQL + فحص الفهارس/constraints عبر `\d` — **NOT VERIFIED**
- pgvector حقيقي: PgVectorStore SQL path، similarity search، index — **NOT VERIFIED**
- Worker فعلي طويل الأمد + stale recovery على DB حقيقي + عدة workers — **NOT VERIFIED** (الكود: lease/recovery + worker.ts مع SIGTERM جاهز)
- Playwright E2E ضد تطبيق شغال + real HTTP E2E — **NOT VERIFIED**
- Load baseline (100 concurrent عبر HTTP حقيقي) — **NOT VERIFIED** (السكربت جاهز: concurrency.mjs)
- Backup/restore على Postgres حقيقي — **NOT VERIFIED**
- Meta production: OAuth حقيقي، webhook حقيقي، إرسال فعلي (لا credentials) — **NOT VERIFIED**
- Redis/BullMQ (غير مستخدم في التصميم الحالي — BackgroundJob on Postgres) — **NOT APPLICABLE**
- SSRF: لا يوجد server-side fetch لـ user URLs — **NOT APPLICABLE حاليًا** (أضف guard قبل أي مستقبل fetch)
