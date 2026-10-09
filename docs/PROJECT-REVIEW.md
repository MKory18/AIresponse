# 📘 تقرير المراجعة الشاملة — Zaki AI Response Engine

> **اسم المشروع:** `ai-commerce-response-engine` (v0.1.0)
> **الوصف:** منصة SaaS متعددة المستأجرين (Multi-Tenant) تجمع بين: وكيل مبيعات ذكي (AI Sales Agent عبر فيسبوك ميسنجر) + صندوق دعم بشري (Inbox) + CRM + قاعدة معرفة RAG + ذكاء الطلبات (Order Intelligence) + الأتمتة والمتابعات + التحليلات.
> **تاريخ المراجعة:** 2026-10-06
> **حالة المشروع:** المراحل 1–8 مكتملة + المرحلة 9 (تحصين أمني) — مع قائمة NOT VERIFIED صادقة في SECURITY-AUDIT.md.

---

## جدول المحتويات

1. [ملخص تنفيذي](#1-ملخص-تنفيذي)
2. [المكدس التقني](#2-المكدس-التقني)
3. [بنية المشروع (شجرة المجلدات)](#3-بنية-المشروع)
4. [قاعدة البيانات (Prisma Schema)](#4-قاعدة-البيانات)
5. [الطبقة الأساسية — src/core](#5-الطبقة-الأساسية)
6. [محرك الذكاء الاصطناعي — src/modules/ai](#6-محرك-الذكاء-الاصطناعي)
7. [قاعدة المعرفة و RAG — src/modules/knowledge](#7-قاعدة-المعرفة-و-rag)
8. [المهام الخلفية والـ Worker](#8-المهام-الخلفية-وال-worker)
9. [واجهات الـ API الكاملة](#9-واجهات-ال-api)
10. [المصادقة و RBAC](#10-المصادقة-و-rbac)
11. [قنوات التواصل (فيسبوك ميسنجر)](#11-قنوات-التواصل)
12. [المحادثات وصندوق الوارد](#12-المحادثات-وصندوق-الوارد)
13. [الطلبات وذكاء الطلبات](#13-الطلبات-وذكاء-الطلبات)
14. [الأتمتة والمتابعات](#14-الأتمتة-والمتابعات)
15. [التحليلات والملاحظة (Observability)](#15-التحليلات-والملاحظة)
16. [الوسائط (Media)](#16-الوسائط)
17. [واجهة المستخدم (لوحة التحكم)](#17-واجهة-المستخدم)
18. [البيانات التجريبية (Seed)](#18-البيانات-التجريبية)
19. [الاختبارات](#19-الاختبارات)
20. [البنية التحتية والنشر (Docker)](#20-البنية-التحتية-والنشر)
21. [الأمان](#21-الأمان)
22. [الضمانات المعمارية العرضية](#22-الضمانات-المعمارية-العرضية)
23. [نقاط القوة](#23-نقاط-القوة)
24. [نقاط الضعف والمخاطر وتوصيات التحسين](#24-نقاط-الضعف-والمخاطر-وتوصيات-التحسين)
25. [قائمة NOT VERIFIED (غير مُتحقق منها على بنية حقيقية)](#25-قائمة-not-verified)

---

## 1. ملخص تنفيذي

المشروع عبارة عن **محرك استجابة تجارية مدعوم بالذكاء الاصطناعي** مبني بـ Next.js 14 (App Router) كتطبيق موحّد يجمع واجهة الـ API ولوحة التحكم، مع PostgreSQL + Prisma + pgvector لقاعدة المعرفة الدلالية.

**الفكرة المركزية:** عميل يكتب على فيسبوك ميسنجر → استقبال Webhook من Meta (بتحقق HMAC وidempotency) → محرك المحادثات (حل هوية العميل عبر ChannelIdentity) → منسّق الذكاء الاصطناعي (Orchestrator) الذي يمر عبر: مزوّد AI → موجه نماذج (Model Router) → شخصية (Persona) → محفزات موثوقة (Prompts بحدود ثقة) → استخراج نية/كيانات (Zod) → ذاكرة العميل → RAG → Guardrails → **الذكاء الاصطناعي يقترح فقط، ومحرك القواعد يقرر، والخدمات تنفّذ، وقاعدة البيانات هي مصدر الحقيقة** → توليد مسودة طلب (Order Draft) → تأكيد → قواعد التسعير/التحقق → إنشاء طلب حقيقي → إرسال عبر Graph API بـ idempotency.

**النتيجة العامة للمراجعة:** بنية ناضجة ومُصمّمة بعناية استثنائية لموثوقية النظام (idempotency في كل طبقة، سقف دائم لاستعادة المهام، fail-closed، منع الحلقات). النقاط الأضعف الرئيسية: عدم وجود CI (GitHub Actions)، Rate limiter في الذاكرة فقط (single-instance)، نمو ملف `orchestrator.ts` (924 سطر)، وغياب فحص E2E حقيقي على بنية إنتاج حقيقية (موثّق بصدق في SECURITY-AUDIT.md).

---

## 2. المكدس التقني

| الطبقة | التقنية | ملاحظات |
|---|---|---|
| إطار التطبيق | Next.js 14.2 (App Router, TypeScript, strict) | واجهة + API في تطبيق واحد |
| الواجهة | React 18 + TailwindCSS 3.4 | RTL كامل، خط IBM Plex Sans Arabic، Dark mode عبر class |
| قاعدة البيانات | PostgreSQL + Prisma 5.22 | **pgvector** لدعم `vector(1536)` للـ embeddings |
| المصادقة | `jose` (JWT HS256) + `bcryptjs` (scrypt-like hashing) | Cookie HttpOnly/SameSite=lax، صلاحية 7 أيام |
| التحقق | Zod 3 | مدخلات API + مخرجات AI المنظّمة |
| التسجيل | pino 9 | مع redaction للأسرار |
| الاختبارات | Vitest 2.1 | ~30 ملف اختبار، ~425 حالة |
| المعالجة الخلفية | طابور مبنية على DB (`BackgroundJob`) | بدون Redis/BullMQ (مقصود، قابل للتبديل لاحقًا) |
| الحاويات | Docker 3 مراحل على node:20-alpine + docker-compose | app + worker + postgres(pgvector) |
| PDF | pdf-parse | استخراج نص الملفات للمعرفة |
| الحالة | متغيرات البيئة صارمة (Zod env validation) | fail-fast عند الإقلاع |

---

## 3. بنية المشروع

```text
├── prisma/                  # schema.prisma (37 نموذج)، migrations (6)، seed.ts
├── scripts/
│   ├── worker.ts            # عملية الـ Worker المستقلة
│   ├── scan-secrets.mjs     # فاحص الأسرار في Git
│   └── staging/             # validate-staging.sh + concurrency.mjs + probe-db.cjs
├── src/
│   ├── app/
│   │   ├── (auth)/          # login / register
│   │   ├── (dashboard)/     # 18 صفحة لوحة تحكم (inbox, orders, products…)
│   │   └── api/             # ~50 مسار API في 14 مجالًا
│   ├── components/          # AppShell, Sidebar, AuthForm, Inbox (4 مكونات), UI kit (12)
│   ├── core/                # crypto, env, errors, logger, api/handler, db, events, analytics
│   ├── lib/                 # cn (clsx+tailwind-merge), i18n
│   ├── modules/             # 15 وحدة نطاق (ai, orders, channels, …)
│   └── types/               # pdf-parse.d.ts
├── tests/                   # 30 ملف اختبار + helpers/inmemory-db.ts
├── docs/                    # COOLIFY-STAGING.md, IMPLEMENTATION_PLAN.md
├── SECURITY-AUDIT.md        # نتائج التدقيق الأمني F-001..F-007
├── docker-compose.yml + Dockerfile
└── .env.example             # 6 مجموعات متغيرات
```

**الطبقات:** `core/` (بنية تحتية عامة) → `modules/` (منطق النطاق) → `app/api/` (مسارات رقيقة تستدعي الخدمات) → `app/(dashboard)/` (واجهة عميل تستدعي REST). مبدأ التصميم: التحقق Zod → RBAC → الخدمة → استعلام Prisma مقيّد بـ workspaceId دائمًا.

---

## 4. قاعدة البيانات

`prisma/schema.prisma` يحوي **37 نموذجًا**. مبدأ عام: كل نموذج مملوك للمستأجر يحمل `workspaceId` مع فهرس. النماذج مقسمة:

### الهوية والتعدد المستأجري (Identity & Tenancy)
| النموذج | الوصف |
|---|---|
| `User` | المستخدمون (email unique، passwordHash، isSuperAdmin، availability) |
| `Workspace` | المستأجر: plan (FREE→ENTERPRISE)، timezone، SLA settings |
| `WorkspaceMember` | العضوية: role (7 أدوار) + صلاحيات مخصّصة `permissions[]` + status (ACTIVE/INVITED/SUSPENDED)، unique(workspaceId,userId) |

### القنوات
- `Channel` (type: FACEBOOK/INSTAGRAM/WHATSAPP/TELEGRAM/WEB، status، externalId، **aiPersonaId** — ربط شخصية بصفحة) — unique(workspaceId, type, externalId)
- `ChannelAccount` — **أسرار مشفرة AES-256-GCM** (encryptedCredentials)، tokenExpiresAt، unique(provider, externalAccountId)

### العملاء والذاكرة
- `Customer` (8 حالات من NEW_LEAD إلى BLOCKED، leadScore، tags، unique(workspaceId, phone) و(workspaceId, channelCustomerId))
- `CustomerMemory` (FACT/PREFERENCE/ORDER/CONVERSATION_SUMMARY/IMPORTANT_NOTE، confidence، unique(customerId, type, key))
- `ChannelIdentity` — يربط هوية خارجية (PSID) بعميل واحد لكل مستأجر، unique(channelType, channelExternalId)

### المحادثات والرسائل
- `Conversation`: status (OPEN/PENDING/RESOLVED/CLOSED)، **aiState (AI_ACTIVE/AI_PAUSED/HUMAN_ACTIVE)**، priority، unreadCount، assignedAgentId، **soft-delete (deletedAt/deletedBy)**، unique(workspaceId, channelConversationId) + 3 فهارس مركّبة
- `Message`: senderType (CUSTOMER/AI/HUMAN/SYSTEM)، 9 أنواع، deliveryStatus (6 حالات)، **externalEventId + externalMessageId (idempotency unique)** و**outboundIdempotencyKey unique** — منع التكرار على مستوى قاعدة البيانات

### المنتجات والوسائط
- `Product` (Decimal(12,2)، حقول بيعية: objections، salesNotes، ingredients، usage، warnings) + `ProductVariant`
- `ProductMedia` — ربط مرتب مع isPrimary
- `MediaAsset` (5 تصنيفات، 4 أنواع، unique(workspaceId, storageKey))

### المعرفة و RAG
- `KnowledgeDocument` (8 تصنيفات، 5 حالات، version، isActive)
- `KnowledgeChunk` — **`embedding vector(1536)` عبر Unsupported** + ختم هوية التضمين (provider/model/dimensions) لمنع انحراف البحث عند تغيير النموذج
- `KnowledgeCitation` — مصادر إجابات AI (provenance)
- `Faq`

### الذكاء الاصطناعي
- `Persona` (tone، language، dialect، formality، emojiLevel، responseLength، salesStyle، systemRules، prohibitedPhrases، customRules)
- `AISettings` — **توجيه نموذج لكل مهمة** (classification/extraction/response/vision/summary/embedding)، temperature، عتبات الثقة (execute 0.90 / respond 0.70 / handoff 0.50)، maxDailyMessages

### الطلبات
- `Order` (9 حالات × 3 محاور: order/confirmation/payment/fulfillment، Decimal، **idempotencyKey unique**، orderNumber unique)
- `OrderItem` — **snapshots** (productNameSnapshot, skuSnapshot, unitPrice) — حماية من تغيّر المنتج لاحقًا
- `OrderDraft` — مسودة محفوظة أثناء المحادثة (7 حالات: EMPTY→CONFIRMED→CONVERTED)، unique(conversationId)، missingFields، entityConfidence
- `DeliveryRule` — رسوم التوصيل لكل محافظة (fee، freeOver، isAvailable)

### الأتمتة والمتابعات
- `FollowUp` (6 حالات، **idempotencyKey unique**، scheduledAt) + `Automation` (trigger/conditions/actions JSON) + `AutomationExecution` (unique(automationId, triggerEventId))
- `HumanHandoff` (9 أسباب: CUSTOMER_REQUEST → INJECTION_DETECTED، 4 حالات، assignedTo/claimedAt/resolvedAt)

### Playground (معزول داخليًا)
- `PlaygroundSession` / `PlaygroundMessage` — **لا تلمس جداول الإنتاج إطلاقًا** (موثّق في تعليق الـ schema نفسه)

### الملاحظة (Observability)
`AuditLog` · `AIUsageLog` (tokens/cost/latency/success لكل استدعاء AI) · `WorkspaceUsage` (مقياس شهري) · `DailyWorkspaceAnalytics` (تجميع يومي، unique(workspaceId, date)) · `Usage` · `WebhookEvent` (payload خام، unique(source, externalEventId)) · `SystemLog` · `BackgroundJob` (status/attempts/lockedAt/lockedBy + **idempotencyKey مع partial unique index** — المهمة الفاشلة أو المنجزة لا تمنع إعادة الطوابير، وعملية استرجاعان لا تنشئان مهمتين نشطتين لنفس العمل).

---

## 5. الطبقة الأساسية (`src/core`)

| الملف | المسؤولية | التفاصيل الرئيسية |
|---|---|---|
| `crypto.ts` | تشفير الأسرار + توقيع HMAC | `encryptSecret/decryptSecret` (AES-256-GCM، صيغة `iv.tag.ciphertext` base64)، `signPayload/verifyPayload` (HMAC-SHA256 مع exp مطلق ونافذة iat منزلقة)، `timingSafeEqual`، `randomId` |
| `env.ts` | مصدر الحقيقة الوحيد للبيئة | Zod parsing + caching، مفاتيح مطلوبة: DATABASE_URL، JWT_SECRET (≥32)، ENCRYPTION_KEY (≥32)، توجد `resetEnvCache()` للاختبار |
| `errors.ts` | تسلسل أخطاء مكتوب الأنواع | `AppError` مع statusCode + code آلي: ValidationError(422)، Authentication(401)، Authorization(403)، NotFound(404)، Conflict(409)، RateLimit(429)، Channel/AI(502)، Database/Encryption(500) |
| `logger.ts` | pino مع redaction | يحجب authorization، cookie، توكنات، كلمات مرور، API keys |
| `api/handler.ts` | غلاف كل مسار API | CSRF origin check (POST/PATCH/PUT/DELETE)، حد payload 110MB، rate limit (عنوان IP + مسار)، Zod body/query، حل AuthContext + `require(permission)`، تعيين أخطاء، تسجيل مدة الطلب |
| `db/prisma.ts` | Singleton PrismaClient | محفوظ على globalThis في non-production |
| `events/bus.ts` | ناقل أحداث نطاق | **25 حدثًا مكتوب الاسم** (Customer*/Conversation*/Message*/Order*…)، InMemory مع عزل أخطاء المستمعين، يدعم wildcard `*`، قابل للتبديل بـ Redis لاحقًا |
| `analytics/usage-service.ts` | قياس الاستخدام الشهري | upsert على WorkspaceUsage بفترة UTC الشهرية، **معزول الأخطاء** (فشل القياس لا يعطل العمليات) |
| `analytics/time.ts` | نواميس زمنية واعية بالتوقيت | "يوم" = يوم عمل المستأجر عبر `Intl` (DST-correct)، resolveRange (today/…/custom بحد 92 يومًا)، median/avg |
| `analytics/observability.ts` | معرّفات ارتباط | سلسلة تتبع موثّقة: `webhookEventId → message.metadata.correlationId → AIUsageLog.messageId → order.conversationId → automationExecution.triggerEventId` |

---

## 6. محرك الذكاء الاصطناعي (`src/modules/ai`)

### 6.1 خط الأنابيب الكامل (`orchestrator.ts` — ~924 سطر، قلب النظام)

`processAIMessage(db, {workspaceId, conversationId, messageId})`:

1. **منع الحلقات:** الرسالة يجب أن تكون `INBOUND + senderType=CUSTOMER` وإلا `NOT_INBOUND`.
2. **Idempotency:** وجود AIUsageLog بـ purpose=RESPONSE بحالة SUCCESS/HANDOFF → `DUPLICATE`. **نقطة دقيقة:** السجل يُكتب *بعد* الإرسال الناجح (فشل الإرسال لا يُسجّل كنجام فاذر — يُعاد). و`AI_DISABLED` **ليس نهائيًا** (يعاد معالجته عند إعادة تفعيل AI).
3. **البوابات:** محادثة محذوفة/`aiEnabled=false`/`aiState ≠ AI_ACTIVE` → `AI_DISABLED`.
4. **قراءات متوازية:** الإعدادات + الشخصية + العميل + آخر 20 رسالة.
5. **استخراج النية والكيانات:** LLM structured (Zod) مع fast-path (تحية قصيرة ≤40 حرفًا بلا حقن ← بدون استدعاء LLM) وfallback `heuristicIntent` عند فشل LLM، إعادة محاولة ×2.
6. **كشف الحقن:** `looksLikeInjection` → تسليم بشري (INJECTION_DETECTED).
7. **ذكاء الطلبات:** نوايا `ORDER_*`/`UNKNOWN`/`CREATE_ORDER` → مسار *حتمي* (drafts/rules) وليس LLM؛ `needsHumanReview` → HANDOFF (ORDER_BLOCKED) مع حفظ الذاكرة أولًا.
8. **الذاكرة + حل المنتج** (متوازيان) — حل المنتج يشمل regex الكيانات مع fallback تجزئة كلمات وإزالة أداة التعريف العربية `ال`.
9. **بناء سياق RAG** (`context-builder`) — أولوية المصادر: أوامر/بيانات العميل DB > منتجات/أسعار > سياسات معتمدة > مستندات معتمدة > شهور معتمدة.
10. **خطة الاستجابة الحتمية** (`buildPlan`) — هدف، needsClarification، sendMedia (regex)، feedback flag.
11. **سياسة التسليم البشري:** حقن / HUMAN_REQUEST / COMPLAINT / ثقة < عتبة (0.50) → `createHandoff` + audit — **بدون رد آلي على العميل**.
12. **التوليد + Guardrails:** فشل الحارس → إعادة توليد تصحيحية واحدة بـ temp 0.2 → فشل تام → `AI_FAILED` (مصنّف TRANSIENT/PERMANENT).
13. **الإرسال:** `sendAI → dispatchOutbound` + مرفق وسائط اختياري؛ QUEUED/فشل → `AI_FAILED` لإعادة المحاولة من الطابور.
14. **مسار النجاح (بعد الإرسال):** سجل الاستخدام، `knowledgeCitation.createMany(skipDuplicates)`، حفظ الذكريات، وكل 6 رسائل واردة ← مهمة `generate_summary`.

### 6.2 مزوّد AI (`provider.ts`) — حدود SDK الوحيدة
- واجهة `AIProvider` (generateText / generateStructured مع validate / generateVision اختياري).
- `OpenAICompatibleProvider`: fetch-based، timeout 60s عبر AbortController، **429/408/425/5xx → retryable مع تحليل Retry-After**، 4xx → دائم، `parseJsonLoose` (يستخرج JSON من مخرجات مسيّجة ويصلح الفواصل).
- `MockAIProvider` مُحقن الحالة، و`resolveAIProvider` **fail-closed**: الـ mock فقط عند الحقن الصريح أو `NODE_ENV=test` أو `ALLOW_MOCK_AI=1`؛ في الإنتاج بلا مزوّد ← خطأ `AI_NOT_CONFIGURED` (لا mock صامت أبدًا).

### 6.3 موجّه النماذج (`router.ts`)
- أولوية النموذج: AISettings للـ workspace ← ENV (`*_MODEL`) ← `DEFAULT_MODELS` (gpt-4o-mini للمهام الرخيصة، gpt-4o للاستجابة).
- temperature محدود 0.2 للتصنيف/الاستخراج. `estimateCost` يعيد `null` للنماذج غير المسعّرة (**لا 0$ زائف أبدًا**).
- `withRetry` بتراجع أسّي (50ms×2ⁱ) مع احترام Retry-After حتى 5 ثوانٍ.

### 6.4 المحفزات والحدود الثقة (`prompts.ts`)
- إصدارات محفزات (`core_v1…summary_v1`)، **18 نية**، قواعد نظام عربية مضادة للهلوسة (بيانات موثوقة فقط، سيناريو "لا أعلم"، لا وعود، لا كشف system prompt، لا ادعاءات طبية، ردود 1–4 أسطر).
- **حدود الثقة الثلاثية:** تعليمات موثوقة / بيانات موثوقة (DB) / محتوى العميل **غير الموثوق** ملفوف في `[UNTRUSTED_CUSTOMER_CONTENT]…[/…]` مع آخر 8 أدوار كسياق.

### 6.5 المخرجات المنظمة والحراسة
- `structured.ts`: مخططات Zod لكل مخرج LLM (intentResult، extraction بحدود أطوال و≤5 ذكريات، responsePlan، summary) — **JSON مشوّه من النموذج لا يصل منطق النطاق أبدًا**.
- `guardrails.ts`: فحوصات ما قبل الإرسال — أسرار (sk-/Bearer/JWT)، صدى الحقن، **أمانة السعر** (أرقام بسياق عملة يجب أن تطابق سعر DB الموثوق، مع تطبيع الأرقام العربية-الهندية، الكميات ≤1000 معفاة)، شهور غير معتمدة، عبارات ممنوعة، ادعاءات طبية، طول ≤700 حرف.
- `memory.ts`: حفظ ذكريات منسّقة فقط (≥5 أحرف، استبعاد التحيات/الشكر، dedup بمفتاح طبيعي).
- `channel-persona.ts`: مصدر وحيد لحل الشخصية: ربط الصفحة ← شخصية workspace النشطة ← fallback مدمج محايد.
- `persona-limits.ts`: حدود نصية صريحة (الاسم 100، التعليمات 20,000، العبارات الممنوعة 30×200، القواعد 30×2000) — **الرفض لا الاقتطاع الصامت**.
- `playground-service.ts`: ملاعب AI معزولة — نفس منطق الشخصية/السياق/الحراسة لكن بجداول خاصة فقط، لوحة debug (provider/model/tokens/latency/violations)، و`requireRealProvider` يرفض الـ mock في الإنتاج.

---

## 7. قاعدة المعرفة و RAG (`src/modules/knowledge`)

**التدفق:** رفع/إنشاء مستند (PROCESSING) ← مهمة `process_knowledge_document` ← `chunkText` (فقاعات ← دمج ≤800 حرف ← تقسيم صلب عند حدود الجمل ← تداخل 120 حرفًا) ← embeddings ← حفظ chunks مع ختم الهوية ← عند الاستعلام `retrieveKnowledge` **استرجاع هجين**: مطابقة FAQ كلمات + تضمين الاستعلام + بحث متجهي (متوازيان) ← `buildKnowledgeContext` ← في محفز الاستجابة مع تسجيل Citations لكل رسالة.

| الملف | التفاصيل |
|---|---|
| `embeddings.ts` | واجهة EmbeddingProvider؛ `HashEmbeddingProvider` (FNV bag-of-words، offline للاختبار) و`OpenAIEmbeddingProvider` (text-embedding-3-small، 1536d)؛ عدم تطابق الأبعاد = **خطأ تكوين صلب** |
| `vector-store.ts` | `InMemoryVectorStore` (cosine) و`PgVectorStore` (SQL خام `1 - (embedding <=> $1::vector)`)؛ **عزل workspace داخل الاستعلام** + فلترة بختم هوية التضمين الحالية (يمنع الانحراف الدلالي عند تغيير النموذج) |
| `retriever.ts` | هجين: findMatchingFaqs (≤3) + بحث متجهي (≤5) بالتوازي |
| `service.ts` | CRUD كامل: إنشاء ← طابور معالجة، **تجريد الـ vectors من استجابات API**، version bump عند تغيير المحتوى (إلغاء تفعيل chunks القديمة)، reindex idempotent، أرشفة، حذف صلب |
| `extract.ts` | استخراج نص من PDF (pdf-parse) وtext/* (txt/md/csv/json)؛ غير مدعوم ← AIError |

---

## 8. المهام الخلفية والـ Worker

**9 أنواع مهام:** `process_knowledge_document` · `analyze_feedback` · `process_media` · `process_ai_message` · `generate_summary` · `process_webhook_event` · `evaluate_automation` · `process_due_followups` · `aggregate_workspace_analytics`.

### `jobs/service.ts` — طابور DB دائم
- `enqueueJob`: عند P2002 (فهرس partial unique — مهمة نشطة واحدة لكل idempotencyKey) يعيد الموجودة مع `deduplicated: true` — **خسارة سباق الإدراج = نجاح**.
- `processPendingJobs` لكل دورة: `recoverStaleJobs` (استئجار 10 دقائق) ← `recoverStuckOutboundMessages` ← `recoverOrphanedInboundMessages` ← جلب PENDING المستحقة ← **claim ذري** (updateMany PENDING→PROCESSING + attempts) ← تنفيذ ← DONE أو تراجع أسّي 30s×2ⁿ بحد 10 دقائق حتى maxAttempts ثم FAILED.
- **كاسح اليتامى (`recoverOrphanedInboundMessages`) — "لا صمت أبدًا":** مسح صفّي (مضاد للتجويع/starvation) للرسائل الواردة ضمن 72 ساعة (قابل للضبط بالبيئة)، يتخطى المُحسومة (SUCCESS/HANDOFF)، المحادثات المعطلة، المهام الحية، والإخفاقات في تراجع (30s→2h)، ويعيد الطوابير بمفتاح `ai:{messageId}`.

### `jobs/handlers.ts`
- `process_ai_message`: يبني **vector store في الذاكرة لكل workspace** (chunks نشطة بهوية التضمين الحالية، ≤1000، TTL 60s، LRU 200) ثم `processAIMessage`؛ `AI_FAILED` ← فشل مهمة (إعادة)، البقية نجاحات نهائية.
- `process_webhook_event`: فك تشفير توكن الصفحة، حل ملفات المرسلين بالدفعات (مقيّد/cached)، ثم `processIncomingMessage` لكل رسالة (idempotent مستقلة)؛ **الدفعة تفشل إذا فشلت أي رسالة** — إعادة الدفعة كاملة آمنة (لا تخلٍ جزئي).
- `generate_summary`: ملخّص منظم لآخر 20 رسالة؛ عند الفشل يكتب ملخصًا إرشاديًا حتميًا و**ينجح دائمًا**.
- `aggregate_workspace_analytics`: rebuild يومي idempotent (آخر يومين افتراضيًا).

### `scripts/worker.ts`
حلقة: `runJobs` ← `processDueFollowUps` ← سكون `WORKER_POLL_INTERVAL_MS` (5000ms افتراضيًا)؛ WORKER_ID فريد، تسجيل جسر الأتمتة مرة واحدة، نبضات كل 12 دورة، **SIGTERM/SIGINT تُنهي الدورة الحالية (سباق 30 ثانية محدود)** ثم disconnect وexit 0.

---

## 9. واجهات الـ API

جميع المسارات مبنية عبر `createHandler`. **~50 مسارًا في 14 مجالًا:**

| المجال | المسارات (ملخص) | الصلاحيات |
|---|---|---|
| **Auth** | POST login (10/min)، register (5/min)، logout؛ GET me | عامة (محمية بالـ rate limit) |
| **Workspaces** | GET قائمة، POST إنشاء (10/min)، PATCH تبديل النشط | عضوية صالحة |
| **Conversations** | GET قائمة بفلاتر/cursor، GET/PATCH/DELETE [id]، GET/POST messages، POST retry، assign، read، **takeover، release-ai** | conversations.read/reply/assign/delete، channels.send_human |
| **Orders** | GET قائمة، GET/PATCH [id] (انتقال حالات مُتحقق منه) | orders.read/write |
| **Order Drafts** | GET قائمة/تفصيل، POST confirm (← قواعد ← طلب حقيقي، مُدقَّق)، cancel | orders.read/write |
| **Products** | GET/POST، GET/PATCH [id]، POST/PATCH/DELETE/PUT [id]/media | products.read/write |
| **Knowledge** | GET/POST، upload (ملف)، GET/PATCH/DELETE [id]، reindex، search (30/min)، FAQs | knowledge.read/write |
| **Media** | GET، upload (فحص magic-byte)، GET/PATCH/DELETE [id]، file/[key] (مصادق)، **public/[token] (موقّع بلا مصادقة)** | media.read/write |
| **Channels/Facebook** | GET صفحات متصلة، PATCH ربط شخصية (ai.configure)، connect (OAuth state موقّع)، **callback (عام موقّع)**، select-page، disconnect، اختبار اتصال | channels.read/connect |
| **Webhooks/Meta** | GET تحدي الاشتراك، POST استقبال (HMAC x-hub-signature-256 ← تخزين خام idempotent ← طابور ← 200 سريع) | عامة (HMAC) |
| **Analytics** | GET overview/conversations/orders/products/ai/automations/follow-ups/handoffs/funnel/sla/queue/usage، POST rebuild (super-admin/owner فقط، ≤92 يومًا، مُدقّق، 5/min) | analytics.read / usage.read |
| **Automations** | GET/POST، GET/PATCH/DELETE/POST [id] run-now | automation.read/write/execute |
| **Follow-ups** | GET قائمة، POST [id]/cancel | followups.read/cancel |
| **Handoffs** | GET قائمة، POST [id] بـ action: claim/release/resolve/route (ROUND_ROBIN أو LEAST_LOADED) | handoffs.read/claim |
| **AI** | GET/PATCH settings، playground: validate/sessions/[id]/messages (20/min) | ai.configure |
| **أخرى** | Customers، Feedback، Personas، Jobs/run (x-jobs-secret، ممنوع في الإنتاج بلا سر)، Health (عام) | حسب النطاق |

---

## 10. المصادقة و RBAC

### تدفق المصادقة
POST login → التحقق من كلمة المرور (bcryptjs) → JWT HS256 (`jose`) في cookie `acre_session` (HttpOnly/SameSite=lax، 7 أيام) → كل طلب: حل المستخدم + حل `workspaceId` النشط + تحميل العضوية ACTIVE + حساب الصلاحيات الفعالة.

### RBAC — **37 صلاحية** عبر 7 أدوار
- الصلاحيات: `*.read/write` لكل نطاق (customers, conversations(+reply/assign/delete), orders, products, media, feedback, knowledge, personas)، `ai.configure`، `channels.read/connect/send_human`، `automation.read/write/execute`، `followups.read/write/cancel`، `handoffs.read/claim/resolve`، `analytics.read`، `usage.read`، `users.manage`، `settings.manage`، `workspace.manage`.
- المصفوفة: **SUPER_ADMIN/OWNER/ADMIN → الكل**؛ MANAGER → مجموعة كاملة ناقص users/workspace manage؛ SALES_AGENT → قراءة/كتابة أساسية + send_human + handoffs claim؛ SUPPORT_AGENT → مثل البيعي **بدون orders.write**؛ VIEWER → قراءة فقط.
- الصلاحيات الفعالة = دور ∪ تجاوزات العضوية (`permissions[]`)، وتُحمّل **طازجة كل طلب** (تغيير الدور فوري الأثر). isSuperAdmin يمنح SUPER_ADMIN.
- **عزل المستأجر server-side:** كل استعلام خدمة مقيد بـ `auth.workspaceId` عبر أنماط `getOwned*` (مُغطى اختبارًا بمسح tenant-isolation في phase9-security).

---

## 11. قنوات التواصل (فيسبوك ميسنجر)

فيسبوك ميسنجر هو **القناة الوحيدة الحقيقية** (مُنفّذة)؛ بقية الأنواع معرّفة في enum مع mock-adapter للتطوير/الاختبار.

| الملف | المسؤولية |
|---|---|
| `client.ts` | عميل Graph API: إرسال رسائل، تبادل توكن، اشتراك صفحة — factory قابل للحقن للاختبار |
| `normalizer.ts` | تحقق التوقيع، تحدي الـ webhook، تحويل payload إلى رسالة واردة معيارية، dedup بالـ event id |
| `oauth.ts` | OAuth state موقّع (صلاحية 10 دقائق) + توكنات اختيار الصفحات |
| `policy.ts` | **MessagingPolicy**: نافذة 24h للـ HUMAN_AGENT، قواعد من يرسل (human vs AI) |
| `webhook.ts` | `ingestMetaWebhook` ← توجيه إلى خط المحادثات |
| `profile.ts` | حل اسم المرسل |
| `types.ts` | ثابت نافذة 24h، تصنيف أخطاء TRANSIENT/PERMANENT |
| `outbound.ts` | خط الإرسال الصادر: `sendHumanReply`، `dispatchOutbound` (حفظ رسالة ← فحص سياسة ← إرسال مع إعادة محاولة ← SENT/FAILED)، `recoverStuckOutboundMessages` |

---

## 12. المحادثات وصندوق الوارد

`conversations/service.ts` (847 سطر) — **`processIncomingMessage` هو نقطة دخول واحدة لخط الرسائل**: حل العميل عبر ChannelIdentity ← ضمان المحادثة ← idempotency بالـ event id ← حفظ الرسالة ← تحديث unread/طوابع زمنية/إعادة فتح ← بث `MessageReceived` (معالجة AI **مفصولة تعمدًا** عبر الأحداث/الطابور). إضافة إلى: قوائم بفلاتر وcursor pagination، سلاسل رسائل، إرسال رد بشري، قراءة/غير مقروء، **حذف ناعم مُدقّق**، تعيين وكيل، takeover (إيقاف AI) وrelease-ai.

الثابت الحرجة: **`HUMAN_ACTIVE` ⇒ صفر ردود AI** (مثبتة اختبارات ×100).

---

## 13. الطلبات وذكاء الطلبات (`src/modules/orders`)

| الملف | المسؤولية |
|---|---|
| `primitives.ts` | تحويل أرقام عربية←غربية، تطبيع هاتف، تحليل كمية/إشارة تأكيد، استنتاج محافظة، حل منتج ضبابي |
| `draft-service.ts` | مسودة لكل محادثة (get-or-create)، تحديث من استخراج AI، حقول مطلوبة: المنتج/الكمية/الهاتف/العنوان، إلغاء، ملخص |
| `rules.ts` | محرك قواعد ← حكم ALLOW/DENY/REQUIRE_INPUT/REQUIRE_HUMAN + كشف طلبات مكررة بمستويات + أحداث |
| `pricing.ts` | تفصيل السعر + ملخص عربي للطلب |
| `delivery.ts` | تسعير توصيل لكل workspace مع `assertWorkspaceScope` |
| `state-machine.ts` | التحقق من انتقالات حالة الطلب والمسودة |
| `order-service.ts` | `createOrderFromDraft`، `transitionOrder`، دمج بيانات العميل |
| `intelligence.ts` | `handleOrderIntent` — تدفق AI→مسودة (حتمي، ليس LLM) |

---

## 14. الأتمتة والمتابعات (`src/modules/automation`)

- `schemas.ts`: محفزات + مجموعات شروط + اتحاد أفعال مميّز (discriminated union).
- `conditions.ts` + `template.ts`: تقييم الشروط/المجموعات، تحقق القوالب وتصييرها (allowlist).
- `engine.ts`: `eventToTrigger`، `evaluateEvent` (تنفيذ المطابقة)، **`registerAutomationBridge`** — جسر حدث→مهمة دائمة (يُسجّل مرة في الـ worker).
- `followup-service.ts`: إنشاء/إلغاء متابعات، **claim ذري للمستحقة**، تنفيذ عبر القناة الصادرة، `processDueFollowUps` (10 دفعة).
- Idempotency: `FollowUp.idempotencyKey unique` و`AutomationExecution unique(automationId, triggerEventId)` — الاستدعاء المكرر للحدث لا يضاعف التنفيذ.

---

## 15. التحليلات والملاحظة

- `aggregation.ts`: **rebuild يومي idempotent** لكل workspace/day (unique(workspaceId, date))، مع rebuild نطاقي (حد 92 يومًا).
- `service.ts`: 11 تقنية تحليلات فوق التجميعات اليومية (overview, conversations, orders, products, AI, automation, follow-ups, handoffs, **funnel**, **SLA**).
- `AIUsageLog` يسجّل لكل استدعاء AI: purpose, provider, model, intent, confidence, promptVersion, tokens (prompt/completion), costUsd, latencyMs, success/error → صفحة `/analytics/ai` و`/api/analytics/usage`.
- سلسلة ارتباط تتبع كاملة عبر `correlationId` (انظر §5 observability).

---

## 16. الوسائط (`src/modules/media`)

- `storage.ts`: حدود حجم لكل MIME، **تحقق magic-byte** (لا ثقة بالـ Content-Type)، `LocalStorageProvider` خلف واجهة `StorageProvider`، توليد مفاتيح آمنة.
- `service.ts`: رفع/قائمة/تحديث/حذف، البحث عن وسائط منتج/feedback لسياق AI (`findRelevantMedia`)، **توقيع روابط عامة** (`/media/public/[token]` موقّع بلا مصادقة).
- معالجة `process_media` تستخرج أبعاد PNG (IHDR) best-effort.

---

## 17. واجهة المستخدم (لوحة التحكم)

- **`layout.tsx` الرئيسي:** `<html lang="ar" dir="rtl">`، خط IBM Plex Sans Arabic عبر next/font، ToastProvider، سكربت سمة مضمّن قبل الطلاء (localStorage.theme / prefers-color-scheme، **بلا FOUC**، suppressHydrationWarning).
- **`page.tsx`:** server component يقرأ الجلسة ويحوّل إلى /dashboard أو /login (لا صفحة هبوط).
- **`(auth)`:** login/register — أغلفة رقيقة حول `AuthForm` مشتركة.
- **`(dashboard)`:** 18 صفحة عميل (`"use client"`) تستدعي REST، شريط جانبي مقيّد بالصلاحية عبر `nav-items.ts`، AppShell: `/dashboard`، `/conversations` (Inbox كامل: قائمة/فلاتر/سلسلة/رد/تعيين/takeover)، `/customers`، `/orders`(+[id])، `/products`(+[id])، `/media` (رفع بـ XHR progress)، `/feedback`، `/knowledge` (مستندات+FAQs+بحث دلالي)، `/personas`، `/ai/playground`، `/channels`، `/automation`، `/follow-ups`، `/handoffs`، `/analytics`(+ai, products)، `/settings`(+ai).
- **components:** `app-shell`, `app-sidebar`, `auth-form`, `empty-section`, `inbox/*` (4 مكونات), وUI kit من 12 مكونًا (avatar, badge, button, card, dialog, empty-state, input, skeleton, stat-card, tabs, theme-toggle, toast).
- **globals.css:** نظام توكنات فاتح/داكن (`:root`/`.dark`)، توهجات خلفية، فئة `.num` لعزل الأرقام LTR داخل RTL، زجاجيات (glass-subtle/strong)، أنماط data-table.

---

## 18. البيانات التجريبية (`prisma/seed.ts`)

Seed idempotent (للبيئة المحلية/docker فقط): مستخدم `admin@demo.local` (OWNER)، workspace `demo-store` مع AISettings وشخصية "Sara" (عربية/لهجة سورية، غير رسمي، ردود قصيرة)، قناة فيسبوك واحدة، **5 منتجات عربية زعترية/كمثرية** بـ SYP مع variants وFAQs، 3 عملاء بهويات فيسبوك (دمشق/حلب/حمص)، **5 محادثات بسيناريوهات عربية كاملة** (OPEN-AI_ACTIVE، RESOLVED، شكوى مع takeover، PENDING، CLOSED)، ChannelAccount بتوكن مشفر، تسليم بشري مفتوح (COMPLAINT/HIGH)، طلب DEMO-0001، **20 شهورة** (15 معتمدة + 5 معلقة)، **5 مستندات معرفة READY** و4 FAQs عامة.

---

## 19. الاختبارات

**30 ملف اختبار، ~425 حالة** (Vitest، بيئة node). البنية: `tests/helpers/inmemory-db.ts` — بديلة Prisma في الذاكرة (~600 سطر: where filters مع contains/in/gt/OR/AND/NOT، مفاتيح مركبة، فلاتر علاقات، upserts، عدّ، ترتيب) تجعل منطق خط الأنابيب قابلًا للاختبار بلا قاعدة بيانات. `setup.ts` يضبط NODE_ENV=test وقيم env وهمية.

| الملف | الحالات | التغطية |
|---|---|---|
| phase2-pipeline | 21 | خط المحادثات (عملاء/محادثات/رسائل) |
| phase3-knowledge | 18 | KB + منطق RAG |
| phase4-ai | 29 | Orchestrator كامل، حقن، حراسة، RAG، usage logs، idempotency |
| phase5-orders | 30 | استخراج، آلة حالات، تكرار، snapshots |
| phase6-facebook | 22 | adapter + idempotency صادرة |
| phase7-automation | 26 | handoffs، follow-ups، قواعد، allowlist قوالب |
| phase8-analytics | 23 | تتبع أحداث، usage، بيانات لوحة |
| phase9-security | 7 | مسح عزل مستأجرين، replay ×100، مصفوفة RBAC، fuzzing تحقق |
| ai-mode-persona | 19 | AI_ACTIVE الافتراضي، takeover/release، شخصيات لكل صفحة، HUMAN_ACTIVE ×100 |
| durable-processing | 19 | "لا صمت، لا تخلي عن رسالة واردة" — متانة الطابور |
| master-reliability | 17 | starvation الكاسح، إعادة معالجة AI_DISABLED، سباقات المهام النشطة، عزل الشخصيات |
| production-audit-fixes | 25 | انحدارات مدققة (أسماء عربية وسائط، MIME fallback، رفع، تخزين) |
| inbox-conversations | 15 | قوائم/فلاتر/عمليات |
| knowledge-e2e | 16 | رفع ← chunk ← استرجاع |
| media-e2e | 13 | دورة حياة الوسائط |
| facebook-webhook-batching | 7 | دفعات PSID نفسها: لا فقدان، dedup سليم |
| playground-isolation | 12 | عزل ملاعب AI |
| أخرى (crypto, errors, api-handler, rbac, oauth, subscription, send-profile, forensic, production-safety, token-expiry, upload-forensics, media-public-url) | ~100 | تفاصيل أمنية وموثوقية |

سلاسل E2E مغطاة بالـ mocks: **Webhook فيسبوك ← عميل/محادثة ← AI ← مسودة طلب ← تأكيد ← قواعد ← طلب ← أتمتة ← متابعة ← إرسال فيسبوك** مع idempotency وتزامن (replay ×100، claims ×100، HUMAN_ACTIVE ×100).

---

## 20. البنية التحتية والنشر

### Docker
- **Dockerfile:** 3 مراحل (deps/builder/runner) على `node:20-alpine` + openssl + libc6-compat (إصلاح Prisma musl). بلا أسرار وقت البناء. مستخدم غير جذري `nextjs`، مجلد `/app/.data/storage` مُنشأ مسبقًا. CMD: `prisma migrate deploy && npm start`.
- **docker-compose.yml:** 3 خدمات (Coolify-compatible): `app` (3000، healthcheck)، `postgres` (`pgvector/pgvector:pg16` + init SQL + healthcheck)، `worker` (نفس الصورة، migrate deploy ثم worker، بلا منافذ). `.env` اختياري (`required: false`).

### سكربتات
- `scan-secrets.mjs`: فحص أسرار (exit 1 عند اكتشاف) — مفتاح Meta 32-hex، `sk-`، توكنات EAAG، JWT_SECRET، مع allowlist لأنماط الاختبارات.
- `staging/validate-staging.sh`: 10 خطوات PASS/FAIL (prerequisites، compose up، فحص سجل worker، migrate deploy، تحقق SQL من pgvector/قيد/فهارس).
- `staging/concurrency.mjs`: اختبار تزامن HTTP+Postgres حقيقي: **100 webhook متطابق متزامن ← 1 حدث/رسالة**؛ 100 تأكيد مسودة متزامن ← 1 طلب؛ 100 claim تسليم ← 1 فائز (409 للبقية)؛ تقارير p50/p95/p99.
- `staging/probe-db.cjs`: فحص بيانات اعتماد Postgres المحلية.

### بلا CI
لا يوجد `.github/` — **لا GitHub Actions** (فرصة تحسين: CI يدوّق lint/typecheck/test/scan).

---

## 21. الأمان

| الضابط | التفاصيل |
|---|---|
| الجلسات | JWT HS256، cookie HttpOnly/Secure/SameSite=lax، 7 أيام |
| CSRF | فحص Origin/Host لكل أفعال التعديل (403 CSRF_REJECTED)؛ webhooks/server-to-server بلا Origin تمر |
| RBAC | 37 صلاحية + عزل workspace server-side في كل استعلام |
| تشفير | أسرار القنوات AES-256-GCM at rest؛ redaction في logs |
| Webhook | HMAC-SHA256 بـ timing-safe؛ تخزين خام idempotent (unique(source, externalEventId)) |
| OAuth | state موقّع بصلاحية 10 دقائق |
| الحقن | تعليمات موثوقة/محتوى غير موثوق ملفوف، كشف حقن ← handoff، حارس `INJECTION_ECHO` على المخرجات |
| الهلوسة | أسعار DB فقط + حارس أمانة السعر (تطبيع أرقام عربية) + سيناريو "لا أعلم" + منع ادعاءات طبية |
| الحدود | payload 110MB، حدود وسائط لكل نوع مع magic-byte، rate limits على المسارات الحساسة |
| الأخطاء | معالج موحّد لا يسرّب internals (المجهول ← 500 عام) |
| الأسرار | بلا مفاتيح حقيقية في Git + `npm run scan:secrets` |
| CSP | security headers على كل المسارات، frame-ancestors 'none'، img-src يسمح بـ Facebook CDN، connect-src graph.facebook.com |

**SECURITY-AUDIT.md** (2026-09-21): F-001 (سباق webhook متزامن — **مُصلح**)، F-002 (rate limiter في الذاكرة — معروف)، F-003 (lease المهام — مُصلح)، F-004/5/6 (ثانوية)، F-007 (multi-worker غير مُختبر). ضوابط مُثبتة: عزل مستأجرين ×13 نوع مورد، idempotency ×100، ذرية handoff، ثابت HUMAN_ACTIVE، حقن، تشفير، RBAC، Zod.

---

## 22. الضمانات المعمارية العرضية

| الاهتمام | الآلية |
|---|---|
| منع حلقات AI | معالجة الوارد/CUSTOMER فقط (NOT_INBOUND) |
| Idempotency AI | AIUsageLog SUCCESS/HANDOFF ← DUPLICATE؛ السجل بعد الإرسال؛ مفتاح `ai:{messageId}` + فهرس partial unique |
| dedup المهام | P2002 ← deduplicated؛ claim ذري PENDING→PROCESSING |
| استرجاع أعطال | استئجار 10 دقائق، استرجاع صادر عالق، كاسح يتامى (72h، واعٍ بالتراجع، صفّي) |
| تصنيف إعادة المحاولة | `AIProviderError.retryable`؛ عابر (timeout/429/408/425/5xx) ← إعادة داخلية + تراجع دائم؛ دائم (4xx/تكوين) ← فشل سريع |
| Fail-closed AI | مزوّد حقيقي مطلوب في الإنتاج؛ غير مهيأ ← AI_FAILED + handoff + audit، **بلا رد مفبرك** |
| حماية الحقن | فواصل untrusted، كشف ← handoff، حارس صدى |
| حماية الهلوسة | أسعار DB موثوقة فقط + حارس أمانة السعر + لا ادعاءات طبية |
| صحة RAG | أختام هوية التضمين تفلتر المتجهات غير المتوافقة؛ embeddings لا تُسرّب عبر API؛ عزل workspace داخل SQL المخزن |
| العزل | Playground بجداوله فقط؛ عزل أخطاء EventBus؛ قياس usage معزول الأخطاء؛ logUsage لا يرمي أبدًا |

---

## 23. نقاط القوة

1. **موثوقية هندسية نادرة في مشاريع بهذا الحجم:** idempotency في كل طبقة (رسائل، مهام، طلبات، متابعات، أتمتة)، claim ذري، استرجاع أعطال ثلاثي (lease/عالق/يتامى)، وثابت "لا صمت ولا تخلي".
2. **فصل الأدوار الأمني صارم:** AI يقترح، القواعد تقرر، الخدمات تنفذ، DB مصدر الحقيقة — و`HUMAN_ACTIVE ⇒ صفر ردود AI` مثبتة اختبارًا.
3. **حدود ثقة للمحفزات:** فصل صريح بين التعليمات/البيانات الموثوقة ومحتوى العميل غير الموثوق مع كشف حقن مزدوج (دخول + خروج).
4. **RAG هندسي صحيح:** أختام هوية التضمين، فهرس partial unique للمهام، عزل المستأجر داخل SQL، تجريد مخزن قابل للتبديل.
5. **عزل Playground بالبناء** وليس بالفحص — جداول منفصلة ومسار منفصل.
6. **تغطية اختبارية شاملة (~425 حالة)** تشمل تزامنًا واسترجاع أعطال، مع بديلة DB في الذاكرة تجعل المنطق سريع الاختبار.
7. **Fail-closed في كل مكان:** env، مزوّد AI، الحوار مع العملاء — الفشل دائمًا ظاهر ومُسجّل، لا mock صامت ولا 0$ زائف.
8. **RTL وi18n أصيلان:** تصميم عربي أصلًا (خط، توكنات، `.num`، سيناريوهات seed عربية)، تحويل أرقام عربية في الطلبات والحراسة.
9. **تدقيق أمني ذاتي صادق** مع قائمة NOT VERIFIED غير مُجمَّلة.

---

## 24. نقاط الضعف والمخاطر وتوصيات التحسين

### عالية الأولوية
| # | الملاحظة | الأثر | التوصية |
|---|---|---|---|
| 1 | **Rate limiter في الذاكرة** (F-002) | بلا سقف فعلي عند تشغيل عدة نسخ | الترحيل إلى Redis أو تخزين DB قبل الإنتاج متعدد النسخ |
| 2 | **لا CI/CD** (بلا `.github/workflows`) | انحدارات قد تصل بلا بوابة | سير عمل GitHub Actions: lint + typecheck + test + scan:secrets على كل PR |
| 3 | **قائمة NOT VERIFIED** غير منفذة (بلا E2E حقيقي/DB حقيقي/حمل/نسخ/استرجاع) | مخاطر إنتاج غير مُقاسة | تنفيذ validate-staging + concurrency.mjs على بنية حقيقية، ثم Playwright E2E وload baseline وbackup/restore |
| 4 | **`orchestrator.ts` 924 سطرًا** و`conversations/service.ts` 847 | صعوبة صيانة وتطور | تجزئة إلى وحدات فرعية (gating, extraction, order-intent, handoff-policy, response-gen) |
| 5 | **Meta production غير مُختبر** (OAuth/إرسال/webhook حقيقي) | أخطاء تكامل محتملة | اختبار ميداني بحساب Meta تجاري قبل الإطلاق |

### متوسطة الأولوية
| # | الملاحظة | التوصية |
|---|---|---|
| 6 | EventBus in-memory — الأحداث تُفقد عند إعادة التشغيل (الطابور يغطي المسارات الحرجة فقط) | توثيق الحدث غير الدائم؛ الترحيل لـ Redis stream عند الحاجة |
| 7 | طابور DB يتنافس مع الاستعلامات على نفس القاعدة | مراقبة الحمل؛ BullMQ/Redis عند تجاوز عتبة |
| 8 | قناة واحدة حقيقية (فيسبوك)؛ الأنواع الأخرى enum بلا تنفيذ | لا تعد بمزيج قنوات في التسويق قبل التنفيذ؛ أو نفّذ WhatsApp التاليًا (الحقول جاهزة) |
| 9 | `unsafe-inline` في CSP للأكواد البرمجية | الانتقال لـ nonces/hashes عبر Next.js middleware |
| 10 | حساب التكلفة AI يعتمد على جدول أسعار يدوي (`COST_PER_1K`) | التحديث الدوري أو جلب أسعار API |
| 11 | حدود القيم الصعبة مشتتة (110MB في handler، 700 حرف في guardrails، 72h في jobs) | مركزيتها في `env.ts`/ثوابت config موثقة |
| 12 | لا صفحة هبوط ولا إدارة أعضاء الفريق (`users.manage` صلاحية بلا صفحة) | بناء صفحة إدارة الأعضاء/الدعوات (INVITED موجود بالـ schema بلا استخدم ظاهر) |

### منخفضة الأولوية
13. `plan` و`maxDailyMessages` موجودة لكن لا توجد قيود استخدام فعلية (enforcement) — جاهزية خطة فاتورة.
14. `Whatsapp/Telegram` توكنات في env بلا كود — إزالتها من .env.example حتى التنفيذ لتفادي توقع زائف.
15. seed يحتوي بيانات اعتماد تجريبية (`Demo#2026!`) — تأكد من حجب seed في الإنتاج (موثوق أنه local/docker فقط).
16. ESLint 8 + Next 14 — الترقية المستقبلية (Next 15 / React 19) ستتطلب جهدًا؛ موثّق لكن غير عاجل.

---

## 25. قائمة NOT VERIFIED

(مستخرجة من SECURITY-AUDIT.md — متطلبات بنية حقيقية لم تُنفذ بعد: لم يكن Docker متوفرًا وقت التدقيق، وPostgreSQL محلي محجوب بخدمة Odoo على المنفذ 5432)

- [ ] Migrations على PostgreSQL حقيقي (فحص `\d`).
- [ ] بحث pgvector المتجهي الحقيقي بالتشابه.
- [ ] Worker طويل الأمد + استرجاع stale + **عدة workers** (F-007).
- [ ] E2E بـ Playwright / HTTP حقيقي.
- [ ] قياس حمل (load baseline) — السكربت جاهز: `staging/concurrency.mjs`.
- [ ] Backup / Restore.
- [ ] Meta production: OAuth، webhook، إرسال فعلي.
- غير قابل للتطبيق حاليًا: Redis/BullMQ (المهام على DB)، SSRF (لا fetch server-side بعد).

---

## خاتمة

المشروع في حالة **هندسية ممتازة** لموسم تطوير من 9 مراحل: بنية نظيفة متعددة الطبقات، ضمانات موثوقية على مستوى أنظمة الإنتاج، وتغطية اختبارية شاملة. **نقطة الانتقال للإنتاج الحقيقي** هي تنفيذ قائمة NOT VERIFIED على بنية حقيقية + معالجة العناصر 1–3 من قائمة نقاط الضعف (Redis rate limiting، CI، اختبار Meta الحقيقي).
