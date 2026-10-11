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

---

## P1 Addendum (2026-10-10 — يُقرأ مع ما فوقه، ولا يلغي التاريخ)

**F-002 (rate limiter) — PARTIALLY FIXED:** أُعيدت الكتابة بجملة upsert ذرية (قفل الصف يلغي سباق النسخ ومسار P2002) + سياسة فشل صريحة (memory-fallback افتراضيًا، fail-closed بـ 503 على login/register). التوزيع متعدد النسخ على DB واحدة ما زال **NOT VERIFIED** (يحتاج staging).

**تقنيع PII — NEW CONTROL (VERIFIED_LOCAL):** بوابة `ai/privacy-gate.ts` عند حد كل نموذج خارجي (خزينة رموز لكل استدعاء، استعادة محلية، حجب المخترَع، رفض fail-closed) + قاعدة حراسة `UNVERIFIED_CONTACT` + 12 اختبارًا على مسار provider. المتبقي: رقم 7–8 أرقام بلا شكل هاتفي خارج التغطية (موثّق).

**PgVectorStore SQL — FIXED (was NOT VERIFIED, now VERIFIED_LOCAL):** عمود غير مقتبس (`c.workspaceId` → 42703) أصلح إلى `c."workspaceId"` + اختبارات انحدار + إثبات حي على Postgres حقيقية.

**أسرار البيئة المحلية — FIXED (dev-only):** مفتاح `ENCRYPTION_KEY` المحلي كان يحوي `#` فيقطعه dotenv (أقل من 32 حرفًا) كاسرًا `db:seed`؛ جُدّدت أسرار `.env` المحلية (hex، القاعدة كانت فارغة فلا أثر) + `EncryptionError` يحمل سبب الإعداد الآمن فقط. ملاحظة: أي مفتاح إنتاجي لامس هذا الخلل يجب تدويره من مالكه — لا مفاتيح إنتاج في المستودع (`scan:secrets` نظيف).

**حتمية الحزمة — FIXED:** `@prisma/client` يحمّل `.env` عند أول استيراد (بعد `setup.ts`) فكانت النتائج تعتمد على البيئة المحلية؛ `tests/setup.ts` أصبح hermetic (استيراد مبكر + فرض قيم اختبار). الحزمة الآن 476/476 حتمية.

**CI — ADDED (CODE_COMPLETE):** `.github/workflows/ci.yml` (تشغيل Actions الخارجي BLOCKED على push/PR).

**سجل القنوات — HARDENED:** لا mock صامت (رفض `CHANNEL_NOT_SUPPORTED`)؛ ترحيل تدفقات Messenger الحية مؤجل لـ P5.

**NOT VERIFIED (ما زال):** Meta/OMS الحي، staging الحاويات (Docker غائب محليًا)، الحمل، E2E المتصفح، استقرار worker الطويل، multi-worker.

## P1.1 Addendum (2026-10-10 — يُقرأ مع ما فوقه)

**صيغ الهواتف — CLOSED (VERIFIED_LOCAL):** مطابقة القيم المعروفة بأي تهجئة + سياق ±25 + حجب صارم مع `allowedNumbers` + حراسة موحدة؛ المجهول العاري بلا سياق متروك عمدًا (سياسة موثقة + اختبارات مانعة للتسريب، 14 اختبارًا). لا تسريب في logs/handoff (مغطى).

**تدقيق AI الخارجي — COMPLETE:** كل المسارات الحية عبر البوابة (مثبت بجدول P1.1 في PROGRESS)؛ الرؤية خامدة بلا مستدعين؛ النقل (Graph) ليس استدلالًا.

**Messenger عبر السجل — WIRED (VERIFIED_LOCAL):** استقبال + إرسال حيان عبر `getChannelAdapter` (مخرجات مطابقة، سياسات محفوظة، رفض fail-closed، صفر حركة حقيقية في الاختبارات). البنود المتبقية NOT VERIFIED أعلاه لم تتغير.

## P2 Addendum (2026-10-10 — يُقرأ مع ما فوقه)

**OMS ثقة الـ webhook — HARDENED:** الـ workspace يُشتق من صف الطلب (hint الحمولة مرفوض عند التعارض)، HMAC إجباري قبل أي أثر، dedupe عبر `WebhookEvent`، الأحداث القديمة تُتخطى عبر `omsStatusAt` الجديدة. القيم المجهولة مرآة فقط.

**OMS حظر العملاء — ENFORCED:** المزامنة تطبق سياسة عدم رفع اليدوي؛ الإنشاء والترحيل يرفضان (`ORDER_CUSTOMER_BLACKLISTED` + تدقيق). الذكاء بلا مسار مباشر.

**OMS أسرار — VERIFIED_LOCAL:** التوكن مشفّر (AES-256-GCM)، لا يُرجع ولا يُسجَّل؛ سطح العميل قراءة+إنشاء+ملاحظة فقط (مثبت باختبار)؛ مفاتيح الاختبار وهمية.

**OMS عقد — EXTERNAL GAP (BLOCKED):** المسارات/المصادقة/pagination/الأخطاء/معرفات الأحداث/ضمان المفتاح المكرر — كلها مؤشرة غير مثبتة في وثيقة التوافق؛ لا PRODUCTION_VERIFIED حتى يثبتها فريق OMS ويُختبر اتصال حقيقي.

## P3 Addendum (2026-10-10 — يُقرأ مع ما فوقه)

**الفريق — BUILT + TESTED (VERIFIED_LOCAL):** دعوات منتهية/قبول ذاتي/أدوار/تعليق/إزالة — كلها `users.manage` خادميًا، مسجلة تدقيقيًا، بلا جداول جديدة (ترحيل `expiresAt` فقط).

**التفويض — PROVEN:** إبطال الموقوف فوري (نفس `getAuthContext` الإنتاجي مختبَرًا)، workspaceId من الجلسة فقط (PUT بلا مدخل)، آخر مالك محمي، SUPER_ADMIN غير قابل للإسناد، الذات غير قابلة للتعديل، أخطاء 403 بلا تسريب.

**المتبقي:** تعدد الجلسات/تدويرها، حذف مساحة، SSO/2FA، E2E متصفح — staging/قرارات لاحقة (BLOCKED).

## P4 Addendum (2026-10-10 — يُقرأ مع ما فوقه)

**الملاحظات — ISOLATED BY CONSTRUCTION:** صف `isNote` لا يقرأه المرسِل/الاسترداد/إعادة المحاولة (OUTBOUND + مفتاح فقط) ولا سجل AI ولا الأحجام؛ مسار `POST notes` بصلاحية `reply`؛ فقاعة مميزة بلا tick. مثبت باختبارات فصل الأنواع.

**الهوية المتزامنة — RACE CLOSED:** إنشاء المحادثة كان يرمي 500 تحت التسليم المكرر المتزامن — الآن التحاق بالفائز (P2002 → إعادة قراءة) مثل الهوية؛ مثبت بتسليم متوازٍ (محادثة + رسالة واحدتان).

**العزل/RBAC — PROVEN:** شركات متقاطعة 404 في المحادثات/العملاء/الملاحظات/الإسناد؛ تثبيت صلاحيات المسارات الجديدة؛ أجسام 403 نظيفة.

**سباق المالك (P3) — CLOSED:** تحقق لاحق مع تعويض + اختبار تزامني (≥1 مالك دائمًا).

## P5 Addendum (2026-10-10 — يُقرأ مع ما فوقه)

**سباق قناة auto — CLOSED:** فهرس جزئي + التقاط P2002 + اختبار (8 متوازية → صف واحد). التأثير كان تشتت توجيه/شارات بلا فقدان.

**تحقق كل مزوّد بشكله:** Meta HMAC (3 مسارات)، Telegram secret header (مطابقة دقيقة آمنة زمنيًا)، TikTok سر مؤقت (موثّق كمرحلي). لا HMAC موحد مخترع.

**أسرار القنوات — VERIFIED_LOCAL:** تحقق حي قبل التخزين، AES-256-GCM، لا إرجاع/تسجيل، إثبات ملكية الحساب عبر المساحات، الفصل يوقف الإرسال عبر السياسات، لا Mock صامت، AI لا يرى الاعتمادات.

**سياسات الإرسال — ENFORCED:** نوافذ 24h (Messenger/IG تحفظ/WhatsApp موثقة)، قوالب واتساب خارج النافذة = رفض صريح (لا حملات مسربة)، تيليغرام بلا نافذة (البنية تضمن بدء المستخدم)، تيك توك محافظ 24h + موافقة.

**المتبقي:** كل اتصال حي واعتماد خارجي (Meta/Telegram/WhatsApp/TikTok) — BLOCKED؛ E2E؛ staging حاويات.

## P6 Addendum (2026-10-10 — يُقرأ مع ما فوقه)

**F-004 (costUsd) — ACTUALLY FIXED (was documented-only):** الفحص وجد السكيمة ما زالت `NOT NULL DEFAULT 0` رغم ادعاء الإصلاح — أي `null` من `estimateCost` كان سيفشل داخل `logUsage` ويُبتلع بصمت (السجل مفقود لنماذج بلا تسعير). الترحيل `p6_ai_studio` جعلها `Float?` بلا default. مثبت باختبار (null لغير المسعّر، قيمة حقيقية للمسعّر). المضاعفة الاختبارية أُبقيت على default 0 عمدًا (لا تمس الاختبارات القائمة).

**تسريب PII في سجلات القياس — FIXED (VERIFIED_LOCAL):** مسار فشل `logUsage` كان يسجّل كائن الخطأ الخام (`log.error({ err })`) — وكائنات أخطاء طبقات التخزين قد تحمل بيانات عملاء (أُثبت برقم هاتف في مكدس الاختبار). الآن معرّفات آمنة فقط (`workspaceId/purpose/model`) بلا محتوى الخطأ. القياس لا يكسر العملية أبدًا (مثبت: DB ميتة → نجاح العملية محفوظ).

**الاستوديو — NEW SURFACE (كلها ai.configure/personas.write/channels.connect خادميًا، مثبتة بتثبيت صلاحيات):** فحص الاتصال يرسل `ping` اصطناعيًا فقط (مثبت نص الحمولة) والمفاتيح لا تُرجع ولا تُسجَّل (مثبت)؛ المسودات والنسخ والإصدارات معزولة مساحيًا (404 عابرة)؛ الربط قناة↔شخصية يرفض الأجنبي؛ لا SSRF جديد (لا جلب server-side لروابط المستخدم — F-005 ما زال OPEN موثّقًا)؛ الذكاء لا يرى اعتمادات القنوات (بلا تغيير).

**البديل — CONSTRAINED:** يعمل فقط عند تهيئة `fallbackModel` + فشل retryable أولي، وعبر نفس `sendProtected*` (مثبت على المدخلات المسجلة للمحاولتين)؛ الأخطاء الدائمة لا تلمسه (مثبت)؛ بلا بديل → فشل صريح `AI_FAILED` (مثبت، وانحدار `production-safety` أخضر: السلوك القديم محفوظ حرفيًا عند `mock`/غير مهيأ).

**المتبقي:** اتصالات المزودين الحية (مفاتيح/endpoint — BLOCKED على المالك)؛ الأرقام العارية بلا سياق (P1.1)؛ العقد الخارجي (P2)؛ كل بنود staging/E2E السابقة.

## P7 Addendum (2026-10-10 — يُقرأ مع ما فوقه)

**حراسة SSRF لـ `customBaseUrl` — CLOSED (VERIFIED_LOCAL) — يُحدّث F-005 جزئيًا:** الفجوة كانت أن `customBaseUrl` (مهيّأ من مستخدم بـ `ai.configure`) يُجلب من الخادم لاحقًا (فحص اتصال + كل استدعاء ذكاء عبر المزود الداخلي). جديد: `src/modules/ai/endpoint-guard.ts` — تحقق متزامن على كل استخدام (مسار الحفظ ومسار الفحص): http/https فقط، بلا بيانات دخول في الرابط، بلا loopback/LAN/link-local/multicast/reserved/CGNAT، بلا أسماء metadata معروفة، بلا صيغ IPv4/IPv6 مشوّهة (عشري/ثماني/سداسي عشري/قصير)، وبلا `.local/.internal/.corp/...`. تحقق DNS غير متزامن (TOCTOU/rebinding — best-effort موثّق) على مساري الحفظ والفحص: كل عنوان يعود يجب أن يكون Global Unicast. **سياسة موثقة:** endpoints الشبكة المحلية مرفوضة كليًا — النموذج الذاتي الاستضافة يجب أن يُعرَض على عنوان عام ليكون حد الثقة صريحًا وقابلًا للتدقيق. مثبت بالاختبارات (كل الأهداف الخطرة مرفوضة + حقن DNS للطبقة الثانية).

**سير العمل — NEW SURFACE (كل مساراته مثبتة على automation.read/automation.write خادميًا):** لا كود مخزَّن ولا eval — تعريف سير العمل هو مخطط Zod صارم بمجموعة مغلقة (مشغّلات/حقول شروط/إجراءات مسجلة فقط؛ المفاتيح المجهولة تُرفض — مثبت بمحاولات `EVAL` وحقن حقول). كل تنفيذ مملوك للمساحة (بناء السياق بفحص ملكية، والأحداث الأجنبية لا تنشئ صفوف تنفيذ — مثبت). الإجراءات الحساسة مُعاد التحقق منها لحظة التنفيذ: الإرسال يرفض HUMAN_ACTIVE/المحلولة/القناة غير الموصولة/العميل المحظور **قبل** إنشاء أي صف رسالة صادرة (مثبت)، الإسناد يتطلب عضوية نشطة في نفس المساحة (مثبت: الوكيل الأجنبي يُرفض)، والوسوم تُدوَّن في audit. المعاينة DRY-RUN بلا كتابة (مثبت بهوية لقطة المخزن قبل/بعد) ولا يلمس OMS (لا Order/OrderDraft — مثبت). سجلات التنفيذ تحمل أسبابًا آمنة فقط (رموز سياسات ومعرّفات — لا أجسام أخطاء خام).

**حدود ما لم يُختبر:** تزامن عمال متعددين على Postgres حقيقي (الضمان هو فريد `(automationId, triggerEventId)` على مستوى القاعدة)؛ staging/E2E — كله BLOCKED كما سابقًا.

## P8 Addendum (2026-10-10 — يُقرأ مع ما فوقه)

**سعر الجملة — SECRET BY CONSTRUCTION (VERIFIED_LOCAL):** سعر الجملة (من مزامنة OMS) لا يدخل أي Prompt ولا أي نص موجّه للعميل إطلاقًا — يُقرأ خادميًا فقط ويُعرض للموظف بشرط صلاحية `products.wholesale` صراحة (تثبيت RBAC: MANAGER فقط؛ SALES_AGENT/VIEWER لا). حارس نهائي `assertNoWholesaleLeak` يرمي قبل أي إرسال يحوي الرقم (مثبت). لوحة المساعد تخفي الرقم غير المخول (مثبت) وكل نصوص الاقتراح خالية منه (مثبت). رد الـ Pipeline الكامل الفعلي خالٍ منه (مثبت).

**الخصومات — GOVERNED (VERIFIED_LOCAL):** بلا "خصم حر": ضمن سقف OMS فقط لمن يملك `orders.discount`؛ فوقه/بلا سقف → سجل موافقة مشرف بـ `orders.discount.approve` — فصل واجبات (لا اعتماد ذاتي — مثبت)، لا قرار مزدوج (مثبت)، صلاحية 24 ساعة، والاعتماد مثبت على (productId + سعر لحظة الاعتماد) فيُبطل عند تغير السعر أو المنتج أو الانتهاء (EXPIRED/PRICE_CHANGED/PRODUCT_MISMATCH/NOT_APPROVED — كلها مثبتة). كل خطوة مدققة (`sales.discount_requested/approved/rejected`). النموذج الذكي بلا مسار خصم أصلًا (`plan.discount` يُملأ فقط في سياق الموظف).

**خطة البيع — DETERMINISTIC + CLOSED-SET (VERIFIED_LOCAL):** بلا eval وبلا أرقام من النموذج: كل رقم في `salesPlan` من قاعدة البيانات، والمخطط Zod صارم بمجموعات مغلقة (أسباب غياب العرض `NO_OFFER_REASONS` — لا نصوص حرة). صفوف العرض التالفة/المنتهية تُهمل fail-soft (مثبت) والتوفير يُعاد حسابه ولا يُوثق بحقل خام (مثبت). سياسة مضادة للإلحاق: سقف ضغطين لكل عرض/محادثة + رفض صريح من العميل يوقف العرض نهائيًا (مثبت). النموذج يستقبل الخطة كتلة موثوقة مع سطر "ممنوع" — وحارس `allowedNumbers` القائم توسّع ليشمل أرقام الخطة (بلا تغيير في الدلالة).

**المساعد (Coach) — INTERNAL-ONLY (VERIFIED_LOCAL):** لا إرسال تلقائي بنيويًا — اللوحة تُنتج اقتراحات `internalOnly` فقط وصفر رسائل OUTBOUND (مثبت)؛ الإدراج في المحرر فعل الموظف، والإرسال يبقى عبر مسار الرد الصريح القائم بإعادة التحقق اللحظي (السياسات/الأسعار). بلا صلاحية `orders.discount` حتى حساب تفاصيل الخصم ممنوع (مثبت). البيانات الناقصة → سبب صريح من المجموعة المغلقة، لا تخمين (مثبت). الأحداث: `COACH_USED` للقياس فقط.

**العزو الإعلاني — FIRST-TOUCH-WINS (VERIFIED_LOCAL):** `Customer.adSource` يُكتب مرة واحدة من إحالة موثوقة صريحة (referral/postback من القناة) فقط؛ إعادة إرسال الـ Webhook لا تستبدل أبدًا (مثبت)؛ غياب الإحالة يبقى null (غير معروف) — لا استنتاج من نص الرسالة (مثبت). الطلبات ترث مصدر العميل. فشل العزو لا يوقف المسار (best-effort موثق).

**القياس — SEPARATION OF CONCERNS (VERIFIED_LOCAL):** `SalesEvent` منفصل عن الإجراء: `OFFER_SHOWN` يُسجل فقط بعد وصول الرد فعليًا (اقتراح ≠ أُرسل — مثبت في الـ Pipeline الكامل)، `OFFER_ACCEPTED` فقط بطلب مؤكد بكمية ≥ كمية العرض لنفس SKU. بلا أرقام عائمة بلا سياق: الصيغ موثقة وقابلة للحساب اليدوي، ومعدل القبول null عند غياب العروض (لا قسمة على صفر — مثبت).

**حدود ما لم يُختبر:** عقد OMS الحي (عروض/أسعار حقيقية متدفقة)؛ التجميل التحليلي على بيانات إنتاجية؛ staging/E2E — BLOCKED كما سابقًا. migration واحد dev-only (`p8_sales_intelligence`). **لم يُرفع إلى GitHub** (P7+P8 بانتظار موافقة المالك).

## P9 Addendum (2026-10-10 — يُقرأ مع ما فوقه)

**تعريف الشرائح — CLOSED-SET (VERIFIED_LOCAL):** لا SQL ولا نص حر ولا كود مخزن يُنفَّذ — الشروط عشرة حقول مسماة فقط بمخطط Zod `.strict()` (حقل/عملية/قيمة غير معروفة → رفض، مثبت). التقييم حتمي من DB داخل المساحة صاحبة الشريحة (عزل من الاستعلام — مثبت)، وبحد 5000 مرشح حتى لا تتحول المعاينة لمسح غير محدود (مثبت). النتائج أرقام فقط — بلا بيانات شخصية في الاستجابة.

**الموافقة التسويقية — ENFORCED TWICE (VERIFIED_LOCAL):** `marketingConsent` على العميل تُفحص عند حساب الشريحة (توزيع أسباب مغلقة) **وعند الإرسال نفسه لكل مستلم** (اللقطة قد تكون قديمة — قائمة سوداء أو إلغاء موافقة بعد اللقطة → `EXCLUDED` بلا إرسال، مثبت). وجود رقم هاتف وحده لا يكفي — هوية موثوقة على نوع قناة الحملة شرط (مثبت).

**قرار القناة — REFUSED NOT IMITATED (VERIFIED_LOCAL):** ما لم تسمح به سياسة القناة رسميًا لا يُقلَّد: FACEBOOK/INSTAGRAM/WEB تُرفض (`CHANNEL_NOT_MARKETING_CAPABLE` — لا بث خارج نافذة 24h)، TIKTOK تُرفض (`CHANNEL_ACCESS_NOT_APPROVED`). واتساب = القالب المعتمد إجباريًا عبر Cloud API (المسار الرسمي الوحيد خارج النافذة)؛ تيليجرام = مشتركو البوت فقط. المجموعة مغلقة ويُرفض الإنشاء نفسه على قناة غير مسموحة (مثبت).

**الموافقة المثبتة على الحملة — PINNED (VERIFIED_LOCAL):** إصدارات المحتوى append-only (النسخة الأولى لا تُعدل أبدًا)، والاعتماد يثبّت (الإصدار + بصمة الجمهور `v1:{channel}:e{n}:x{n}` بلا بيانات شخصية)؛ أي تغيير محتوى أو جمهور بعد الاعتماد → `AUDIENCE_CHANGED` وإعادة التحقق والموافقة (مثبت). صلاحية `campaigns.approve` منفصلة عن `campaigns.write` (فصل واجبات — MANAGER فقط، مثبت).

**الإرسال الجماعي — VIA THE EXISTING GATED PATH (VERIFIED_LOCAL):** لا مسار إرسال موازٍ أبدًا — كل رسالة حملة عبر `dispatchOutbound` القائم (idempotency + سياسات + تصنيف عابر/دائم) بمفتاح ثابت `campaign:{id}:{recipientRowId}`: إعادة المحاولة تستعيد القبول نفسه ولا تضاعف الإرسال (مثبت). حد معدل durable على صف الحملة (نافذة دقيقة محفوظة — تبقى بعد إعادة التشغيل)، دفعة ≤ 50، محاولات ≤ 5 (مثبت). الإيقاف/الإلغاء يقرأ من DB قبل كل إرسال — لا رسالة بعد القرار (مثبت). محادثات الحملة `camp-*` مع `aiEnabled:false` — الذكاء لا يتفاعل معها (مثبت).

**اقتراح الذكاء — ZERO CUSTOMER PII (VERIFIED_LOCAL):** اقتراح نص الحملة يُرسل لكائن PII فارغ تمامًا (بلا أسماء/هواتف/قوائم) — اسم وهاتف عميل حقيقيان لا يظهران في أي Prompt (مثبت)، بلا أسعار مخترعة (منع صريح في الـ Prompt)، والقنوات المرفوضة تُرفض قبل أي استدعاء ذكاء (مثبت). المراجعة البشرية إجبارية قبل الحفظ، والإرسال عبر المسار المصرّف وحده.

**إصلاح أمني مصاحب:** تصنيف أخطاء WhatsApp client كان يعامل أكواد Graph ≥100000 (131047 خارج النافذة، 132000 قالب) كعابرة بسبب فحص `>= 500` الرقمي — أصبحت PERMANENT (لا إعادة محاولة بلا معنى لرفض قاطع)؛ 429/5xx/130429 تبقى عابرة (مثبت).

**حدود ما لم يُختبر:** إرسال قالب حي عبر Meta وحالة اعتماد القالب لدى Meta (تداره واجهة المالك)؛ مشتركو بوت Telegram حيًا؛ متعدد العمال على Postgres (نافذة المعدل تحت التزامن)؛ staging/E2E — BLOCKED كما سابقًا. migration واحد dev-only (`p9_campaigns`). **لم يُرفع إلى GitHub** (P7+P8+P9 بانتظار موافقة المالك).

## P10 Addendum (2026-10-10 — يُقرأ مع ما فوقه)

**تقارير الموظفين — صلاحية حساسة منفصلة (VERIFIED_LOCAL):** صلاحية جديدة `analytics.agents` (تثبيت RBAC: MANAGER فقط — SALES_AGENT/VIEWER مرفوضان) تُفحص خادميًا على مسار `/api/analytics/agents` وعلى نوع `agents` في التصدير (مثبت). كل الإسناد من حقول رسمية (assignedAgentId/HumanHandoff/AuditLog) — لا "آخر شخص شاهد" ولا استنتاج؛ رسائل AI لا تنسب أبدًا لموظف (مثبت). ما لا دليل له يُرجع UNAVAILABLE بسببه الموثق (`SALES_EVENT_HAS_NO_ACTOR`) — لا تخمين في التقرير.

**تصدير CSV — GUARDED (VERIFIED_LOCAL):** التصدير عبر نفس دوال الحساب الخادمية (لا مسار حساب موازٍ — أرقام حتمًا متطابقة مع الواجهة)، بعزل المساحة وبصلاحيات كل نوع، وحد 10,000 صف، وحارس حقن صيغ (الخلايا البادئة بـ `= + - @` أو محارف تحكم تُسبق بعلامة اقتباس مفردة — مثبت)، وBOM UTF-8، وكل تصدير مدقق (`analytics.exported` بالمساحة والمستخدم والنوع وعدد الصفوف). نوع `agents` يتطلب الصلاحية الحساسة صراحة (مثبت).

**الاتجاهات — READ-ONLY + SELF-HEAL (VERIFIED_LOCAL):** قراءة `DailyWorkspaceAnalytics` فقط (بلا كتابة على بيانات الأعمال)، والإصلاح الذاتي مهمة تجميع داخلية idempotently بمفتاح `analytics-rebuild:{ws}` — لا تلمس حالة أي Workflow ولا تنفذ إجراء إنتاجيًا (مثبت: مهمة واحدة مهما تكرر الطلب). الأيام المفقودة MISSING صراحة — لا صفر زائف في التقارير التنفيذية.

**دلالة null — NO FAKE ZERO (VERIFIED_LOCAL):** قاعدة عامة في كل طبقة P10: ما لا يمكن إثباته يظهر "غير متاح" (null) — تكلفة AI بلا تسعير معروف (مثبت)، تسليم/قراءة الحملات بلا webhooks حالة = UNVERIFIED موثق (مثبت)، عزو الحملات وROAS وقياس العروض لكل موظف = UNAVAILABLE بسببه (مثبت). لا يُبنى أي إجمالي على قيم مجهولة.

**حدود ما لم يُختبر:** webhooks حالة المزود (تسليم/قراءة حقيقية)؛ عزو حقيقي للحملات؛ التجميع على عامل حي ومتعدد العمال؛ staging/E2E — BLOCKED كما سابقًا. بلا migrations (صفر تغيير مخطط). **لم يُنشأ commit** — كل عمل P10 غير مرفوع بانتظار مراجعة المالك.

## P11 Addendum (2026-10-10 — يُقرأ مع ما فوقه)

**P11 مرحلة عرض بحتة — صفر تغيير أمني:** لا RBAC ولا Privacy Gate ولا Guardrails ولا سياسات قنوات ولا idempotency ولا عزل مساحات — كل التغييرات في مكونات العرض المشتركة والصفحات. القاعدة "إخفاء الزر ليس حماية" محفوظة: كل نقطة نهاية تحتفظ بفحصها الخادمي كما هو، والتأكيدات الجديدة (ConfirmDialog) تحسين UX فقط لا حماية.

**لا تسريب بيانات في الجوال:** لوحة العميل (Contact 360) على الشاشات الصغيرة تفتح عبر Drawer لنفس العضو المصادَق في نفس المساحة — لا بيانات جديدة تُعرض ولا مسار جديد يُفتح؛ نفس الاستدعاء الخادمي القائم بنفس الصلاحيات.

**إزالة مؤشرات زائفة ذات شأن أمني:** شارة المزود تعرض "حالة محفوظة — لم يُختبر حيًا" حتى يُشغّل المستخدم اختبار ping صريح (لا "متصل" بلا إثبات)؛ رسائل فشل القنوات مميزة بصريًا عن النجاح؛ نقطة الإشعار الثابتة (كانت توحي بتحويلات معلقة دائمًا) أُزيلت. فشل حفظ إعدادات AI وفشل التصدير واختبارات الاتصال كلها تظهر للمستخدم — لا فشل صامت في واجهات حساسة.

**حدود ما لم يُختبر:** جهاز جوال فعلي (الفحص على viewport محاكى بمتصفح Playwright حقيقي على خادم dev)؛ محادثة برسائل حية عبر قنوات حقيقية (القنوات غير موصولة — منطق الرسائل لم يتغير ومغطى باختبارات P4–P8). بلا migrations وبلا تغيير backend. **لم يُنشأ commit** — بانتظار مراجعة المالك.

## Hermes External-Persona Addendum (2026-10-11 — يُقرأ مع ما فوقه)

**نقل الشخصية خارجيًا دون توسيع سطح الثقة (VERIFIED_LOCAL):** في وضع Hermes تُحجب Persona/PersonaVersion والقوالب المحلية عن طلبات الرد (مثبت: أجسام الطلب الملتقطة خالية من علّامات الشخصية، وtelemetry بـ `personaId/version = null`)، ولا fallback بديل يخفي فشل Hermes (مثبت: كل المحاولات بنفس الموديل، `fallbackUsed=false`)، ولا سجلات `HumanHandoff` جديدة من المسار (مثبت: شكوى/طلب موظف/ثقة منخفضة/فشل المزود — صفر سجلات)، والمحادثات تبقى OPEN/AI_ACTIVE (مثبت) بلا إغلاق تلقائي. ما لم يتغير: Privacy Gate (تقنيع إجباري — مثبت بغياب الرقم الخام وحضور التوكن)، Guardrails (أسعار/أسرار/حقن — مثبت برفض السعر المخترع)، مسودات الطلبات وOMS، عزل المساحات (مثبت برفض cross-workspace قبل أي اتصال)، RBAC/المؤسسات/المستخدمون، ونظام Handoff اليدوي (claim/takeover البشري الصريح يعمل كما كان — مثبت برجوع legacy مع mock).
**حراسة Personas:** تفعيل/نشر/رجوع/ربط قناة لشخصية محلية مرفوض خادميًا 409 أثناء سيطرة Hermes (القراءة والمسودات والسجل باقية — لا حذف جداول). **حدود ما لم يُختبر:** صوت Hermes الحي على staging (نجاح HTTP ≠ شخصية خارجية — يلزم مراجعة رد فعلي)، فرع ORDER_BLOCKED في وضع Hermes (مراجعة منطقية فقط). بلا migrations. **لم يُنشأ commit** — بانتظار مراجعة المالك.

## Local-Persona Restoration Addendum (2026-10-11 — يُقرأ مع ما فوقه)

**أُزيل حارس 409 نهائيًا (`persona-control.ts` محذوف):** إدارة الشخصيات (إنشاء/تفعيل/نشر/رجوع/ربط قناة) تعمل في كل الأوضاع عبر المسارات الحقيقية (مثبت: 201/200 بلا 409 مع اختيار المزود الخارجي). الشخصية المختارة تُحقن في طلبات المزود الخارجي (مثبت بالأجسام الملتقطة) — لا `personaId` في العقد الخارجي (مثبت من الصيغة)، فلا معرّف مخترع. **ما لم يتوسع:** التعليق يشمل التحويل التلقائي فقط في المسار الخارجي (مثبت: صفر سجلات)؛ Privacy Gate وGuardrails والأسعار والطلبات والعزل وRBAC بلا تغيير (مثبت بالبطارية)؛ الـ fallback المهيأ صريح ومسجّل (أُصلح `fallbackAttempted` في telemetry الفشل). **إخفاء الاسم عرضي بحت:** القيمة `hermes` و`HERMES_*` والمسارات والمصادقة والسجلات والاختبارات untouched (مثبت بمسح نصوص + اختبارات المزود القائمة). **حدود ما لم يُختبر:** توليد حي عبر البوابة الحقيقية؛ مراجعة صوت فعلي. بلا migrations. **لم يُنشأ commit** — بانتظار مراجعة المالك.
