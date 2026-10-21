# PROGRESS — سيستم 7

آخر تحديث: 6 تشرين الأول 2026 — جلسة «الأساس أولاً» (B0 → B1 → B2).

## ملخص بالعربي (حسب U1)

- ملفات سيستم 7 الثلاثة (المنطق · التوافق مع OMS · برومبتات GLM) نُسخت إلى `docs/` بجانب PROJECT-REVIEW.md و SECURITY-AUDIT.md (صيغة docx + md).
- B0: جدول المطابقة فُحص مقابل الكود — المطابقة عالية؛ الفروقات مسجّلة أدناه.
- B1 (جزئي): محدد السرعة نُقل إلى قاعدة البيانات (`RateLimitEntry`) مع fallback للذاكرة عند تعذر الاتصال؛ واجهة «محوّل قناة» الموحّدة موجودة أصلاً (`ChannelAdapter` + `registry.ts`).
- B2 (كامل أساسه): ربط OMS — schema + مزامنة منتجات/زبائن + ترحيل الطلب المؤكد + webhook تغيّر الحالة + تقنيع PII قبل الموديل الخارجي.
- الاختبارات: **446/446 ناجحة** (31 ملف)، منها 8 اختبارات جديدة لـ OMS/التقنيع. Typecheck وLint نظيفان.
- جاهز

## جدول المطابقة (B0) — التحقق مقابل الكود

| الجزء | الحالة بالملف | الحالة الحقيقية | الدليل |
|---|---|---|---|
| صندوق الوارد الموحّد | ✅ | ✅ | `src/components/inbox/`, `conversations/service.ts`, اختبارات inbox |
| ماسنجر لعدة صفحات | ✅ (الاختبار الحقيقي ناقص) | ✅ بالكود — اختبار Meta التجاري معلّق على المالك | `channels/facebook/*`, `tests/phase6-facebook.test.ts` |
| الشخصية لكل صفحة واللهجة | ✅ | ✅ | `ai/channel-persona.ts`, `ai/persona-limits.ts` |
| فهم النية واستخراج البيانات | ✅ | ✅ | `ai/intent.ts`, `ai/structured.ts` |
| قاعدة المعرفة وRAG | ✅ | ✅ | `knowledge/*`, `tests/phase3-knowledge.test.ts` |
| الحراسة | ✅ | ✅ | `ai/guardrails.ts` |
| التحويل لموظف | ✅ | ✅ | `handoffs/handoff-service.ts` |
| مسودة الطلب والقواعد | ✅ | ✅ | `orders/draft-service.ts`, `orders/rules.ts` |
| الوسائط والفيدباك | ✅ | ✅ | `media/*`, `feedback/*` |
| ملعب التجربة | ✅ | ✅ | `ai/playground-service.ts`, `tests/playground-isolation.test.ts` |
| الطلبات | 🔄 | كان موجوداً كمحلي فقط — أُضيف ترحيل الـ OMS | `orders/*` + `oms/handoff.ts` (جديد) |
| المنتجات | 🔄 | أُضيفت حقول الـ OMS (سعر/عروض/مكمّلات/سقف/جملة) مع إبقاء حقول البيع | `prisma/schema.prisma` Product |
| المتابعات والأتمتة | 🔄 | موجودة على ماسنجر — توسعة القنوات معلّقة (B5/B6) | `automation/*` |
| التحليلات | 🔄 | مؤشرات المبيعات والإعلان معلّقة (B4/B7) | `analytics/*` |
| الأدوار والصلاحيات | 🔄 | رؤية الجملة وسقف الخصم معلّقة (B4) | `rbac/permissions.ts` |
| موجّه النماذج | 🔄 | عنوان خادم لكل مهمة معلّق (B3) | `ai/provider.ts`, `ai/router.ts` |
| الحظر والسبام | 🔄 | مصنّف السبام/السكام معلّق (B6) | `ai/guardrails.ts` |
| قنوات جديدة (إنستغرام/واتساب/تيليجرام/تيك توك/تعليقات) | ➕ | معلّق (B5) | `channels/registry.ts` — الواجهة الموحّدة جاهزة |
| الأب سيل والكروس سيل وسعر الجملة ومدرّب الموظفة والحملات ومصدر الإعلان | ➕ | معلّق (B4/B6) | — |
| التقنيع قبل الموديل الخارجي | ➕ | **منجز** | `ai/masking.ts` (جديد) + 3 اختبارات |
| الربط بالـ OMS | ➕ | **منجز (الأساس)** | `modules/oms/*`, `api/oms/*`, `api/webhooks/oms/route.ts` (جديد) |

## ما نُفّذ بهذه الجلسة

### B1 — التحصين
- `src/core/api/rate-limit.ts`: محدد السرعة على قاعدة البيانات (`RateLimitEntry`, upsert + شرط النافذة) بدل الذاكرة؛ fallback تلقائي للذاكرة إذا فشل الاتصال. `createHandler` يستخدمه الآن.
- واجهة المحوّل الموحّدة كانت موجودة (`channels/types.ts`) — تأكدنا ولم نلمسها.
- لم يُنفّذ بعد: تقسيم `orchestrator.ts` و`conversations/service.ts` (refactor كبير — جلسة مستقلة)، CI (GitHub Actions)، تشغيل `validate-staging`/`concurrency.mjs` على السيرفر.

### B2 — ربط الـ OMS (ملف التوافق)
- **Schema**: `OmsConnection` (توكن مشفّر بنفس آلية أسرار القنوات AES-256-GCM)، حقول Product من الـ OMS، `Customer.isBlacklisted`، `Order.omsOrderId/omsStatus/handedOffAt/adSource`.
- **`src/modules/oms/client.ts`**: `OmsClient` (GET products/customer/order · POST orders/note) بصلاحيات قراءة وإنشاء فقط؛ توقيع HMAC للـ webhook.
- **`src/modules/oms/sync.ts`**: مزامنة المنتجات (السعر/العروض/المكمّلات/سقف الخصم/الجملة من الـ OMS — الاعتراضات وملاحظات البيع والمكونات لا تُمس) + القائمة السوداء بالرقم + حفظ الاتصال.
- **`src/modules/oms/handoff.ts`**: ترحيل الطلب المؤكد للـ OMS بعدم تكرار بطبقتين (idempotencyKey + omsOrderId محلي)؛ بعده الطلب المحلي مرجع قراءة.
- **`src/modules/oms/webhook.ts` + `api/webhooks/oms/route.ts`**: استقبال `order-status-changed` عبر مسار موقّع (HMAC بالتوكن المفكوك) — يحدّث `omsStatus` دائماً والحالة المحلية فقط عبر مسار صالح بآلة الحالات، وينشر حدثاً على الباص للمتابعات بعد الشحن.
- **`src/modules/ai/masking.ts`**: تقنيع الرقم/الاسم/العنوان قبل أي استدعاء خارجي مع إرجاعها بعد الرد، وكشف أي رقم متبقٍّ (بوابة اختبار).
- **API**: `POST /api/oms/connection` (settings.manage) · `POST /api/oms/sync` (products.write) · `POST /api/oms/handoff` (orders.write) · `POST /api/webhooks/oms` (public, موقّع).
- **ترحيل**: `prisma/migrations/20261006000000_system7_oms_integration/migration.sql` (لم يُطبَّق محلياً — لا بيانات اتصال DB على هذه الآلة؛ يُطبَّق عبر `db:deploy`).

## المعلّق (بالترتيب حسب ملف برومبتات GLM)
1. B1 المتبقي: تقسيم orchestrator/conversations وحدة وحدة (بلا تغيير سلوك) · CI · اختبار ماسنجر بحساب Meta تجاري.
2. B3: عنوان خادم داخلي لكل مهمة بنفس الواجهة + ربط التقنيع فعلياً داخل `provider.ts` + تفريغ الصوت + قراءة الصور (R02).
3. B4: محرّك المبيعات (أب سيل/كروس سيل من `offers` و`complementarySkus` المزامنة، صلاحية رؤية الجملة، سقف الخصم وموافقة المشرف، مدرّب الموظفة، مصدر الإعلان `adSource` من بيانات الإحالة).
4. B5: القنوات الجديدة كمحوّلات + سياسة مراسلة لكل قناة.
5. B6: الفلترة (R03) · قوالب التسلسلات · الوصول للزبائن القدامى · الحملات الآمنة.
6. B7: ربط الأنظمة · المؤشرات الجديدة · قوالب الردود (R01, R05, R07, R08) · صندوق الجوال · مواءمة Zaki OS.
7. B8: الفحص النهائي.

---

## P0 — فحص خط الأساس (9 تشرين الأول 2026)

> فحص فقط — لم يُعدَّل أي كود منتج في هذه الجلسة. التعديل الوحيد هو هذا المقطع التوثيقي.

- **الفرع:** `main` — متزامن مع `origin/main` (لا ahead/behind).
- **الـ commit المفحوص:** `fd59fc6` — «feat(system7): OMS integration (connection, sync, handoff, webhooks) + System 7 docs» (2026-10-09).
- **الشجرة:** نظيفة — لا ملفات معدَّلة؛ غير متتبَّع فقط: `$null` و`.playwright-mcp/` (مخلّفات أدوات، لم تُمس).
- **وثائق System 7 v2 الإنجليزية** (`01_SYSTEM7_PRODUCT_SPEC_v2.md` · `02_ZAKI_OMS_INTEGRATION_CONTRACT_v2.md` · `03_SYSTEM7_GLM_PROMPT_PLAYBOOK_v2.md`): **غير موجودة** — لم يُخترع محتواها. البدائل العربية الموجودة: `سيستم_7_المنطق_والأقسام.md` · `سيستم_7_التوافق_مع_OMS.md` · `سيستم_7_برومبتات_GLM.md`. و`docs/SECURITY-AUDIT.md` غير موجود كملف docs لكن نسخة الجذر `SECURITY-AUDIT.md` موجودة ومقروءة.

### نتائج التشغيل الفعلي (P0 — مثبتة، ليست ادعاءات)

| الفحص | الأمر | النتيجة |
|---|---|---|
| الاختبارات | `npm test` (vitest) | **446/446 ناجحة — 31 ملف** ✅ (مطابق لادعاء الجلسة السابقة) |
| الأنواع | `npm run typecheck` | نظيف ✅ |
| Lint | `npm run lint` | بلا تحذيرات/أخطاء ✅ |
| الأسرار | `npm run scan:secrets` | نظيف ✅ |
| البناء | `npm run build` | `Compiled successfully` + `Generating static pages (74/74)` ✅ |
| الترحيلات | `prisma migrate status` (قراءة فقط) | قاعدة `ai_commerce` على `localhost:5432` **متصلة لكن 0/7 ترحيلات مطبَّقة** ⚠️ |
| الإقلاع | `next dev -p 3100` مؤقتًا | يقلع (`Ready in 3s`) و`GET /login` → **200** ✅ ثم أُطفئ ونُظِّف |
| المنفذ 3000 | فحص المستمع | **مشغول بتطبيق آخر** (node تابع لخدمة n8n — استجابة `/api/health` بشكل `zaki-workspace` لا يطابق `src/app/api/health/route.ts`) — ليس تطبيق هذا المستودع ⚠️ |

### تصحيحات B0 (مقابل جدول المطابقة السابق)

1. «واجهة محوّل قناة موحّدة موجودة» — **جزئي**: الواجهة (`channels/types.ts`) موجودة لكن `registry.ts` يعيد `MockChannelAdapter` فقط، وماسنجر (`channels/facebook/*` — 7 ملفات) **لم يُنقل عليها**. الحالة: IN_PROGRESS لا ✅.
2. «التقنيع قبل الموديل الخارجي منجز» — **جزئي**: أداة `ai/masking.ts` موجودة ومختبرة، لكن **لا يوجد أي استيراد لها في `provider.ts`/`orchestrator.ts`** (البحث يعيد الملف نفسه فقط). الربط الفعلي معلّق أصلًا تحت B3 — الحالة: CODE_COMPLETE للأداة، NOT_STARTED للربط.
3. عدّادات محدَّثة بالقياس الفعلي: **41 نموذج Prisma** (المراجعة قالت 37 — الجديد المؤكد: `OmsConnection` + `RateLimitEntry`) · **71 ملف `route.ts`** (المراجعة قالت ~50) · **31 ملف اختبار** (مطابق).

### B1 — المؤكد

- محدد السرعة على قاعدة البيانات (`core/api/rate-limit.ts` + نموذج `RateLimitEntry`) موجود مع fallback للذاكرة؛ مسار الـ fallback مُغطّى باختبار ناجح (`api-handler.test.ts` — سقط الاتصال الموجَّه عمدًا إلى fallback). مسار الـ DB الحقيقي **غير متحقق** (لا ترحيلات مطبَّقة).
- CI (`.github/`): غير موجود — NOT_STARTED (مؤكد).
- تقسيم `orchestrator.ts` (924 سطرًا مقاسًا) و`conversations/service.ts` (847 سطرًا مقاسًا): لم يبدأ — NOT_STARTED (مؤكد).
- سكربتات `scripts/staging/` موجودة لكن لم تُشغَّل على بنية حقيقية — BLOCKED (بنية/اعتمادات).

### B2 — المؤكد

- `modules/oms/`: `client.ts` (نطاق قراءة+إنشاء فقط + `verifyOmsWebhookSignature`) · `sync.ts` (مزامنة تحفظ حقول البيع المحلية + قائمة سوداء + اتصال مشفَّر بـ `encryptSecret`) · `handoff.ts` (ترحيل بطبقتي عدم تكرار) · `webhook.ts` (مرآة حالة عبر آلة الحالات + حدث باص للمتابعات) — كلها CODE_COMPLETE ومغطاة بـ `tests/oms-integration.test.ts` (ناجح ضمن الـ 446).
- المسارات: `POST /api/oms/connection` (settings.manage) · `POST /api/oms/sync` (products.write) · `POST /api/oms/handoff` (orders.write) · `POST /api/webhooks/oms` (عام، HMAC بـ `x-oms-signature`) — موجودة ومطابقة للعقد.
- الترحيل `20261006000000_system7_oms_integration/migration.sql` موجود لكن **غير مطبَّق على أي قاعدة** — لا OMS حي ولا اتصال مختبَر. الإثبات الحي: BLOCKED.

### خريطة التنفيذ (مختصرة — الدليل الكامل أعلاه)

| الميزة | الحالة | الدليل |
|---|---|---|
| Auth + RBAC (37 صلاحية/7 أدوار) + عزل workspace | VERIFIED_LOCAL | `rbac/permissions.ts` (37 سطر صلاحية مقاسًا) + `rbac.test.ts` + `phase9-security.test.ts` ضمن 446 ✅ |
| Inbox + takeover/release + حذف ناعم | VERIFIED_LOCAL | `inbox-conversations` + `ai-mode-persona` (×100 HUMAN_ACTIVE) ✅ |
| Messenger (OAuth/HMAC/24h/إرسال idempotent) | CODE_COMPLETE | `channels/facebook/*` + `phase6-facebook` ✅؛ الإثبات على Meta الحقيقي BLOCKED |
| AI (orchestrator/providers/router/prompts/guardrails/memory) | VERIFIED_LOCAL | `phase4-ai` (29) + `master-reliability` ✅؛ التقسيم NOT_STARTED |
| RAG + pgvector | CODE_COMPLETE | `phase3-knowledge` + `knowledge-e2e` ✅؛ مسار `PgVectorStore` الحقيقي NOT VERIFIED |
| Orders/drafts/rules/state-machine | VERIFIED_LOCAL | `phase5-orders` (30) ✅ |
| Automation/follow-ups/handoffs | VERIFIED_LOCAL | `phase7-automation` ✅ |
| Analytics/usage/observability | VERIFIED_LOCAL | `phase8-analytics` ✅ |
| Media/storage/روابط موقعة | VERIFIED_LOCAL | `media-e2e` + `media-public-url` ✅ |
| Playground معزول | VERIFIED_LOCAL | `playground-isolation` (12) ✅ |
| Rate limiter على DB | CODE_COMPLETE | كود + اختبار fallback ✅؛ مسار DB الحقيقي غير متحقق |
| ChannelAdapter موحد | IN_PROGRESS | واجهة فقط؛ ماسنجر خارجها |
| OMS foundation | CODE_COMPLETE | كود + مسارات + ترحيل + اختبارات ✅؛ بلا DB مهاجَر ولا OMS حي |
| تقنيع PII قبل الموديل الخارجي | IN_PROGRESS | أداة CODE_COMPLETE؛ الربط في provider NOT_STARTED |
| ترحيلات محلية (0/7) | BLOCKED | `migrate status` — يحتاج قرار: `migrate dev` على قاعدة التطوير |
| CI | NOT_STARTED | لا `.github/` |
| Staging/Meta-prod/pgvector حقيقي/worker طويل/E2E/حمل/backup | BLOCKED/NOT VERIFIED | تحتاج بنية + حسابات خارجية (قائمة SECURITY-AUDIT) |

### قرار P0

**جاهز للانتقال إلى P1** — الفحص مكتمل والأدلة مثبتة أعلاه. شروط P1 المقترحة (بالترتيب): (1) قرار ترحيل قاعدة التطوير المحلية؛ (2) CI؛ (3) ربط التقنيع داخل `provider.ts` مع بوابة fail-closed؛ (4) تقسيم orchestrator/conversations بلا تغيير سلوك؛ (5) إقلاع staging حسب `COOLIFY-STAGING.md`. الممنوعات الخارجية (Meta حقيقي/OMS حي/pgvector إنتاجي) تبقى BLOCKED لحين توفرها — لا تعيق بدء P1.

---

## P1 — التحصين الأمني والموثوقية (10 تشرين الأول 2026)

> الأساس المحافَظ عليه: الفرع `main` من `fd59fc6`. كل البوابات أدناه شُغّلت فعليًا ونتائجها مثبتة — لا ادعاءات.

### نتائج البوابات النهائية (P1)

| الفحص | النتيجة |
|---|---|
| `npm test` | **476/476 ناجحة — 35 ملفًا** ✅ (446 أصلية + 12 خصوصية + 7 محدد سرعة + 8 سجل قنوات + 3 pgvector) |
| `npm run typecheck` | نظيف ✅ |
| `npm run lint` | بلا تحذيرات/أخطاء ✅ |
| `npm run scan:secrets` | نظيف ✅ |
| `npm run build` | `Compiled successfully` + 74/74 صفحة ✅ (أُعيد بعد كل التعديلات) |

### 1. تقنيع PII مربوط فعليًا (الأولوية الأمنية) — VERIFIED_LOCAL

- **الجديد:** `src/modules/ai/privacy-gate.ts` — بوابة مركزية عند حد الاتصال بالنموذج الخارجي: رموز `[PII-N]` لكل استدعاء مع خزينة ذاكرة محلية فقط (لا سجلات/لا تخزين/لا مشاركة بين المحادثات)، استعادة محلية من القيم الموثوقة، حجب الأرقام المخترَعة، توجيه خصوصية، ورفض fail-closed (`PrivacyError` غير قابل لإعادة المحاولة) عند: مزوّد مجهول التسليم، فشل التقنيع، أو تجاوز سقف الخزينة.
- **الربط:** المنسّق (استخراج + رد + إعادة) · الملعب (نص + استخراج) · ملخصات الـ worker · التضمين الخارجي (`scrubForEmbedding` داخل `OpenAIEmbeddingProvider` — متسق فهرسةً واستعلامًا). التمييز خارجي/داخلي/محلي عبر `delivery` مصرّح به إنشائيًا — لا تخمين بالاسم.
- **`delivery` أُضيفت لواجهة `AIProvider`** (إضافة فقط): خارجي افتراضيًا، محلي للـ mock.
- **الحراسة:** قاعدة `UNVERIFIED_CONTACT` (لطيفة: تُفعَّل فقط مع `trustedContacts`؛ السلوك القديم محفوظ بدونه) + تطبيع الأرقام الفارسية.
- **الاختبارات:** `tests/p1-privacy-gate.test.ts` (12: A–H عبر مسار provider حقيقي بمزوّد خارجي مسجِّل، بما فيه تشغيل المنسّق الكامل).
- **عربي محفوظ:** الأرقام العربية/الفارسية تُكتشف وتُعاد مطابقة للبايت؛ الأسعار/الكميات (رقم ≤8 بلا شكل هاتفي) لا تُمس. المتبقي الموثّق: رقم هاتفي 7–8 أرقام بلا بادئة/فواصل لا يُرمَّز (نادر، مسجَّل كخطر متبقٍّ).

### 2. قاعدة البيانات والترحيلات — VERIFIED_LOCAL

- **التشخيص (قراءة فقط أولًا):** `ai_commerce@localhost:5432` بمستخدم `aiapp` المخصص (ليست قاعدة Odoo) — **فارغة تمامًا** (0 جداول، بلا سجل ترحيلات). الإثبات: استعلام `information_schema` قبل التطبيق.
- **القرار:** قاعدة تطوير مخصصة وآمنة + لا بيانات لنسخها (الفراغ المثبت هو الدليل) → طُبِّق `prisma migrate deploy`: **7/7 ناجحة**، ثم `Database schema is up to date`. اللاحق: 42 جدولًا (41 نموذجًا + `_prisma_migrations`)، `OmsConnection` و`RateLimitEntry` موجودان.
- **المكتشف أثناء الزرع:** `npm run db:seed` كان مكسورًا — `ENCRYPTION_KEY` المحلي يحوي `#` فيقطعه محلل dotenv (<32 حرفًا) و`encryptSecret` كان يخفي السبب. أُصلح السببان: تجديد أسرار `.env` المحلية (hex، والمفاتيح القديمة ميتة — قاعدة فارغة)، + `EncryptionError` يحمل الآن سبب الإعداد الآمن فقط (بادئة `Invalid environment configuration`، بلا أسرار). الزرع يعمل: `Seed complete`.
- **الدخاني المحلي (DB حقيقية):** إقلاع dev على 3100 → `/api/health` ‏(200: `database APP_HEALTHY`, `queue APP_HEALTHY`, `DEGRADED` فقط لغياب Meta) → login بالحساب التجريبي (200) → `/api/conversations` ‏(200 + بيانات) → `/api/knowledge/search` ‏(200 بعد إصلاح pgvector أدناه) → محدد السرعة على DB حقيقية: 10 ناجحة ثم 429ات (مطابق تمامًا للحد 10/دقيقة).
- **الـ worker:** إقلاع + دورات + كاسح يتامى يعمل على DB حقيقية (`worker_started`, `worker_cycle_completed`, `orphaned_inbound_recovered`) — الاستقرار طويل الأمد ما زال NOT VERIFIED.

### 3. إصلاح pgvector الحقيقي (صيد الدخاني) — VERIFIED_LOCAL

- `PgVectorStore.search` كان يرسل `c.workspaceId` بلا اقتباس → ‏`42703 column c.workspaceid does not exist` — مسار pgvector الحقيقي **مكسور** وكل الاختبارات كانت على الذاكرة. الإصلاح: `c."workspaceId"` (سطر واحد) + `tests/p1-pgvector-sql.test.ts` (3) يثبّت SQL المولّد وترتيب `$6/$7`. مثبت حيًا: `/api/knowledge/search` ‏200 على Postgres حقيقية.

### 4. CI — CODE_COMPLETE (التنفيذ الخارجي BLOCKED)

- **الجديد:** `.github/workflows/ci.yml` (موثّق YAML بـ pyyaml): عند PR (فتح/تحديث) والدفع لـ `main` — `npm ci` ثم typecheck + lint + test + scan:secrets + build (وظيفة `verify`)، ووظيفة `migrate-check` تطبق الترحيلات على `pgvector/pgvector:pg16` وتتحقق من الجداول والترحيلات والامتداد. بلا أسرار (dummies شكلية فقط).
- **الدليل المحلي:** كل خطوات `verify` هي نفسها بوابات P1 الخضراء أعلاه؛ و`migrate-check` مطابقة لما نُفّذ محليًا بنجاح (7/7). التشغيل على GitHub Actions نفسها: BLOCKED (يحتاج push/PR).

### 5. Rate Limiter — VERIFIED_LOCAL (التوزيع الحقيقي BLOCKED)

- **أُعيدت كتابته** (`core/api/rate-limit.ts`): جملة upsert ذرية واحدة (قفل الصف يلغي سباق check-then-act ومسار P2002 الخاسر)، `limit` تعني `limit` فعلًا (توحيد off-by-one مع مسار الذاكرة — موثّق)، سياسة فشل صريحة (`memory-fallback` افتراضيًا / `fail-closed` بـ 503 `RATE_LIMIT_STORAGE_DOWN`).
- **التوصيل:** `rateLimitStrict` على login/register فقط (درع brute-force؛ عند تعطل DB هما ميتان أصلًا فلا خسارة توافر). باقي المسارات على سياستها السابقة — لا تغيير صامت.
- **الاختبارات:** `tests/p1-rate-limit.test.ts` (7: حد دقيق، تزامن 20 متوازيًا → 5 ناجحة تمامًا، نافذة، عزل مفاتيح، fallback، fail-closed، طبيعة الذاكرة المؤقتة). المثبت حيًا أعلاه (10 ثم 429).
- **غير المتحقق:** نسختا تطبيق متوازيتان على DB واحدة (يحتاج staging) — موثّق.

### 6. التقسيم بلا تغيير سلوك — VERIFIED_LOCAL

- `conversations/service.ts` (847) → `inbound.ts` (خط الوارد حرفيًا) + `threads.ts` (الباقي حرفيًا) + `service.ts` كـ barrel (كل الاستيرادات القديمة تعمل).
- `orchestrator.ts` (~946) → `stages/{state,gating,extraction,response}.ts` + منسّق نحيف (~110 أسطر، تسلسل فقط). المنطق منقول حرفيًا سطرًا بسطر (نفس الترتيب والآثار الجانبية)؛ `AIExecutionResult`/`OrchestratorDeps` أُعيد تصديرهما للتوافق.
- **الإثبات:** typecheck نظيف + كل حزم المحادثات/AI خضراء (119/119 في 6 ملفات مستهدفة) + الحزمة الكاملة 476/476. التغيير التجميلي الوحيد: فواصل تعليقات ASCII بدل المربعات.

### 7. سجل المحوّلات — CODE_COMPLETE (ترحيل التدفقات مؤجل لـ P5)

- **الحقيقة:** `getChannelAdapter` لم يكن مستدعًى في أي مكان — ماسنجر يعمل خارج السجل كليًا. الترحيل الكامل (webhook/إرسال) مخاطرة سلوكية فوق نطاق P1 → **مؤجل موثّقًا لـ P5**، ونُفّذ ما هو آمن:
- **الجديد:** `facebook/adapter.ts` (`FacebookChannelAdapter` فوق normalizer/existing — الاستقبال من `normalizeFacebookWebhook`، والإرسال عبر sender محقون يملك التوكن؛ الشهادات لا تدخل المحوّل) + `registry.ts` حقيقي (FACEBOOK مربوط، Mock باشتراك صريح فقط، غير المسجَّل ← `ChannelNotSupportedError` بدل mock صامت، وتجاوز للاختبارات مع استعادة).
- **الاختبارات:** `tests/p1-channel-registry.test.ts` (8: حل حقيقي، رفض بلا ربط، رفض غير المسجَّل، mock الصريح، تطبيع دفعة Meta، تجاهل الصفحات الأخرى، إرسال، fail-closed) + حزم فيسبوك القديمة خضراء (37/37 في 3 ملفات).

### 8. الاستعداد التشغيلي (staging) — فحوص محلية + قائمة BLOCKED

- **المنجز محليًا (§8 الآمن):** ترحيل + زرع + إقلاع + health/login/inbox/RAG/محدد/Worker (أعلاه). Docker **غير مثبّت** على هذه الآلة → تحقق الحاويات BLOCKED.
- **قائمة staging (للمالك/المشغّل):** نشر compose على Coolify + env الإنتاج + نطاق/HTTPS + `validate-staging.sh` + `concurrency.mjs` ضد نطاق staging + اختبار Meta بحساب تجاري + `migrate deploy` + `db:seed` + مراقبة `/api/health` (نفس خطوات `COOLIFY-STAGING.md` §13). ممنوعات P1 المحترَمة: لا نشر إنتاج، لا DNS، لا تدوير مفاتيح حقيقية، لا رسائل حقيقية.

### تصحيح مهم لسجل الاختبارات (شفافية)

- أثناء P1 ظهر فشل `phase5-orders` واحد (ثم `facebook-oauth` واحد) **مرتبط بالبيئة لا بالكود**، وثّقته الأدلة: `@prisma/client` يحمّل `.env` عبر dotenv عند أول استيراد (بعد تنفيذ `setup.ts`)، فكان `AI_PROVIDER=openai` بلا مفتاح يقلب اختبارًا، و`META_REDIRECT_URI=` الفارغة تكسر `??`. مثبت أن الكود الأصلي (HEAD نظيف) يفشل identically، وأن الإصلاح (`tests/setup.ts`: استيراد مبكر لـ prisma ثم فرض قيم hermetic ومسح مفاتيح AI/META-override) أعاد **476/476**. الدرس موثّق: نتيجة P0 ‏(446/446) كانت معتمدة على ترتيب تحميل بيئي — الآن الحزمة حتمية.

### خريطة الحالات (P1)

| البند | الحالة | الدليل |
|---|---|---|
| تقنيع PII خارجي شامل | VERIFIED_LOCAL | 12 اختبارًا عبر provider حقيقي + دخاني محلي |
| ترحيلات dev (7/7) + زرع | VERIFIED_LOCAL | `migrate status` + `Seed complete` + 42 جدولًا |
| pgvector حقيقي | VERIFIED_LOCAL | إصلاح + 3 اختبارات + `/api/knowledge/search` ‏200 حيًا |
| CI | CODE_COMPLETE | YAML صالح + خطواته منفَّذة محليًا؛ Actions الخارجي BLOCKED |
| Rate limiter ذري + fail-closed | VERIFIED_LOCAL | 7 اختبارات + إثبات حي (10 ثم 429)؛ التوزيع BLOCKED |
| تقسيم orchestrator/conversations | VERIFIED_LOCAL | 476/476 + typecheck، منطق حرفي |
| سجل Messenger الحقيقي | CODE_COMPLETE | 8 اختبارات؛ ترحيل التدفقات → P5 |
| دخاني محلي (health/login/inbox/worker) | VERIFIED_LOCAL | مخرجات HTTP أعلاه + سجلات worker |
| Meta/OMS حي، staging حاويات، حمل، E2E | BLOCKED | Docker غائب + حسابات خارجية |

### قرار P1

**مكتمل تقنيًا بانتظار مراجعة المالك — لا انتقال لـ P2.** البنود الـ 12 لمعايير القبول محققة أعلاه (10، 11، 12: البوابات الأربع خضراء + scan نظيف + لا أسرار جديدة + كل تغيير قابل للمراجعة عبر `git diff`). المخاطر المتبقية: رقم 7–8 أرقام بلا شكل هاتفي خارج التقنيع؛ fallback الذاكرة أحادي النسخة؛ ترحيل تدفقات Messenger مؤجل لـ P5؛ كل ما يحتاج Docker/حسابات خارجية.

---

## P1.1 — إغلاق ملاحظات الخصوصية ومحوّل Messenger (10 تشرين الأول 2026)

> الأساس: `main` من `fd59fc6` + تغييرات P1 غير المسلّمة. كل البوابات أدناه شُغّلت فعليًا.

### البوابات النهائية

| الفحص | النتيجة |
|---|---|
| `npm test` | **494/494 — 36 ملفًا** ✅ (476 من P1 + 14 صيغ هواتف + 4 تدفقات حية جديدة) |
| `npm run typecheck` | نظيف ✅ |
| `npm run lint` | نظيف ✅ |
| `npm run scan:secrets` | نظيف ✅ |
| `npm run build` | `Compiled successfully` ✅ |

### 1. فجوة صيغ الهواتف — مغلقة (VERIFIED_LOCAL)

- **السياسة الجديدة** (`privacy-gate.ts`): (أ) القيم المعروفة تُرمَّز **بأي تهجئة** — مطابقة رقمية بعد التطبيع (مسافات/شرطات/Indic/بادئة دولة 1–4 أرقام)؛ (ب) الأرقام المجهولة العارية 7–8 تُرمَّز في **سياق هاتفي** (±25 حرفًا، وانحياز آمن عند اجتماع السياقين)؛ (ج) الردود تُحجب بصرامة مع `allowedNumbers` (أسعار/إجماليات من السياق الموثوق)؛ (د) `UNVERIFIED_CONTACT` توحّدت على نفس الكاشف (حُذف المكرر).
- **المتبقي الموثّق صراحة:** رقم مجهول عارٍ 7–8 أرقام **بلا سياق هاتفي ولا تطابق معروف** يُترك (لا يُميَّز عن الأسعار/الإجماليات بثقة) — السياسة والاختبارات المانعة للتسريب في `tests/p1-phone-formats.test.ts` (14: الصيغ الأربع المطلوبة `12345678` · `12 34 56 78` · `+222 12 34 56 78` · `١٢٣٤٥٦٧٨` عبر مسار provider كامل، تمييز السياق، حفظ الأسعار، عزل الجلسات، استخراج حتمي، حراسة).
- **OCR/الصوت:** لا مسار إدخال منهما إلى النماذج حاليًا (generateVision بلا مستدعين — موثّق أدناه)؛ أي مسار مستقبلي يدخل عبر `sendProtected*` نفسها.

### 2. تدقيق استدعاءات AI الخارجية — مكتمل (VERIFIED_LOCAL)

| # | الطبقة/الملف | البيانات | عبر البوابة؟ | الإثبات |
|---|---|---|---|---|
| 1 | `OpenAICompatibleProvider.chat` (الحد الخارجي الوحيد للـ LLM) | system/user/vision | نعم — كل المستدعين عبر `sendProtected*` | p1-privacy (12) + p1-phone (14) |
| 2 | orchestrator استخراج/رد/إعادة | نص العميل + التاريخ + الاسم/الذاكرة/الملخص/المسودة | نعم | D/G في p1-privacy |
| 3 | playground نص/استخراج | مدخلات المشغّل + اسم اختباري | نعم (+allowedNumbers للسعر) | playground-isolation (12) |
| 4 | `handleGenerateSummary` | transcript كامل (20 رسالة) | نعم | مسار مغطى + G |
| 5 | `OpenAIEmbeddingProvider.embed` (فهرسة المقاطع + استعلامات RAG) | نصوص KB + استعلام العميل | نعم (`scrubForEmbedding` داخل `embed`) | p1-privacy + دخاني P1 |
| 6 | `generateVision` | — (لا مستدعين: قدرة خامدة) | N/A — أي تفعيل مستقبلي (R02) يجب أن يمر عبر البوابة لنص الـ prompt؛ بكسلات الصور خطر متبقٍّ موثّق | grep يُظهر صفر مستدعين |
| 7 | `analyze_feedback` | — (قاعدي، بلا AI) | N/A | `feedback/service` |
| 8 | `FacebookClient` (Graph: إرسال/صفحات/توكن) | نقل قناة لا استدلال (نص التسليم للمستلم نفسه) | N/A بحكم التصميم | phase6 + p1-channel |

لا مسار يتجاوز البوابة. لا بيانات حقيقية أُرسلت لأي موفّر أثناء الاختبار (mocks مسجِّلة فقط).

### 3. Messenger Adapter في التدفقات الحية — VERIFIED_LOCAL

- **الاستقبال:** `facebook/webhook.ts` يحل `getChannelAdapter("FACEBOOK", {pageId, channelAccountId})` ويطبّع عبر `receiveNative` (نفس الدالة/الوسائط/المخرجات — مثبت بالتطابق العميق)؛ التحقق HMAC وidempotency والترتيب كما هي.
- **الإرسال:** `dispatchOutbound` (الخطوة 7 فقط) عبر المحوّل بـ sender مربوط (نفس التوكن/المستلم/الحمولات/تصنيف الأخطاء)؛ idempotency والسياسة (24h) والاسترداد كما هي؛ `graphCode` يمر عبر `raw`.
- **الضمانات:** `pageId`/`sender` اختياريا حسب الاتجاه (صفحة بلا externalId لا تُعطَّل إرسالاتها)؛ أي حل غير فيسبوك ← `ChannelNotSupportedError` (لا mock صامت)؛ `ChannelNotSupportedError` انتقل لـ `types.ts` (بلا دورة).
- **الإثبات:** `tests/p1-channel-registry.test.ts` (12): استقبال حي عبر السجل + إرسال حي عبر السجل (SENT بـ `mid` حقيقي من stub) + تطابق المخرجات + رفض الربط الناقص. الحزم القديمة خضراء ضمن 494/494. بلا أي اتصال حقيقي بالعملاء في الاختبارات.

### 4. الملفات (P1.1)

معدلة: `ai/{privacy-gate,guardrails,playground-service}`، `ai/stages/response`، `channels/{types,registry,facebook/{adapter,normalizer,webhook},outbound}`. جديدة: `tests/p1-phone-formats.test.ts` (+4 اختبارات موسّعة في `p1-channel-registry`).

### 5. BLOCKED والمخاطر المتبقية

- Meta/OMS الحي، staging الحاويات، الحمل، E2E، multi-worker/instance: **BLOCKED** (بنية/حسابات) — كما في P1.
- رقم مجهول عارٍ بلا سياق: متروك عمدًا (موثّق + مختبَر) — يُعاد تقييمه مع بيانات إنتاجية حقيقية في P2+.
- بكسلات الصور (R02 مستقبلي) خارج التغطية حتى توثيق سياسة الرؤية.

### قرار P1.1

**مغلق تقنيًا بانتظار مراجعة المالك — لا انتقال لـ P2.**

---

## P2 — تدقيق وإكمال تكامل Zaki OMS (10 تشرين الأول 2026)

> الأساس: `main` من `fd59fc6` + تغييرات P1/P1.1 غير المسلّمة. البوابات: **520/520 (38 ملفًا)** ✅ · typecheck ✅ · lint ✅ · scan ✅ · build ✅. بلا اتصال إنتاجي، بلا طلبات OMS حقيقية، migration واحد إضافي على dev فقط.

### الخطوة الأولى — العقد الحقيقي: ما هو مثبت وما هو مفترض

وثيقة `سيستم_7_التوافق_مع_OMS.md` تنص صراحة أن «الأسماء النهائية بتنضبط وقت البناء» — أي أن المسارات (`GET /oms/products`، `/oms/customer`، `/oms/order/{id}`، `POST /oms/orders`، `/oms/note`، حدث `order-status-changed`) **مؤشَّرة غير مُثبتة** من طرف OMS. لم يُخترع بديل: الكود يعمل ضد `baseUrl` قابل للضبط بنفس المسارات المفترضة، والفجوات سُجّلت كمتطلبات خارجية (BLOCKED): (1) تثبيت المسارات والطرق؛ (2) تأكيد مخطط المصادقة (حاليًا Bearer)؛ (3) مواصفة pagination؛ (4) مخطط الأخطاء؛ (5) `eventId`/`occurredAt` في الـ webhook + سياسة إعادة الإرسال؛ (6) **ضمان عدم التكرار على `idempotencyKey` في `POST /orders`** (يعتمد عليه الترحيل)؛ (7) سياسة تعطيل المنتجات؛ (8) حدود المعدل. مستودع OMS أو توثيق API الحقيقي: **غير متاح**.

### جدول P2 (الميزة | الحالة | الاختبارات | الأدلة | ما لم يُختبر)

| الميزة | الحالة | الاختبارات | الأدلة | ما لم يُختبر |
|---|---|---|---|---|
| عميل OMS (مهلة 15s + retry مصنّف GET/غامض-POST فقط) | VERIFIED_LOCAL | `p2-oms-hardening` (retry ×3، no-retry على 400، timeout، سطح القراءة فقط) | `client.ts` + عدّادات fetch في الاختبارات | سلوك OMS الحقيقي (BLOCKED) |
| مزامنة المنتجات (تحقق/عزل/تعطيل بلا حذف/طوابع) | VERIFIED_LOCAL | نجاح + صفوف فاسدة + فارغ بلا تعطيل + ضخم مرفوض + حقول بيع محفوظة | `sync.ts` + `POST /api/oms/sync` (مثبت حيًا سابقًا) | pagination (بلا مواصفة — BLOCKED) |
| العملاء والقائمة السوداء (سياسة عدم رفع الحظر اليدوي) | VERIFIED_LOCAL | حظر/رفع/يدوي-محفوظ/مجهول-مُتخطى | `sync.ts` + إنفاذ أدناه | مطابقة الهوية خارج الرقم (العقد صامت) |
| إنفاذ الحظر عند الإنشاء والترحيل (`ORDER_CUSTOMER_BLACKLISTED` + تدقيق) | VERIFIED_LOCAL | رفض الإنشاء (0 طلبات) + رفض الترحيل (0 POSTs) | `order-service.ts` + `handoff.ts` | — |
| ترحيل الطلبات (شروط + مفتاح مكرر + إعادة الغامض) | VERIFIED_LOCAL | ×100 متسلسل (POST واحد) · متوازٍ ×20 (نفس المفتاح) · timeout-ثم-نجاح · رفض غير المؤكد (موجود) · عزل شركات | `handoff.ts` + الحمولة تتضمن السعر/العناصر/adSource | ضمان OMS للمفتاح (BLOCKED خارجي) |
| AI لا ينشئ طلبات مباشرة | VERIFIED_LOCAL (بالبناء) | `handoffOrderToOms` مستدعى من المسار فقط (grep) + `OrderService` حصرية الإنشاء + phase5 | الكود + الاختبارات القائمة | — |
| webhook (مشتق workspace + HMAC + dedupe + ترتيب) | VERIFIED_LOCAL | توقيع صح/خطأ/غائب · مجهول 404 بلا آثار · تعارض workspace · replay مرة واحدة · stale لا يرجع · مجهول/قفزة غير صالحة مرآة فقط | `webhook.ts` + `webhooks/oms/route.ts` + 9 اختبارات مسارات | أحداث OMS حقيقية (BLOCKED) |
| ترحيل `p2_oms_status_at` (`omsStatusAt` nullable) | VERIFIED_LOCAL | `migrate deploy` ناجح + CI يتحقق | `prisma/migrations/20261010080059_p2_oms_status_at/` (يتضمن إصلاح drift آمنًا: FK/index أُعيدا بلا فقد) | إنتاج (ممنوع دون إذن) |
| تشفير التوكن + HMAC + صلاحيات (settings.manage/products.write/orders.write مثبتة) | VERIFIED_LOCAL | تشفير ذهاب/عودة عبر المسار (بلا نص خام) + 3 اختبارات تثبيت صلاحيات + سطح العميل (قراءة/إنشاء/ملاحظة فقط) | `sync.ts`/`client.ts`/المسارات | مفاتيح إنتاج (ممنوعة) |
| خصوصية المزامنة (بلا AI في المسار) | VERIFIED_LOCAL | فحص استدعاءات: المزامنة/الترحيل/الwebhook بلا أي generate* | grep + البوابة P1 | — |

### قرار P2

**مغلق محليًا بانتظار أمرين خارجيين: (1) تثبيت العقد/الاتصال مع فريق OMS (القائمة أعلاه)؛ (2) مراجعة المالك. لا PRODUCTION_VERIFIED لأي بند OMS. لا انتقال لـ P3.** ملاحظة الأرقام غير المقنّعة من P1/P1.1 تبقى في المخاطر (تغطية P1.1 قائمة؛ المجهول العاري بلا سياق متروك عمدًا).

---

## P3 — المؤسسات والمستخدمون والفرق والصلاحيات (10 تشرين الأول 2026)

> الأساس: `main` من `fd59fc6` + تغييرات P0–P2 غير المسلّمة. البوابات: **536/536 (40 ملفًا)** ✅ · typecheck ✅ · lint ✅ · scan ✅ · build (يتضمن `/settings/team`) ✅. بلا OMS، بلا إنتاج.

### الموجود أصلًا (احتُفظ به كاملًا)

- نماذج `User`/`Workspace`/`WorkspaceMember` (7 أدوار، 37 صلاحية، حالات ACTIVE/INVITED/SUSPENDED، تجاوزات `permissions[]`) + مصفوفة RBAC + صلاحيات طازجة كل طلب.
- جلسات JWT (7 أيام، HttpOnly) + `getAuthContext` يرفض غير ACTIVE (إبطال فوري عند التعليق — كان موجودًا وغير مختبَر، الآن مختبر).
- إنشاء/سرد/تبديل مساحات العمل (التبديل يتحقق من العضوية النشطة) + تسجيل/دخول/خروج.
- فرض الصلاحيات خادميًا (`createHandler` + صفحات `enforcePermission` + شريط جانبي مُرشَّح).

### المضاف/المُصلح (فجوات حقيقية فقط)

- **الدعوات:** `INVITED`/`expiresAt` (ترحيل `p3_member_invite_expiry`، dev فقط) — دعوة موجودين بالبريد (7 أيام، تجديد، رفض المجهول/المكرر/الموقوف)، قبول ذاتي بالجلسة (بلا توكنات) مع رفض المنتهية (410)، بلا جداول جديدة.
- **الإدارة:** `src/modules/members/service.ts` (محقون DB، مدقق، مسجَّل تدقيقيًا) + 5 مسارات (`GET/POST /members`، `POST /members/accept`، `PATCH/DELETE /members/[id]`، `PUT /workspaces`) + تحديث اسم/منطقة (`workspace.manage`، الهدف من الجلسة — يستحيل التلاعب).
- **الحواجز:** لا تعديل ذاتي (403)، لا `SUPER_ADMIN` عبر API، لا صلاحيات مجهولة، أرضية مالك واحد نشط (ترقية/تعليق/إزالة)، العضوية الموقوفة = حظر فوري.
- **الواجهة:** `/settings/team` (بوابة `users.manage` خادمية) + مكوّن الفريق (قائمة/دعوة/دور/إيقاف/إزالة/إعادة تسمية) + عنصر nav (`users.manage`) + بطاقة إعدادات + مفتاح i18n — نفس التصميم وRTL، بلا إعادة تصميم. صفحة الإعدادات كانت تعد بالفريق «في المراحل القادمة» — أُنجزت.
- **القاعدة الوهمية:** نموذج `workspace` أُضيف للمضاعفة (إضافي، لا يمس الاختبارات القائمة).

### اختبارات الأمان الستة (كلها خضراء)

1. عزل الشركات (قوائم/عمليات مقيدة + خاصية الجلسة فقط) — `p3-members` + `p3-authz`.
2. لا تصعيد ذاتي (دور/صلاحيات/إزالة الذات + حظر SUPER_ADMIN) — `p3-members`.
3. الموقوف محظور فورًا (سياق حقيقي + مسار HTTP حقيقي) — `p3-authz`.
4. التلاعب بـ workspaceId مرفوض (جلسة بلا عضوية + PUT بلا مدخل) — `p3-authz` + `p3-members`.
5. كل عملية إدارية في AuditLog (دعوة/قبول/تعديل/إزالة/مساحة) — `p3-members`.
6. أجسام 403 بلا بريد/أسرار — `p3-authz`.

### الحالات والمتبقي

| البند | الحالة |
|---|---|
| نماذج/مصفوفة/جلسات/مسارات موجودة | VERIFIED_LOCAL (محفوظة + مغطاة) |
| دعوات/فريق/تحديث مساحة + واجهة | VERIFIED_LOCAL (16 اختبارًا جديدًا) |
| ترحيل `expiresAt` | VERIFIED_LOCAL (dev فقط) |
| تعدد الجلسات/تدويرها، حذف مساحة، SSO/2FA، E2E متصفح | BLOCKED/not-started (يحتاج staging/قرارات لاحقة) |

### قرار P3

**مغلق تقنيًا بانتظار مراجعة المالك — لا انتقال لاحق.** ملاحظة P2 (العقد الخارجي) والأرقام العارية بلا سياق تبقيان في المخاطر.

---

## P4 — صندوق الوارد الاحترافي وContact 360 (10 تشرين الأول 2026)

> الأساس: `main` من `fd59fc6` + تغييرات P0–P3 غير المسلّمة. البوابات: **551/551 (41 ملفًا)** ✅ · typecheck ✅ · lint ✅ · scan ✅ · build (يتضمن `/api/.../notes`) ✅. بلا Meta/OMS حقيقي، بلا إنتاج.

### تحقق P3 المركز (قبل تعديل P4)

- قبول الدعوة الصحيح ومنع قبول حساب آخر: مغطى أصلًا ومؤكد.
- **سباق المالك الأخير: وُجد وثُبت.** الفحص المتزامن كان نظريًا فقط؛ أُضيف تحقق لاحق مع تعويض (استعادة الصف عند كسر الأرضية) في `updateMember`/`removeMember` + اختبار تزامني يثبت الثابت تحت كل interleaving (≥1 مالك نشط دائمًا، وكل رفض هو `OWNER_REQUIRED`).

### الموجود أصلًا (محفوظ)

القائمة/البحث/الفلاتر الأساسية/pagination/السلاسل الزمنية/الرد المتفائل + idempotency/التعليم كمقروء/الحل/takeover/release/الحذف الناعم/شارات AI-HUMAN/المعيَّن/الشخصية/لوحة العميل (هوية/طلبات/مسودة/ملخص/جدول زمني)/إعادة المحاولة/السياسات — كلها بقيت دون مساس.

### المضاف (فجوات حقيقية فقط)

- **فلاتر خادمية:** `priority`/`assignee(me/none/cuid)`/`channelType`/`dateFrom-dateTo` في `listConversations` + المخطط + المسار + صف فلاتر بالواجهة (التبويبات القديمة بقيت عميلة).
- **الملاحظات الداخلية:** `Message.isNote` (ترحيل dev) + `postNote` + `POST notes` (صلاحية `conversations.reply`) — صف HUMAN/INBOUND معلَّم، مستبعد من: المرسِل (لا يقرأ إلا صفوفه)، الاسترداد/إعادة المحاولة (OUTBOUND + مفتاح فقط)، سجل AI، أحجام التحليلات، معاينات القوائم. تدقيق `note.created`. واجهة: لسان رد/ملاحظة + فقاعة كهرمانية بلا tick/إعادة.
- **Contact 360:** بريد + شارة قائمة سوداء + `adSource` للطلبات (خدمة + لوحة).
- **التفاصيل:** `openHandoff` (بانر السبب) + `assignmentHistory` (آخر 10 مدققة مع أسماء) — استعلامان محدودان، بلا N+1 جديدة.
- **سباق حقيقي مُصلح:** إنشاء المحادثة المتزامن كان يرمي 500 (بلا P2002) — الآن يعيد القراءة ويلتحق (مطابق نمط الهوية) + إنفاذ التفرد في المضاعفة.

### الاختبارات (14 جديدة، `tests/p4-inbox.test.ts`)

فلاتر/ترتيب/pagination/كرسور فاسد/فراغ؛ ملاحظات (إنشاء/ظهور/لا-إرسال/استبعاد AI/فصل الأنواع)؛ 360 (علاقات + 404 عابر)؛ إسناد + تدقيق + بانر + نشاط؛ إخفاء/إعادة فتح؛ عزل الشركات الأربع؛ تثبيت صلاحيات المسارات؛ هوية متزامنة (محادثة + رسالة واحدتان)؛ كلها خضراء ضمن 551/551.

### الحالات والمتبقي

| البند | الحالة |
|---|---|
| الوارد والفلاتر والملاحظات و360 والهوية | VERIFIED_LOCAL |
| ترحيلا `isNote` | VERIFIED_LOCAL (dev فقط) |
| E2E متصفح للواجهة الجديدة، Meta حي، staging | BLOCKED |
| قنوات جديدة، دمج عملاء، حذف ملاحظات، أرشفة | مؤجل موثّق (خارج P4) |

### قرار P4

**مغلق تقنيًا بانتظار مراجعة المالك — لا انتقال لـ P5.** لا جاهزية إنتاجية مُعلنة.

---

## P5 — القنوات المتعددة عبر واجهات API الرسمية (10 تشرين الأول 2026)

> الأساس: `main` من `fd59fc6` + تغييرات P0–P4 غير المسلّمة. البوابات: **598/598 (45 ملفًا)** ✅ · typecheck ✅ · lint ✅ · scan ✅ · build (كل مسارات القنوات الجديدة) ✅. بلا حسابات خارجية، بلا رسائل حقيقية، ترحيلان dev فقط.

### البوابة قبل التوسعة: قناة `auto` المتزامنة — محلولة ومختبرة

- **المقصود:** `ensureChannelId` تنشئ صف `TYPE (auto)` عند غياب `channelId` في webhook.
- **الحالة:** تزامن أول-تواصل مزدوج → صفّان مكرران (القيد `@@unique(workspaceId,type,externalId)` لا يطلق على NULL) → تشتت التوجيه/الشارات، بلا فقدان رسائل (هوية المحادثة مستقلة).
- **الإصلاح:** فهرس فريد جزئي `(workspaceId,type) WHERE externalId IS NULL` (ترحيل، مطبق dev بعد إثبات صفر تكرار) + التقاط P2002 وإعادة القراءة + إنفاذ مماثل في المضاعفة + اختبار تزامني (8 متوازية → صف واحد).

### العقد المشترك

- `CHANNEL_CAPABILITIES` الصريحة لكل نوع + `ChannelFeatureError` (501، لا تقليد) + `ChannelTransport` + سياسات `canSend*` لكل مزوّد + مهمة `process_channel_inbound` المشتركة (نفس عقد الدفعة الفيسبوكي) + `Channel.identity` لكل نوع (PSID/IGSID/wa_id/chat-id/open_id — استحالة الخلط بنيويًا).
- `dispatchOutbound`: مسار Messenger **حرفي** (85/85 حزم فيسبوك خضراء) + فرع `dispatchChannelSend` للقنوات الجديدة بنفس القشرة (idempotency/استرداد/جزء أول/استخدام).

### لكل قناة

| القناة | الموجود | المضاف | الحالة |
|---|---|---|---|
| Messenger | تكامل حي كامل | متحقق بلا تغيير (85/85) | VERIFIED_LOCAL (الحي BLOCKED) |
| FB Comments | — | استقبال feed (تخزين مُكرر-آمن، بلا رد تلقائي) + رد عام/خاص(مرة/7أيام)/إخفاء + 6 مسارات | VERIFIED_LOCAL (الحي BLOCKED) |
| Instagram | — | عميل/تطبيع/HMAC/سياسة 24h (تحفظ موثّق)/محوّل/webhook/تعليقات/ربط | VERIFIED_LOCAL (اعتماد Meta BLOCKED) |
| Telegram | — | عميل Bot API/سرّ header/سياسة بلا نافذة/محوّل/webhook/ربط (getMe + secret + setWebhook) | VERIFIED_LOCAL (حساب حقيقي BLOCKED) |
| WhatsApp | — | عميل Cloud/تطبيع wa_id/HMAC/سياسة 24h+قوالب/محوّل/webhook/ربط | VERIFIED_LOCAL (رقم تجاري BLOCKED) |
| TikTok | — | شكل محلي فقط (تطبيع/سياسة/محوّل نصي/رفض وسائط صريح)/الربط مرفوض سببيًا | CODE_COMPLETE (الوصول BLOCKED) |

### الأمان والإدارة والواجهة

- أسرار مشفرة، لا إرجاع/تسجيل، إثبات ملكية الحساب (صراع عبر المساحات مرفوض)، فصل آمن (السياسات توقف الإرسال)، تحقق لكل مزوّد بشكله الرسمي، WebhookEvent لكل حدث، عزل كامل، AI لا يرى الاعتمادات.
- `POST/DELETE /api/channels/[type]` (تحقق حي قبل التخزين) + `GET /api/channels` (بلا أسرار) + قسم واجهة (نماذج IG/WA/TG، حالات، فصل، TikTok إرشادي) — Messenger القديمة untouched.
- الاختبارات: 47 جديدة (عقد/بوابة auto/webhooks/إرسال/تعليقات/ربط/عزل/ملاحظات) + كل القديمة خضراء. لا Mock صامت (مثبت)، لا رسائل حقيقية.

### قرار P5

**مغلق تقنيًا بانتظار مراجعة المالك — لا انتقال لـ P6.** كل اتصال حي واعتماد خارجي: **BLOCKED** (Meta/Telegram/WhatsApp/TikTok). لا PRODUCTION_VERIFIED لأي قناة جديدة.

---

## P6 — استوديو الذكاء الاصطناعي والوكلاء وقاعدة المعرفة (10 تشرين الأول 2026)

> الأساس: `main` من `fd59fc6` + تغييرات P0–P5 غير المسلّمة. البوابات: **632/632 (46 ملفًا)** ✅ · typecheck ✅ · lint ✅ · scan:secrets ✅ · build (`Compiled successfully` + 91/91 صفحة، كانت 74) ✅. ترحيل واحد إضافي مطبق على dev فقط (`p6_ai_studio`). بلا اتصال إنتاجي، بلا مفاتيح حقيقية، بلا رسائل حقيقية.

### الفحص قبل التنفيذ — الموجود مقابل الناقص (مثبت بالكود)

| الوحدة | الموجود (احتُفظ به) | الناقص (نُفّذ في P6) |
|---|---|---|
| Provider Registry/Model Router | `resolveModel` لكل مهمة + `estimateCost` null-safe + `logUsage` + `withRetry` + `delivery` | اختيار `AISettings.provider` كان **شكليًا** (الواجهة تعرضه و`getAIProvider` يقرأ ENV فقط) → أصبح فعّالًا عبر `getWorkspaceProvider` (أولوية: حقن الاختبار > اختيار حقيقي للمساحة > ENV > fail-closed)؛ مهام `EMBEDDING`/`RETRIEVAL`؛ `validateTaskModel`؛ بديل صريح `fallbackModel`؛ `customBaseUrl` داخلي (`delivery: internal`)؛ اختبار اتصال PII-free |
| Personas | CRUD + ربط القناة (`aiPersonaId`) + أولوية قناة→مساحة→مدمج + حدود `PERSONA_LIMITS` | **لا إصدارات** → جدول `PersonaVersion` + مسارات مسودة/نشر/رجوع + `Persona.version` + ربط قناة↔شخصية عبر API + تسجيل `personaId/personaVersion` في كل usage |
| Playground | جلسات معزولة + نفس منطق الشخصية + معرفة + debug | مسودات `draftInstructions` و`personaVersionId` (ذاكرة فقط) + اختيار المهمة `task` + `draftUsed/task/version` في debug — العزل محفوظ ومختبر |
| Knowledge/RAG | مستندات/مقاطع/FAQ/بحث/`reindex`/حذف + فلتر هوية التضمين + عزل مساحات | مكتمل أصلًا — أُضيفت اختبارات المسار الحقيقي (استرجاع معلومة معروفة، عزل مساحات، رفض الأجيال غير المتوافقة، FAILED الصريح) |
| Privacy Gate | `sendProtected*` على كل المسارات + `UNVERIFIED_CONTACT` | كل المسارات الجديدة عبر البوابة (مثبت) + إصلاح تسريب: `logUsage` كان يسجل كائن الخطأ الخام (قد يحمل PII) → الآن معرّفات آمنة فقط |
| Monitoring | `AIUsageLog` + تحليلات AI | **خطأ F-004 الحقيقي**: السكيمة كانت `costUsd NOT NULL DEFAULT 0` (الادعاء nullable غير مطبق — `null` كان سيفشل بصمت عبر catch) → الآن `Float?` بلا default؛ حقول `personaId/personaVersion/fallbackUsed/handoffReason` |
| UI | صفحات ai-settings/personas/knowledge/playground/analytics-ai | صفحة `/ai/studio` (حالات: غير مهيأ/مهيأ/يعمل/يعمل محليًا/فشل/يحتاج مفتاح/متوقف/منشور) + حقول endpoint/بديل + إصدارات في Personas + مهمة/مسودة في Playground |

### الملفات والمخططات

- **ترحيل** `20261010095845_p6_ai_studio` (dev فقط): `AISettings.customBaseUrl/fallbackProvider/fallbackModel` + `Persona.version` + جدول `PersonaVersion` + `AIUsageLog.personaId/personaVersion/fallbackUsed/handoffReason` + `costUsd` nullable.
- **جديدة**: `ai/persona-versions.ts` · `api/ai/status/route.ts` · `api/ai/providers/test/route.ts` · `api/personas/[id]/versions/route.ts` · `.../[version]/publish` · `.../[version]/rollback` · `api/channels/by-id/[id]/persona/route.ts` · `(dashboard)/ai/studio/page.tsx` · `tests/p6-ai-studio.test.ts` (34).
- **معدلة**: `ai/{router,provider,channel-persona,playground-service}` · `ai/stages/{gating,extraction,response,state}` · `api/{ai/settings,ai/playground/.../messages}` · `channels/connect` (عرض `aiPersonaId`) · `(dashboard)/{nav-items,settings/ai,personas,ai/playground}` · `app-sidebar` (أيقونة) · `tests/helpers/inmemory-db` · `analytics/service` (بلا تغيير — كانت null-safe أصلًا).

### الاختبارات (34 جديدة، `tests/p6-ai-studio.test.ts`)

التوجيه لكل مهمة (.override/ENV/افتراضي) · التوافق (تضمين≠رد≠رؤية) · فعالية اختيار المزود + fail-closed + حقن الاختبار + internal مستقل · البديل (عند الفشل فقط، بلا بديل→فشل صريح، الدائم لا يلمس البديل) · خط الأنابيب: فشل أولي+بديل→RESPONDED بالنموذج البديل والبوابة سليمة على المحاولتين · مسودة/نشر/رجوع/عزل إصدارات · أولوية القناة + version · usage يحمل persona/fallback · مسودات Playground بلا مساس بالحي + مهمة SUMMARY تستخدم نموذجها + رفض الأجنبي · RAG حقيقي (استرجاع معلومة، عزل مساحات، رفض الأجيال، حذف وتنظيف، FAILED الصريح) · فحص PII-free + مفاتيح خارج النتائج · تكلفة null/حقيقية + فشل السجل لا يكسر النجاح · تثبيت صلاحيات كل مسارات P6 · انحدار Messenger أخضر.

### أدلة التنفيذ الفعلي

- **إعدادات النماذج**: `getWorkspaceProvider` مستدعى في `runGating` و`sendPlaygroundMessage` (ليس عرضًا) — مثبت باختبار خط الأنابيب (النموذج البديل هو ما ولّد الرد وسُجل).
- **عزل Playground**: لقطة 9 جداول إنتاج قبل/بعد متطابقة + رفض `deleteFacebook`/إرسال حقيقي سابقًا + مسودات لا تكتب `Persona` (مثبت بالنص الحي قبل/بعد).
- **RAG حقيقي**: `createKnowledgeDocument → runJobs → searchKnowledge` بمضمّن Hash ومخزن InMemory عبر نفس دوال الإنتاج، والضرب المتقاطع للمساحات يعيد صفرًا للمصدر الأجنبي.
- **Privacy Gate**: كل `sendProtected*` (استخراج/رد/إعادة/ملعب/اقتراح/تضمين) + فحص PII على مدخلات البديل المسجلة + `probeProviderEndpoint` يرسل `ping` فقط.

### الحالات

| البند | الحالة |
|---|---|
| كل بنود P6 محليًا | VERIFIED_LOCAL (632/632 + 4 بوابات) |
| ترحيل `p6_ai_studio` على dev | VERIFIED_LOCAL (مطبق + مولّد العميل) |
| اتصال OpenAI/OpenRouter/داخلي حي | BLOCKED (يحتاج مفاتيح/endpoint من المالك — زر "اختبار الاتصال" جاهز في الاستوديو) |
| Meta/OMS/staging/E2E | BLOCKED (كما في P5، بلا تغيير) |

### قرار P6

**مغلق تقنيًا بانتظار مراجعة المالك — لا انتقال لـ P7.** ملاحظة الأرقام العارية بلا سياق (P1.1) والعقد الخارجي (P2) تبقيان في المخاطر.

## P7 — محرك الأتمتة وسير العمل والمتابعات (10 تشرين الأول 2026)

> الأساس: `main` على `2d76689` (P1–P6 مرفوعة). البوابات: **657/657 (47 ملفًا — الأساس 632 + 25 لـ P7)** ✅ · typecheck ✅ · lint ✅ · scan:secrets ✅ · build ✅ (91/91 صفحة + مسارات `/api/workflows*` وصفحة `/workflows`). ترحيل واحد مطبق على dev فقط (`20261010104800_p7_workflows`). **لم يُرفع إلى GitHub** (بحسب التعليمات). بلا اتصال إنتاجي، بلا رسائل حقيقية.

### الموجود مقابل الناقص (مثبت بالكود)

| الوحدة | الموجود (احتُفظ به) | الناقص (نُفّذ في P7) |
|---|---|---|
| محرك الأتمتة القديم (`automation/engine.ts`) | قاعدة واحدة تُقيَّم مباشرة عند الحدث، بلا تنفيذ قابل للاستئناف | سير عمل متعدد الخطوات: مؤشر تنفيذ دائم (stepIndex + stepLog)، تنفيذ مرة واحدة بالضبط، WAIT قابل للاستئناف، لقطة مجمدة للإصدار |
| المخطط | `Automation` + `AutomationExecution` أساسي | `Automation.status/version/versionId/publishedBy/publishedAt` + جدول `AutomationVersion` (لقطة مجمدة، فريد automationId+version) + `WAITING/CANCELLED` + `stepLog/stepIndex/attempts/errorCategory` + فريد `(automationId, triggerEventId)` |
| الأمان | — | مخطط Zod صارم (`.strict()`) بمجموعة مغلقة من المشغّلات/الشروط/الإجراءات — بلا كود مخزَّن، بلا eval؛ حراسة SSRF لـ `customBaseUrl` |
| الواجهة | صفحة `/automation` (قواعد بسيطة) | صفحة `/workflows` (بناء مشغّل + شروط + خطوات مرتبة، محاكاة، نشر/إيقاف، سجل تنفيذات) |

### البنية والملفات

- **ترحيل** `20261010104800_p7_workflows` (dev فقط): كما في الجدول أعلاه.
- **جديدة**: `automation/workflow-schemas.ts` (المجموعة المغلقة + تصنيف الأخطاء) · `automation/workflow-conditions.ts` (مقيِّم شروط مع أسباب آمنة) · `automation/workflow-engine.ts` (تشغيل/استئناف التنفيذ + بناء سياق مملوك + خرائط الأحداث) · `automation/workflow-bridge.ts` (جسر دائم EventBus→طابور `run_workflow_event` مع `idempotencyKey: wf-event:{ws}:{eventId}` ومنع الاستدارة) · `automation/workflow-service.ts` (نشر/إيقاف/رجوع append-only) · `ai/endpoint-guard.ts` (SSRF) · `api/workflows/route.ts` · `api/workflows/[id]/route.ts` · `api/workflows/[id]/preview/route.ts` · `(dashboard)/workflows/page.tsx` · `tests/p7-workflows.test.ts` (25).
- **معدلة**: `prisma/schema.prisma` · `core/events/bus.ts` (+`eventId` حتمي) · `conversations/inbound.ts` (يضبط `payload.eventId = MessageReceived:{id}`) · `jobs/{service,handlers}.ts` (مهمتا `run_workflow_event` و`resume_workflow_executions`) · `scripts/worker.ts` (تسجيل الجسر) · `automation/{engine.ts (إصلاح أسبقية depth),followup-service.ts (+cancelFollowUpsFor)}` · `api/ai/{settings,providers/test}/route.ts` (حراسة SSRF على الحفظ والفحص) · `tests/helpers/inmemory-db.ts` (تطبيق قيود فريدة حقيقية P2002 + جدول automationVersion) · `tests/p5-sends.test.ts` (هاتف فريد لكل قناة — كان يخالف قيد `(workspaceId, phone)` الحقيقي) · `app-sidebar` + `nav-items.ts`.

### الضمانات المثبتة (اختبارات)

- **تنفيذ مرة واحدة بالضبط**: نفس الحدث ×100 → صف تنفيذ واحد؛ تزامن ×12 → صف واحد.
- **إعادة الفلترة قبل الإرسال**: HUMAN_ACTIVE / محادثة RESOLVED|CLOSED / قناة غير موصولة / عميل محظور — لا صف رسالة OUTBOUND يُنشأ أصلًا؛ الفشل الدائم `WORKFLOW_POLICY:` بفئة PERMANENT.
- **اللقطة المجمدة**: تعديل المسودة أثناء تنفيذ WAITING لا يغيّر سلوك الاستئناف (ينفَّذ من `AutomationVersion`).
- **WAIT**: يوقف المؤشر عند الخطوة، `resumeAt` في metadata، إعادة التسليم قبل الموعد متخطاة، وبعد الموعد يستأنف من بعد WAIT بلا إعادة إرسال.
- **المعاينة بلا كتابة**: لقطة `db._stores` متطابقة قبل/بعد + `mode: "PREVIEW"` + لا يلمس OMS إطلاقًا (لا Order/OrderDraft).
- **العزل والأذونات**: أحداث مساحة أجنبية لا تشغل شيئًا (لا صفوف تنفيذ)؛ كل مسارات P6 مثبتة على `automation.read`/`automation.write`.
- **SSRF**: `validateEndpointUrl` المتزامن على كل استخدام + DNS غير متزامن يجب أن يعيد عناوين Global Unicast (loopback/LAN/metadata/صيغ مشوّهة مرفوضة).

### الحالات

| البند | الحالة |
|---|---|
| كل بنود P7 محليًا | VERIFIED_LOCAL (657/657 + 4 بوابات) |
| ترحيل `p7_workflows` على dev | VERIFIED_LOCAL (مطبق + مولّد العميل) |
| تزامن عمال متعددين على Postgres حقيقي | CODE_COMPLETE (الفريد على مستوى القاعدة هو الضمان — التحقق متعدد العمال يحتاج staging: BLOCKED) |
| Push إلى GitHub | BLOCKED بالتعليمات (بانتظار موافقة المالك) |
| Meta/OMS/staging/E2E | BLOCKED (كما في P5/P6، بلا تغيير) |

### قرار P7

**مغلق تقنيًا بانتظار مراجعة المالك — لا انتقال لـ P8.**

## P8 — محرك ذكاء البيع (10 تشرين الأول 2026)

> الأساس: شجرة العمل المحلية فوق P7 (غير مرفوعة). البوابات: **693/693 (48 ملفًا — أساس P7 657 + 36 لـ P8)** ✅ · typecheck ✅ · lint ✅ · scan:secrets ✅ · build ✅ (مسارات `/api/conversations/[id]/coach` و`/api/discount-approvals*` ضمنها). ترحيل واحد مطبق على dev فقط (`20261010*_p8_sales_intelligence`). **لم يُرفع إلى GitHub** (بحسب التعليمات). بلا اتصال OMS حقيقي، بلا رسائل حقيقية.

### الموجود مقابل الناقص (مثبت بالكود)

| الوحدة | الموجود (احتُفظ به) | الناقص (نُفّذ في P8) |
|---|---|---|
| خطة البيع | `buildPlan` حتمي في مرحلة الاستخراج | `salesPlan` منتج أساسي + بيع إضافي (عرض OMS) + بيع مكمّل (complementarySkus ≤ 2) + اعتراض مصنّف — كل الأرقام من DB، مخطط Zod صارم، بلا eval |
| عروض OMS | حقول `offers/wholesalePrice/discountCap` من المزامنة | فك ترميز آمن (الصفوف التالفة/المنتهية تُهمل)، التوفير يُعاد حسابه `unitPrice×qty − price` (> 0 وإلا يُهمل)، سقف إلحاق `MAX_OFFER_PRESSES=2` لكل محادثة+SKU، رفض العميل يوقف العرض نهائيًا |
| الخصومات | — | سياسة خادمية: ضمن `discountCap` → مباشر بـ `orders.discount`؛ فوقه/بلا سقف → موافقة مشرف (`orders.discount.approve`) بسجل مثبت (سعر لحظة الاعتماد، بطلان عند تغير السعر/المنتهية/تبدل المنتج)، فصل واجبات (لا اعتماد ذاتي) |
| سعر الجملة | حقل مخفي | لا يدخل أي Prompt ولا نص عميل إطلاقًا؛ ظهوره للموظف يتطلب `products.wholesale` + حارس إرسال نهائي `assertNoWholesaleLeak` |
| Sales Coach | — | لوحة داخل صندوق الوارد (اقتراحات `internalOnly` فقط — لا إرسال تلقائي أبدًا؛ الإدراج في المحرر بفعل الموظف)، سبب صريح عند غياب البيانات |
| العزو الإعلاني | `Order.adSource` موجود غير مستخدم | `Customer.adSource/adSourceAt` — لمسة أولى فقط من إحالة القناة الموثوقة (`referral.ref`/`postback.ref`)، لا استبدال أبدًا (حماية إعادة إرسال Webhook)، غياب الإحالة = غير معروف |
| القياس | — | `SalesEvent` (9 أنواع) — فصل صارم: اقتراح ≠ أُرسل ≠ قَبِل ≠ طلب؛ `OFFER_SHOWN` بعد وصول الرد فقط؛ `OFFER_ACCEPTED` بطلب مؤكد بكمية ≥ كمية العرض؛ تحليلات بصيغ موثقة (`offerAcceptRate` = Accepted/Shown، null عند غياب العروض) |

### البنية والملفات

- **ترحيل** `p8_sales_intelligence` (dev فقط): `Customer.adSource/adSourceAt` + جدولا `DiscountApproval` و`SalesEvent` (مع فهارس).
- **جديدة**: `modules/sales/{plan-schemas,plan-builder,metrics,pricing-policy,ad-source,coach}.ts` · `api/conversations/[id]/coach/route.ts` · `api/discount-approvals/route.ts` · `api/discount-approvals/[id]/route.ts` · لوحة المساعد في `components/inbox/inbox.tsx` · `tests/p8-sales.test.ts` (36).
- **معدلة**: `modules/rbac/permissions.ts` (+`orders.discount`، +`orders.discount.approve`، +`products.wholesale` — MANAGER الثلاثة، SALES_AGENT الخصم فقط) · `ai/stages/{state,extraction,response}.ts` + `ai/prompts.ts` (بناء الخطة بعد الاستخراج، توسيع `allowedNumbers`، حجب خطة البيع في الـ Prompt مع سطر "ممنوع" — بلا سعر جملة، تسجيل `OFFER_SHOWN` بعد الإرسال الناجح) · `orders/order-service.ts` (وراثة `adSource` للطلب + أحداث `OFFER_ACCEPTED`/`CROSS_SELL_ADDED` best-effort) · `channels/facebook/{normalizer,types,adapter}.ts` (+`adRef` من referral/postback) · `conversations/inbound.ts` (استدعاء `recordAdSource` first-touch) · `tests/helpers/inmemory-db.ts` (جدولا `salesEvent` و`discountApproval`).

### الضمانات المثبتة (اختبارات)

- **حتمية الخطة**: كل رقم في `salesPlan` من DB (سعر/كمية/إجمالي/توفير)؛ صفوف العرض التالفة أو المنتهية أو بلا توفير حقيقي تُهمل ولا تُخترع؛ أسباب الغياب مجموعة مغلقة (`NO_PRODUCT`، `PRICE_UNAVAILABLE`، `PRODUCT_UNAVAILABLE`، `NO_VALID_OFFERS`، `OFFER_NOT_WORTHWHILE`، `OFFER_PRESSED_OUT`، `OFFER_DECLINED_BY_CUSTOMER`…).
- **منع التسريب**: سعر الجملة غائب عن لوحة الموظف غير المخول وعن كل نصوص الاقتراح وعن رد الـ Pipeline الفعلي؛ الحارس النهائي يرمي عند ظهوره في نص عميل.
- **الخصومات**: ضمن السقف/فوقه/بلا سقف/نسبة غير صالحة؛ لا اعتماد ذاتي؛ لا قرار مزدوج؛ الاستخدام يتحقق من المنتج والسعر والصلاحية (بطلان EXPIRED/PRICE_CHANGED/PRODUCT_MISMATCH/NOT_APPROVED).
- **الـ Coach**: داخلي فقط (`internalOnly: true`) — صفر رسائل OUTBOUND، بلا إرسال تلقائي؛ بلا صلاحية الخصم حتى حساب التفاصيل ممنوع؛ بيانات ناقصة → سبب صريح لا تخمين.
- **الـ Pipeline الكامل**: نية شراء + منتج بعرض → `OFFER_QUALIFIED` ثم `OFFER_SHOWN` بقيمة التوفير بعد وصول الرد؛ محادثة HUMAN_ACTIVE → تعطيل كامل وصفر أحداث بيع.
- **العزو**: اللمسة الأولى تفوز، إعادة الإرسال لا تستبدل، بلا إحالة → null (غير معروف)؛ الـ Pipeline يلتقط `adRef` من بيانات القناة الموثوقة فقط.
- **RBAC**: تثبيت الصلاحيات الثلاث على الأدوار (MANAGER/SALES_AGENT/VIEWER) مع بقاء ثابتة القراءة-فقط لـ VIEWER.

### الحالات

| البند | الحالة |
|---|---|
| كل بنود P8 محليًا | VERIFIED_LOCAL (693/693 + 4 بوابات) |
| ترحيل `p8_sales_intelligence` على dev | VERIFIED_LOCAL (مطبق + مولّد العميل) |
| عقد OMS الحقيقي (عروض/أسعار حية) | CODE_COMPLETE (العقد من مخطط OMS الموثق — التحقق مع OMS فعلي: BLOCKED) |
| تحليلات على بيانات إنتاجية | CODE_COMPLETE (الصيغ موثقة وقابلة للحساب اليدوي — التجميع الليلي لاحقًا) |
| Push إلى GitHub | BLOCKED بالتعليمات (بانتظار موافقة المالك — P7 وP8 معًا) |
| Meta/OMS/staging/E2E | BLOCKED (كما في P5–P7، بلا تغيير) |

### قرار P8

**مغلق تقنيًا بانتظار مراجعة المالك — لا انتقال لـ P9.**

## P9 — الحملات التسويقية وشرائح الجمهور (10 تشرين الأول 2026)

> الأساس: شجرة العمل المحلية فوق P8 (غير مرفوعة). البوابات: **742/742 (49 ملفًا — أساس P8 693 + 49 لـ P9)** ✅ · typecheck ✅ · lint ✅ · scan:secrets ✅ · build ✅ (مسارات `/api/segments*` و`/api/campaigns*` وصفحة `/campaigns` ضمنها). ترحيل واحد مطبق على dev فقط (`20261010*_p9_campaigns`). **لم يُرفع إلى GitHub** (بحسب التعليمات). بلا رسائل حقيقية، بلا اعتماد قوالب Meta فعلي.

### الموجود مقابل الناقص (مثبت بالكود)

| الوحدة | الموجود (احتُفظ به) | الناقص (نُفّذ في P9) |
|---|---|---|
| شرائح الجمهور | لا شيء (greenfield) | `AudienceSegment` بمجموعة مغلقة من الشروط (10 حقول مسماة فقط — لا SQL ولا كود)، ديناميكية دائمًا، تقييم حتمي بحد 5000 مرشح، معاينة بأرقام من DB بلا بيانات شخصية |
| الموافقة التسويقية | — | `Customer.marketingConsent` (UNKNOWN/OPTED_IN/OPTED_OUT) + `marketingOptOutAt` — الاستبعاد عند أي حساب أو إرسال |
| قرار القناة | — | مجموعة مغلقة: WHATSAPP=TEMPLATE (القالب المعتمد إجباري — المسار الرسمي الوحيد)، TELEGRAM=DIRECT (مشتركو البوت)، FACEBOOK/INSTAGRAM/WEB→`CHANNEL_NOT_MARKETING_CAPABLE`، TIKTOK→`CHANNEL_ACCESS_NOT_APPROVED` (رفض، لا تقليد) |
| دورة الحياة | — | DRAFT→VALIDATING→READY→SCHEDULED→RUNNING→PAUSED/CANCELLED/COMPLETED/FAILED عبر `canTransition` — لا حالات عامة |
| الموافقة المثبتة | — | إصدارات محتوى append-only؛ الاعتماد يثبّت الإصدار + بصمة الجمهور `v1:{channel}:e{n}:x{n}` — أي تغيير محتوى أو جمهور بعد الاعتماد → `AUDIENCE_CHANGED` وإعادة التحقق |
| الجدولة durable | طابور BackgroundJob من P6 | `run_campaign` بمفتاح `campaign:{id}:run` (idempotent) + سلسلة `campaign_tick:{seq}` (enqueue التالي قبل المعالجة — استئناف بعد crash) |
| حد المعدل | — | نافذة دقيقة محفوظة على صف الحملة (`windowStartAt/sentInWindow`) — durable عبر إعادة التشغيل؛ دفعة ≤ 50؛ محاولات ≤ 5 لكل مستلم |
| الإرسال | `dispatchOutbound` من P5 | كل إرسال عبر المسار القائم (idempotency + سياسات + تصنيف عابر/دائم) بمفتاح `campaign:{id}:{recipientRowId}` — إعادة المحاولة تستعيد القبول ولا تضاعف أبدًا |
| إعادة التحقق | — | لقطة عند البدء + إعادة تحقق أهلية كاملة لكل مستلم لحظة الإرسال (قائمة سوداء/موافقة/قناة اتصال) — اللقطة القديمة لا ترسل أبدًا |
| مسار WhatsApp | `WhatsAppClient` (P5) | `sendTemplate` (Cloud API type:"template") + `canSendWhatsApp` يسمح خارج نافذة 24h بالقالب المعتمد فقط؛ إصلاح تصنيف الأخطاء: أكواد Graph ≥100000 (131047/132000…) دائمة لم تعد "عابرة" |
| اقتراح الذكاء | privacy-gate/guardrails (P1) | `suggestCampaignDraft` بلا أي بيانات عملاء (pii فارغ)، بلا أسعار مخترعة، قنوات مسموحة فقط، مراجعة بشرية إجبارية |
| الواجهة | sidebar موجود | صفحة `/campaigns` (عربية RTL): إنشاء (حقول القالب لواتساب)، معاينة dry-run، أزرار دورة الحياة، سجل التنفيذ |

### الضمانات المثبتة (اختبارات — 49)

- **تعريف الشريحة**: مجموعة مغلقة — حقل/عملية/قيمة غير معروفة تُرفض؛ الإصدار وعدد الشروط محدودان.
- **الأهلية**: القائمة السوداء ← الاستبعاد الصامت؛ إلغاء الموافقة/غيابها/غياب قناة الاتصال أسباب مغلقة؛ وجود رقم هاتف وحده لا يكفي (هوية على نوع قناة الحملة فقط)؛ عميل خارج المساحة = استبعاد صامت.
- **التقييم**: توزيع الاستبعاد بالفئات المغلقة؛ عزل المساحات؛ شرط noReply (آخر رسالة موظف بعد آخر رسالة عميل) post-filter حتمي؛ حد المرشحين مثبت (take = 5001).
- **القنوات**: قرار القناة حرفيًا لكل قناة؛ إنشاء حملة على قناة غير مسموحة يُرفض عند حدود المخطط (مجموعة مغلقة)؛ واتساب بلا قالب → `TEMPLATE_REQUIRED`.
- **دورة الحياة**: جدولة قبل الاعتماد → `NOT_APPROVED`؛ إعادة الجدولة idempotent (مهمة واحدة)؛ تغير الجمهور بعد الاعتماد → `AUDIENCE_CHANGED` وإعادة VALIDATING؛ تعديل المحتوى append-only (نسخة جديدة، الموافقة تسقط)؛ الاعتماد يتطلب `campaigns.approve`؛ انتقالات غير مسموحة تُرفض والحالات النهائية لا تتحرك.
- **بوابة البدء**: غير SCHEDULED → لا بدء؛ بلا اعتماد مثبت → FAILED+POLICY_BLOCKED؛ جمهور فارغ → `EMPTY_AUDIENCE`؛ البدء ينشئ لقطة PENDING ويشغّل tick:1؛ إعادة تسليم المهمة لا تضاعف اللقطة.
- **الإرسال**: قالب معتمد عبر Cloud API (بنية body مثبتة)؛ المستلم SENT بمعرف رسالة؛ محادثات الحملة `camp-*` مع `HUMAN_ACTIVE` و`aiEnabled:false` (بلا AI تلقائي)؛ إعادة التحقق لحظة الإرسال (قائمة سوداء/إلغاء موافقة بعد اللقطة → EXCLUDED بلا إرسال)؛ الإلغاء بين اللقطة والتنفيذ → CANCELLED وصفر إرسال؛ الإيقاف الفوري بين مستلم وآخر؛ نافذة الدقيقة durable (ratePerMinute=1 → إرسال واحد لكل نافذة)؛ عابر → PENDING بحد محاولات، دائم (131047) → FAILED PERMANENT؛ مفتاح الإرسال ثابت لكل صف مستلم (لا إرسال مزدوج).
- **Dry-run**: يكشف `NOT_APPROVED` قبل الاعتماد، لا يكتب شيئًا (بلا مستلمين وبلا مهام)؛ بعد الاعتماد → لا مشاكل والأعداد مطابقة.
- **RBAC**: `campaigns.read/write/approve` — MANAGER الثلاثة، SALES_AGENT القراءة فقط، VIEWER القراءة.
- **الذكاء**: صفر بيانات عملاء في الـ Prompt (اسم وهاتف عميل حقيقيان لا يظهران)؛ FACEBOOK مرفوض.
- **runJobs**: run_campaign → بدء + لقطة؛ tick → إرسال ثم COMPLETED؛ إعادة تسليم run_campaign بعد الإكمال no-op.

### الحالات

| البند | الحالة |
|---|---|
| كل بنود P9 محليًا | VERIFIED_LOCAL (742/742) |
| ترحيل `p9_campaigns` على dev | VERIFIED_LOCAL (مطبق + مولّد العميل) |
| إرسال قالب عبر Meta فعليًا + حالة اعتماد القالب لدى Meta | CODE_COMPLETE (بنية Cloud API الموثقة؛ اعتماد القالب يُدار من واجهة المالك — التحقق الحي: BLOCKED) |
| مشترکو بوت Telegram كجمهور DIRECT (تحقق الاشتراك الحي) | CODE_COMPLETE (بوابة الأهلية تنفذ هوية القناة؛ اختبار الإرسال الحي: BLOCKED) |
| متعدد العمال على Postgres (scales/نافذة المعدل تحت التزامن) | BLOCKED (كما في P6–P8) |
| Push إلى GitHub | BLOCKED بالتعليمات (بانتظار موافقة المالك — P7 وP8 وP9 معًا) |
| Meta/OMS/staging/E2E | BLOCKED (كما في P5–P8، بلا تغيير) |

### قرار P9

**مغلق تقنيًا بانتظار مراجعة المالك — لا انتقال لـ P10.**

## P10 — التحليلات والتقارير الموحدة (10 تشرين الأول 2026)

> الأساس: شجرة العمل المحلية فوق P9 (المرفوع `41eaa67`). البوابات: **772/772 (50 ملفًا — أساس P9 742 + 30 لـ P10)** ✅ · typecheck ✅ · lint ✅ · scan:secrets ✅ · build ✅ (مسارات `/api/analytics/{sales,agents,campaigns,trends,export}` وصفحة `/analytics` ضمنها). **لم يُنشأ commit ولا رفع** (بحسب تعليمات P10 — بانتظار مراجعة المالك). بلا بيانات وهمية إطلاقًا: null = "غير متاح" لا صفر.

### الموجود مقابل الناقص (مثبت بالكود)

| الوحدة | الموجود (احتُفظ به) | الناقص (نُفّذ في P10) |
|---|---|---|
| نقاط نهاية تحليلية | 11 نقطة عبر `analyticsRoute` (P6–P8) بلا تغيير | 5 الجديدة: `sales` (أول مسار لـ getSalesAnalytics)، `agents`، `campaigns`، `trends`، `export` |
| منطقة زمنية | `resolveRange` TZ-aware من P6 | إصلاح حقيقي: إزاحة TZ تُقرَّب لأقرب دقيقة (كانت تُرجع كسور دقيقة → انزياح 1ms عند حدود الأيام) |
| نظرة عامة | getOverview (محادثات/طلبات/AI/أتمتة) | إضافة `customers` (جديد بالفترة + الإجمالي) — أزيل العنصر الوهمي من الداشبورد؛ تكلفة AI null ≠ صفر |
| أداء الموظفين | assignedAgentId/HumanHandoff/AuditLog موجودة | `agents.ts`: إسناد موثق معلن (محادثات معينة، ردود بشرية فقط — رسائل AI مستثناة، FRT وسيط لكل موظف، طلبات عبر المحادثة المسندة، اعتمادات خصم من سجل التدقيق) — مقاييس العروض لكل موظف UNAVAILABLE (SalesEvent بلا فاعل) |
| صلاحية حساسة | RBAC من P2 | `analytics.agents` جديدة (MANAGER فقط) على المسار والتصدير |
| الحملات | runlog من P9 | `campaigns-analytics.ts`: قبول API ≠ تسليم ≠ قراءة؛ تسليم/قراءة من Message.deliveryStatus مع علامة `UNVERIFIED_NO_STATUS_WEBHOOK_DATA` (webhooks الحالة غير معالجة — موثق)؛ العزو وROAS UNAVAILABLE (Order بلا campaignId) |
| الاتجاهات | `DailyWorkspaceAnalytics` يُبنى ولا يُقرأ (منذ P6) | `trends.ts`: قراءة فعلية (أيام UTC) — يوم بلا صف = MISSING لا صفر؛ STALE بعد 6 ساعات؛ إصلاح ذاتي بمهمة تجميع idempotently (`analytics-rebuild:{ws}`) |
| التصدير | — | `export` CSV بنفس دوال الحساب (أرقام حتمًا متطابقة مع الواجهة)، حد 10,000 صف، حارس حقن صيغ CSV، BOM UTF-8، تدقيق `analytics.exported` |
| دقة المال | — | `sumMoney`/`avgMoney` بالسنتات (0.1+0.2=0.3 مثبت) |
| الواجهة | صفحة تحليلات قديمة | مركز تحليلات بتبويبات (8): تنفيذية (بمقارنة فترتين بنفس الطول)/محادثات/مبيعات/موظفون/ذكاء/حملات/أتمتة/اتجاهات + فلاتر فترة ومنطقة زمنية + تصدير |

### الضمانات المثبتة (اختبارات — 30)

- **الصيغ**: عزل المساحات في كل وحدة؛ أرقام مطابقة للحساب اليدوي؛ دقة المال بالسنتات؛ الفرفش الدالة null ≠ صفر (تكلفة AI بلا تسعير → null).
- **المنطقة الزمنية**: اليوم في دمشق يبدأ 21:00Z من اليوم السابق (UTC+3)؛ نافذة 7 أيام صحيحة؛ مقارنة فترتين بنوافذ مستقلة.
- **المحادثات**: FRT = أول صادر بعد أول وارد؛ محادثة بلا رد تُستثنى (لا صفر)؛ رسالة صادرة قبل أول وارد لا تُحسب FRT.
- **الطلبات**: مسودة ≠ طلب؛ قواسم AOV صحيحة؛ لا شيء مخترع خارج OMS؛ أسعار المنتجات من snapshot الطلب لا السعر الحالي.
- **الذكاء**: توزيع حسب المهمة والنموذج من usage logs الفعلية.
- **العروض**: بسط/مقام معدل القبول من أحداث فعلية (OFFER_SHOWN ≠ OFFER_ACCEPTED).
- **الموظفون**: الإسناد عبر assignedAgentId فقط؛ رسائل AI لا تُحسب ردود موظف؛ RBAC مثبت (SALES_AGENT/VIEWER مرفوضان).
- **الحملات**: قبول API ≠ تسليم؛ أسباب الاستبعاد من اللقطة؛ إثبات التسليم يتطلب DELIVERED فعليًا على الرسالة؛ عزل المساحات.
- **الاتجاهات**: أيام معاد بناؤها تُقرأ OK؛ المفقودة MISSING؛ مهمة التجميع idempotent (مهمة واحدة مهما تكرر الطلب)؛ عزل المساحات.
- **التصدير**: حارس حقن الصيغ (`= + - @ TAB CR`)؛ حدود الصفوف.

### الحالات

| البند | الحالة |
|---|---|
| كل بنود P10 محليًا | VERIFIED_LOCAL (772/772) |
| webhooks حالة WhatsApp (تسليم/قراءة فعليان) | غير معالجة (موثق منذ P5) → عداد التسليم يظهر UNVERIFIED صراحة |
| عزو الطلبات للحملات/ROAS | UNAVAILABLE (لا campaignId على Order — بلا تخمين) |
| مقاييس العروض لكل موظف | UNAVAILABLE (SalesEvent بلا هوية فاعل) |
| التجميع الليلي على عامل حي | CODE_COMPLETE (المهمة idempotent عبر الطابور — التحقق على عامل حي: BLOCKED) |
| تسجيل الدخول من القائمة | BLOCKED (كما في P5–P9) |
| Commit/Push | لم يُنفَّذ — بانتظار مراجعة المالك (تعليمات P10) |

### قرار P10

**مغلق تقنيًا بانتظار مراجعة المالك — لا انتقال لـ P11.**

## P11 — الواجهة الاحترافية وتجربة الجوال (10 تشرين الأول 2026)

> الأساس: شجرة العمل فوق P10 (غير المرفوعة). البوابات: **778/778 (51 ملفًا — أساس P10 772 + 6 لـ P11)** ✅ · typecheck ✅ · lint ✅ · scan:secrets ✅ · build ✅. **لم يُنشأ commit ولا رفع** (تعليمات P11). لا منطق أعمال ولا RBAC ولا Privacy Gate لم يتغير — التغييرات كلها في طبقة العرض، ومكونات مشتركة جديدة فقط. نسخة احتياطية موثقة قبل البدء: `Documents/System7-pre-P11-20261010-154500` (1346 ملفًا + bundle + patch + VERIFY PASS).

### منهجية التدقيق

تدقيق بثلاث مسارات متوازية (صندوق الوارد + المكونات المشتركة / صفحات البيانات والفريق / صفحات الذكاء والأتمتة) على ~30 صفحة ومكونًا — النتائج موثقة بملف:سطر. ثم خطة أولويات ثم تنفيذ. لغة التصميم القائمة (توكنات CSS، نظام Glass، RTL أصيل، وضع ليلي، `prefers-reduced-motion`) كانت متماسكة — **حُوفظ عليها** ولم تُستبدل؛ التوحيد تم عبر استخدامها في كل مكان كان يهرّب منها.

### أهم ما نُفّذ

**مكونات مشتركة (لا مكتبة ثانية — فوق القائمة):**
- `ConfirmDialog` (فوق Dialog: فخ تركيز + ESC + حالة busy + خطر أحمر) — حل محسوم لتأكيدات العمليات الحساسة بدل `window.confirm` الخام والنوافذ اليدوية.
- `ErrorState` (خطأ + إعادة محاولة) — لا صفحة تبقى هيكل تحميل أو "فراغ زائف" عند فشل الطلب.
- `Dialog`: فخ تركيز كامل (Tab محصور + تركيز أولي + استعادة التركيز عند الإغلاق).
- `Drawer`: نقطة توقف قابلة للضبط (`until="lg"|"xl"`) — صار يمكن استخدام اللوحة الجانبية بين 1024–1280.
- i18n: عائلات تسميات جديدة — المشغلات (11)، عمليات الشروط (12)، حالات سير العمل والذكاء (AI_ACTIVE/HUMAN_ACTIVE/DRAFT/PUBLISHED…)، نتائج المحاكاة — لا enums إنجليزية خام للمستخدم.

**صندوق الوارد (الأولوية):**
- لوحة العميل (Contact 360) صارت متاحة على الشاشات <1280 عبر Drawer وزر "ملف العميل" — كانت محجوبة كليًا.
- حماية من الاستجابات اليتيمة: عدّادات تسلسل لقائمة المحادثات والرسائل — استجابة بطيئة لا تكتب فوق حالة أحدث (تبديل محادثة/فلتر).
- الرسائل المتفائلة غير المؤكدة (PENDING/QUEUED/FAILED) لا يمسحها الاستطلاع الدوري بعد الآن — يبقى زر إعادة الإرسال متاحًا (الإرسال نفسه بمفتاح idempotency كما هو — لم يتغير).
- تمييز التحميل عن الفراغ: محادثة بلا رسائل تُظهر حالة فراغ حقيقية بدل Skeleton أبدية.
- وضع "ملاحظة داخلية" للكاتب له إطار كهرماني واضح قبل الإرسال — لا التباس بصري مع الرد للعميل.
- "تم الحل" و"إعادة للذكاء": حالة busy + توست خطأ عند الفشل (كان فشلًا صامتًا)؛ نجاح "تم الحل" بعد التحقق لا قبله.
- مساعد البيع: فشل الطلب يظهر كخطأ مع إعادة محاولة — لا "لا اقتراحات" الزائفة.
- النوافذ الثلاث اليدوية (مساعد/استلام/حذف) → ConfirmDialog/Dialog المشتركة.
- ارتفاع اللوحة بـ `dvh` (شريط عنوان الجوال المتقلص لا يكسر التخطيط).
- RTL للفقاعات: رد الموظف الصادر عند نهاية السطر ورسالة العميل عند بدايته (عرف تطبيقات المحادثة العربية — كان معكوسًا).
- قائمة المحادثات: `role="option"/aria-selected` سليمة، والأرقام/الهواتف بعزل ثنائي الاتجاه.

**الصفحات:**
- حالات خطأ + إعادة محاولة: handoffs، follow-ups، channels، settings/ai، workflows، automation، campaigns، personas (كانت تعرض "لا بيانات" الزائفة عند فشل الطلب).
- تأكيدات للعمليات الحساسة: حذف workflow، حذف أتمتة، إلغاء حملة (يوقف إرسالًا حيًا)، إلغاء طلب، رجوع لإصدار شخصية، إلغاء متابعة، أرشفة رأي، إزالة/إيقاف عضو فريق (كان `window.confirm`).
- "وضوح الحالة": اختبار اتصال المزود يعرض الفشل صراحة، وشارة "حالة محفوظة — لم يُختبر حيًا" قبل أي ping — لا "متصل" بلا إثبات؛ رسائل القنوات الأخطاء بخطورة حمراء منفصلة عن النجاح؛ فشل حفظ إعدادات AI يظهر (كان صامتًا).
- إصلاح عيب حقيقي في التحليلات: صف "عروض قُبلت" كان يمرر نصًا إلى دالة أرقام (NaN يُعرض) — حُذف وأُضيف KV صحيح لمعدل القبول مع دلالة null؛ مقارنة الفترة السابقة صارت بالمفاتيح لا بالتسميات العربية (كان تغيير نص يكسر المقارنة صمتًا)؛ فشل التصدير يظهر توست خطأ.
- إصلاح عيب حقيقي في Playground: أول إرسال بلا جلسة كان ينشئ **جلستين** (سباق POST مزدوج) — الآن جلسة واحدة عبر ref.
- campaigns: الـ Dry-Run من البطاقة الصحيحة (كان يعرض نتيجة حملة تحت أخرى)، ونموذج الإنشاء متجاوب (grid بدل عروض ثابتة).
- workflows: باني الشروط يتجمع على الجوال (كان أعمدة مكسورة ~60px).
- auth: استجابات غير JSON (502 proxy) تعرض خطأ عربي واضح + `autocomplete` صحيح.
- إزالة نقطة إشعار زائفة ثابتة من الشل (كانت توحي بتحويلات معلقة دائمًا).

### نتائج الجوال (مقاسة فعليًا — Playwright على خادم dev حقيقي)

- **صفر تمرير أفقي** على 18 مسارًا كاملة بمقاس 375×812 (مقاس برمجي: `scrollWidth - clientWidth = 0` لكل مسار).
- لقطات موثقة (`.playwright-mcp/p11-*.png`): دخول الجوال، لوحة التحكم، صندوق الوارد (قائمة كاملة العرض، التفاصيل تفتح بديلًا)، تحليلات سطح المكتب 1366px، صندوق الوارد 3 لتحاين.
- المستخدمون الأساسيون على الجوال: التنقل عبر Drawer، المحادثة تفتح بملء الشاشة مع زر عودة يحفظ حالة القائمة، ولوحة العميل عبر Drawer جانبي.

### الحالات

| البند | الحالة |
|---|---|
| كل بنود P11 محليًا | VERIFIED_LOCAL (778/778 + build + لقطات) |
| فحص متصفح حي (18 مسارًا، مقاسا 375/1366، دخول حقيقي، صفر تمرير أفقي، صفر أخطاء كونسول) | VERIFIED_LOCAL (Playwright MCP على خادم dev — ليس ادعاء) |
| اختبار محادثة برسائل فعلية في الواجهة (فقاعات/ملاحظات/إرسال بصريًا) | BLOCKED (لا قنوات حية — الرسائل تصل عبر Webhooks القنوات؛ المنطق نفسه مغطى باختبارات P4–P8 ولم يتغير) |
| الوضع الداكن | VERIFIED_LOCAL (موجود سابقًا — توكنات CSS لم تُمس؛ لقطة التحليلات تعمل بالنمطين) |
| متصفح حقيقي على جهاز جوال فعلي | BLOCKED (لا جهاز — الفحص تم على viewport محاكى) |

### قرار P11

**مغلق تقنيًا بانتظار مراجعة المالك — لا انتقال لـ P12.**

## Hermes External Persona (11 تشرين الأول 2026) — شخصية الرد من Hermes

**القرار المعماري:** عند اختيار المزود `hermes` (مساحة العمل أو `AI_PROVIDER`) تصبح شخصية الرد (الصوت/اللهجة/النبرة/الإقناع) مملوكة لوكيل Hermes المضبوط خارجيًا. Zaki AI يجهّز السياق والبيانات التجارية الموثوقة، يستلم الرد، يتحقق منه، ويرسله — دون حقن أي Persona محلية أو Prompt شخصية في طلبات Hermes.

**ما تغيّر في مسار الرد (`gating → extraction → response`):**
- `router.ts`: `isHermesSelected()` (نية الإعدادات) + `isHermesPersonaMode()` (المزود الفعلي) — تعريف واحد للوضع يتفق عليه المسار والواجهة والحراس.
- `gating.ts`: تخطي `resolveChannelPersona` كليًا في وضع Hermes (لا قراءة Persona) + علّامة `hermesPersona` في الحالة + لا HumanHandoff عند تعذر الإعداد.
- `extraction.ts`: تعليق `mustHandoff` (حقن/شكوى/طلب موظف/ثقة منخفضة) وتعليق HANDOFF الخاص بـ ORDER_BLOCKED (الطلب يبقى محظورًا بقواعد OrderService + audit، والرد يستمر) — المحادثة تبقى OPEN.
- `response.ts`: النظام = ترويسة نقل (`hermesExternalPersonaHeader` — تأطير هيكلي يفوّض الصوت لـ Hermes) + البيانات التجارية الموثوقة فقط؛ لا `personaPrompt` ولا `responseInstruction` ولا `prohibitedPhrases` المحلية؛ لا fallback بديل (الفشل ظاهر وقابل لإعادة المعالجة بنفس idempotency)؛ لا Handoff عند الفشل؛ telemetry بـ `personaId/version = null`.
- `playground-service.ts`: نفس القاعدة في التجربة اليدوية.
- الاستخراج/التضمينات/المسودات/OMS/Privacy Gate/Guardrails/العزل/الصلاحيات: **بلا تغيير**.

**تحييد Personas (بلا حذف جداول أو سجلات):** حارس خادمي `assertLocalPersonaMutable()` يرفض 409 كل ما يغيّر الشخصية الحية (تفعيل/نشر/رجوع/ربط قناة) في وضع Hermes — القراءة والمسودات والسجل باقية. الواجهات (personas/channels/settings-ai) تعرض لافتة وتعطّل الحقول الميتة (عتبات الثقة/البديل). aiEnabled/autoRespond وتبديل المزود تبقى مفاتيح إيقاف حية.

**الحذف المستقبلي الموثق (Migration مستقلة لاحقًا، ليست الآن):** جداول `Persona`/`PersonaVersion` وعمود `Channel.aiPersonaId` وحقول الثقة في `AISettings` (`confidenceExecute/confidenceRespond/humanHandoffThreshold`) — تُحذف فقط بعد فترة تشغيل مستقرة بوضع Hermes + نسخة احتياطية. **لم يُحذف شيء الآن.**

**التحقق:** ملف `tests/hermes-persona-mode.test.ts` (13 اختبارًا عبر `processAIMessage` الفعلي) + كامل البطارية (test/typecheck/lint/scan:secrets/build). **لم يُنشأ commit** — بانتظار مراجعة المالك.

## Local Personas Drive Replies — Hermes Brand Removed (11 تشرين الأول 2026)

**التغيير:** الشخصيات المحلية (Persona/PersonaVersion) عادت تقود صوت الردود في **كل** أوضاع المزود بما فيها الخارجي: البوابة لا تحمل `personaId` (مثبت من العقد — OpenAI-compatible فقط)، فالتعليمات المنشورة تُحقن في الطلب عبر بانِي الرسائل القياسي. تعليق التحويل التلقائي باقٍ في مسار المزود الخارجي (تفعيل الشخصية لا يعيد إنشاء Handoff، والفشل يُبقي OPEN). الـ fallback الصريح المهيأ يعمل ويُسجَّل (`fallbackAttempted` يُصحَّح حتى عند فشله).
**إزالة القيود:** حُذف حارس 409 (`persona-control.ts`) وفُتحت كل مسارات Personas والقنوات؛ الواجهات (personas/channels/settings-ai) بلا تعطيل، مع شارة «الافتراضية للمساحة» وتمييز ربط القناة.
**إخفاء الاسم:** لا «Hermes» في أي نص مرئي (تسميات عامة: الوكيل الذكي/مزوّد الذكاء الاصطناعي/الشخصية النشطة) — وبقيت القيمة الداخلية `hermes` و`HERMES_*` والمسارات والمصادقة والاختبارات والسجلات كما هي.
**الأولوية المثبتة:** القناة → افتراضية المساحة → المضمنة، والإصدار المنشور يُسجَّل في التتبع.
**التحقق:** `persona-management.test.ts` (مسارات حقيقية 201/200 + Playground بنفس الشخصية + مسح نصوص) + تحديث `hermes-persona-mode.test.ts`. **لم يُنشأ commit** — بانتظار مراجعة المالك.

## P12 — الربط مع منظومة Zaki وباب الوكلاء Hermes (11 تشرين الأول 2026)

> الأساس: `844d564` (main) + دمج `e87409b` ثم `67093e8` (الشخصيات المحلية بكل مزوّد · إخفاء اسم Hermes). الفرع: `feat/p12-zaki-ecosystem`. البوابات: على Node 20 (متل CI والإنتاج) وNode 22 ✅ — العدد بالدمج الأخير تحت. · typecheck ✅ · lint ✅ · scan:secrets ✅ · build ✅ · الترحيل على Postgres 16 حقيقي + فحص الانجراف ✅ (الفرقان الوحيدان قديمان: `KnowledgeChunk.embedding` vector و`DailyWorkspaceAnalytics.date` @db.Date) · لقطات Playwright على 375px و1280px — **صفر تمرير أفقي وصفر أخطاء كونسول** (6 شاشات + 5 حالات لبطاقة الـ OMS بالجولة التانية). التفاصيل الكاملة: `docs/INTEGRATIONS.md` · باب الـ OMS: `docs/OMS-DOOR-V1.md`.

### الموجود مقابل المضاف (مثبت بالكود — ولا شي موجود انبنى من جديد)

| الوحدة | كان موجود (احتُفظ به ووُسّع) | المضاف بـ P12 |
|---|---|---|
| ربط الـ OMS | عميل legacy + ترحيل + webhook P2 بصيغة مخترعة | **استقبال أحداث تطبيقات الـ OMS الحقيقية** (`/api/webhooks/oms/{key}` · `sha256=` على `ts.body` بالميلي) · مطابقة بالمعرّف ثم الرقم · قفزات الحالة للأمام · **الوضع اليدوي** (نص «إدخال الطلب بالذكاء» + ربط الرقم) لأن الـ OMS بلا باب استقبال · عميل **v1** جاهز للباب القادم · ترحيل تلقائي اختياري · فحص اتصال |
| مصدر الإعلان | `adSource` نص حر من `metadata.adRef` (كان ميت على فيسبوك) | **إسناد بحلقات** (واتساب CTWA · ماسنجر/إنستغرام referral · رموز الكليبر) · «بداية المحادثة بتحكم» · `ctwa_clid`/PSID مشفّرين · لقطة على كل طلب |
| الحملات P9 | شرائح · موافقة (حقل بلا كاتب!) · اعتماد بهاش الجمهور | **الموافقة صارت حقيقية** (كلمة «إيقاف» · تسجيل صريح من الموظف · رجوع بتأكيد) · شروط شرائح جديدة (رمز · بلا طلب · حالة طلب · سقف تكرار) · حملات الكليبر وHermes من نفس المسار |
| الحارس P6 | حارس الرد العام | **قواعد سيستم 1 لكل منتج** بالسياق والحارس (`BANNED_CLAIM`) |
| تحليلات P10 | أداء الموظفين · الحملات (تسليم «غير متحقق») | **إشارات واتساب statuses[]** بتحدّث التسليم/القراءة · رسائل الحملات مش «موظف وهمي» |
| أنظمة المنظومة | — | سجل أنظمة بالكود · اتصالات مشفّرة · **صندوق صادر موقّع** بإعادة محاولة · توكنات بأقل صلاحية · مسارات `/api/v1` (القدرة · حملات الكليبر · أحداث سيستم 1) · مجدول بالعامل (القدرة · التكاليف · صحة القنوات · المهام · الأفكار · الامتثال · نتائج الحملات) |
| Hermes | Hermes كمزود ردود (P-Hermes) | **باب الوكلاء agent-door/v1** (11 أداة · مخططات حرفية · مسودات بـ Idempotency-Key وتجربة وسقف يومي · سجل · زر إيقاف) — ⚠️ Hermes كمزود ردود الزبائن صار أحمر بالواجهة مع تصحيحه |
| الواجهة | الإعدادات (AI · الفريق) | «الربط مع الأنظمة» · «باب الوكلاء» · بطاقة الـ OMS بصفحة الطلب · موافقة الزبون ومصدره بلوحة المحادثة · تبويب الامتثال بالمنتج — كلها RTL وجوال أولًا |

### عيوب اتلقطت وتصلّحت (مراجعة اختبارات مستقلة + فحص العقود)

- `enqueueJob`: `findUnique` على مفتاح فريد **جزئي** مش معرّف بمخطط Prisma — كان رح يرمي خطأ تحقق بدل إرجاع المهمة الفائزة (قديم، ظهر مع P12) ← `findFirst` على النشطة.
- القدرة: رسالة حملة بتحدّث `lastAgentMessageAt` وبتخفي زبون منتظر ← تأكيد «الرد الحقيقي» من الرسائل نفسها.
- `retarget.result`: ملاحظة موظف داخلية كانت تنعد «رد زبون» · النتيجة النهائية كانت تنعلّم «انبعتت» حتى لو الكليبر موقوف.
- رمز النقرة كان يتخزن نص صريح بهوية القناة لزبون جديد · PSID بمفتاح عدم التكرار ← تنظيف قبل الإنشاء + مفتاح مهشور.
- مراجع معتمة بأرقام (`cv_…`, `agt_…`) كانت تنمسك كـ«هاتف» بحارس البيانات ~10% من المرات ← مراجع حروف + استثناء المعرّفات المعتمة.
- حدث سيستم 1 ناقص كان يرجع 500 (إعادة إرسال لا نهائية) ← 422.
- ربط يدوي غلط كان يخطف أحداث الطلب الصحيح ← مطابقة بالمعرّف أولًا + تعليم «ربط مشبوه».
- إنذار بعد «رجع طبيعي» بنفس الساعة كان ينبلع · رمز أرقام فقط (ممكن هاتف) كان ينبعت للكليبر بالرابط · طلبين متزامنين بنفس المفتاح كانوا يعملوا حملة يتيمة · إلغاء الـ OMS بعد الشحن كان يتجاهل · `verifyPayload` كان يقبل أكتر من كتابة لنفس التوقيع.
- DNS عند **كل إرسال** (مش بس عند الحفظ) — اسم صار يشير لعنوان داخلي ما بيوصله توكن.

### الجولة التانية من المراجعة المستقلة (كل بند باختبار كان رح يفشل قبل التصليح — `tests/p12-review-round2.test.ts` + `tests/p12-orders-route.test.ts`)

| الشدة | العيب | التصليح |
|---|---|---|
| عالي | إشارة «واصل/مقروء» من واتساب كانت تفتح إرسال تاني لنفس الحملة (عدم التكرار كان يعتبر SENT بس) | SENT · DELIVERED · READ كلها نهائية لنفس المفتاح |
| عالي | مفاتيح صندوق الصادر بلا المساحة (فريد عالمي) — مساحة تانية بنفس المالية/المهام/الإنذارات كانت تنبلع بصمت | المفتاح `مساحة:نظام:نوع:مفتاح` + وسم معتم للمساحة بمراجع التكاليف/المهام/الأفكار + مهمة امتثال لكل مساحة |
| متوسط | الإعادة كانت تروح للرابط القديم بالتوكن الجديد | الرابط بينبنى من الاتصال الحالي لحظة الإرسال (وزر «أعد المحاولة» كمان) · بلا رابط = إلغاء |
| متوسط | ترحيل الـ OMS بلا فحص الرابط (اتصالات ما قبل P12 بروابط داخلية) | فحص https + DNS عند كل ترحيل ومزامنة وفحص — رفض قبل التوكن وبيانات الزبون |
| متوسط | رقم OMS مكتوب غلط كان يربط الطلب بطلب زبون تاني ويسوق حالته | توحيد الرقم بصيغة الـ OMS `SY-2026-0148` · أول حدث لازم يطابق (العملة · المجموع · الوقت) · غير مطابق = أحمر بالصفحة وبالطابور · الربط اليدوي قابل للفك |
| متوسط | الترحيل التلقائي وتحقق الرموز كانوا يستسلموا بعد ~90 ثانية انقطاع بلا أثر | 8 محاولات (≈35 دقيقة) + كنس ساعي لـ 3 أيام · أحمر بصفحة الطلب · بطابور المالك وموجز Hermes |
| متوسط | `product_code` بمسودة الحملة كان عنوان بس | حصر فعلي (طلبات فيها المنتج · رمز كليبر للمنتج) وقت المسودة ووقت الاعتماد |
| متوسط | تغيير مرجع سيستم 1 كان يخلّي قواعد المرجع القديم شغّالة ويقول «انقرأت» | المرجع الجديد بيشيل القديم · نسخة مرجع تاني ما بتنطبق · سباق القراءة = `REF_CHANGED` · الخطأ للشاشة |
| منخفض | نص الإدخال: «العدد: 3» بالملاحظات بيغيّر الكمية · «؛» بالعنوان بيقصّه | تحييد الفواصل جوّا القيم + اختبار عقد بنسخة حرفية من محلّل الـ OMS |
| منخفض | إعادة حدث OMS ملتقط بمعرّف تسليم جديد · ربط يدوي بيشغّل محفّز «تحديث حالة» · حدث سيستم 1 لمساحتين · IPv4 مضمّن بـ IPv6 · مراجع `_ref` بأرقام هاتف · سباق قرار المسودة · `segment.days` بين JSON وzod · ردود PATCH الطلب بالمعرّفات المشفّرة وتعديل ملاحظات عبر المساحات | مفتاح من الجسم الموقّع · حدث `OrderOmsLinked` · عدم تكرار لكل مساحة · توسيع IPv6 وفحص المضمّن · صيغ معروفة + 9 أرقام · حجز ذري · tuple بنفس الحدود · `withoutClickSecrets` + تحقق المساحة |
| واجهة | المؤتمت كان أزرق ببعض الأماكن | أحمر + تصحيح برتقالي: الترحيل التلقائي بصفحة الطلب · قالب الرد الي كتبه الموديل · حملة Hermes · الكليبر ومساحة العمل وسيستم 1 بصفحة الربط · رقم الـ OMS اليدوي · `canWrite` من الصلاحية · اتصال OMS جديد = v1 |

### الحالات

| البند | الحالة |
|---|---|
| كل بنود P12 محليًا (مع جولتين مراجعة مستقلة) | VERIFIED_LOCAL (1175/1175 + build + ترحيل حقيقي + لقطات) |
| العقود (Hermes · الكليبر · الميديا باير · الـ OMS) | VERIFIED_LOCAL باختبارات حرفية (مخططات JSON مدققة بمدقق مستقل · أشكال الأحداث · التواقيع) |
| باب `/api/v1` بالـ OMS | BLOCKED على الـ OMS — الوضع اليدوي شغّال · المواصفة وبرومبت GLM جاهزين |
| ⚠️ OpenRouter بشاشة إدخال الـ OMS | خطر خارج الردود — 🔧 شيل `OPENROUTER_API_KEY` من بيئة الـ OMS |
| تحقق حي مع الأنظمة الحقيقية | BLOCKED (بلا روابط/توكنات حقيقية بالبيئة) |
| ⚠️ وسائط واتساب الواردة · احتفاظ `WebhookEvent.payload` | موجودة من قبل — موثقة بالأحمر مع تصحيح بـ `docs/INTEGRATIONS.md` |

### الدمج مع `main` (`e87409b` ثم `67093e8`)

- `main` تغيّر مرتين وفرع P12 مفتوح: «Hermes بشخصيته» (`e87409b`) وبعدها رجعت الشخصيات المحلية تقود الصوت بكل مزوّد وانشال اسم Hermes من كل نص مرئي (`67093e8`). انحفظ اتجاه `main` بالكامل.
- مسار الرد والتجربة اليدوية: موجّه واحد لكل المزوّدين — وقواعد سيستم 1 (المسموح · الممنوع) بتوصله بكل مزوّد وبالتجربة (`tests/p12-merge-main.test.ts` — 3 فشلوا قبل التصليح).
- إعدادات AI: واجهة `main` (تسميات عامة) + تنبيه P12 الأحمر لما يكون «الوكيل الذكي الخارجي» مزود أو بديل (`ExternalAgentRisk` — اسمه القديم انشال) + ⚠️ عتبات الثقة والتحويل التلقائي ما بتشتغل على المسار الخارجي 🔧 مراجعة يومية.
- إخفاء الاسم امتدّ لواجهات P12 (باب الوكلاء · الربط · المسودات · البطاقات) وللتسميات المعروضة من السجل (`TOKEN_PRESETS` · `SYSTEM_SPECS`) — اختبار مسح بيفشل على النسخ القديمة وبينجح هلأ. المعرّف الداخلي `hermes-bridge` ثابت.
- البوابات بعد الدمج الأخير: **1237/1237 (68 ملفًا)** على Node 20 وNode 22 · typecheck · lint · secrets · build ✅
- ⚠️ CI على `main` أحمر من 5 تشغيلات (Node 20 بيطبع منتصف الليل «24:00:00» مع `hour12:false`) — 🔧 الاختبار صار `hourCycle: "h23"` (انعاد إنتاج الفشل على Node 20.20.2 قبل التصليح؛ كود الإنتاج كان بيعالج «24»). أول CI أخضر بالريبو كان على هالفرع.

### قرار P12

**مغلق تقنيًا على الفرع `feat/p12-zaki-ecosystem` بطلب دمج — بانتظار مراجعة المالك.**

## نقل الـ CI والإنتاج لـ Node 22 (11 تشرين الأول 2026)

**ليش:** Node 20 انتهى دعمه (نيسان 2026) — بلا تحديثات أمان. الـ OMS على 24 أصلًا.

**شو اتغيّر (إعدادات بس — ولا سطر كود):**
- `Dockerfile`: التلات مراحل (deps · builder · runner) من `node:20-alpine` لـ `node:22-alpine`. سطور `openssl` و`libc6-compat` بتضل زي ما هي — Prisma 5.22 على musl لسا بيحتاجها، و`node:22-alpine` بنفس OpenSSL 3.
- `.github/workflows/ci.yml`: الوظيفتين من `node-version: 20` لـ `22`.
- `package.json`: `engines.node` من `>=20` لـ `>=22` — حتى المعلن يطابق الي منفحص عليه فعلًا.

**ملاحظة الوقت بقيت:** قاعدة `hourCycle: "h23"` بالاختبارات **ما انشالت** — صحيحة بكل الإصدارات، وبتحمي من انحدار. و`core/analytics/time.ts` بيحيّد حالة «24» صريح أصلًا.

⚠️ **البوابات محليًا انفحصت على Node 24 مش 22** — 🔧 الحكم للـ CI بعد طلب الدمج، وهو الي بيشتغل على 22 فعليًا.

## وسائط واتساب الواردة (11 تشرين الأول 2026)

**المشكلة:** ميتا بتبعت **معرّف** وسيط مش رابط (`image/video/audio/document = {id, mime_type, sha256}`)، والمحلّل كان يقرأ `link` بس — فكل وسيط وارد بواتساب كان يوصل بلا محتوى: الموظفة تشوف «وسيط» فاضي، والذكاء ما عنده شي يقرأه.

**شو انبنى (ولا شي موجود انبنى من جديد):**
- `whatsapp/normalizer.ts`: المعرّف والنوع والاسم والتعليق ينلتقطوا من نفس كائن الوسيط (`link` للصادر بيضل يشتغل متل قبل · الملصقات `sticker` انضافت).
- `whatsapp/client.ts`: `getMediaMeta` (معرّف ← رابط ميتا المؤقت) + `downloadMedia` (البايتات بنفس التوكن) — مع سقف حجم بينفحص قبل وبعد التحميل حتى وسيط ضخم ما يوقع العامل.
- `whatsapp/media-download.ts`: مهمة `download_whatsapp_media` — بتخزّن عبر **نفس مسار رفع الوسائط الموجود** (`media/service.ts`: فحص النوع · البايتات الأولى · الحجم · المخزن) وبتحدّث `Message.mediaUrl` لرابط عندنا.
- الصف من `channels/inbound-job.ts` بمفتاح عدم تكرار فيه المساحة (`wa-media:مساحة:wamid`) و8 محاولات.

**القرارات:**
- البصمة الصوتية `audio/ogg; codecs=opus` بتنقبل (المعامل بينشال قبل فحص النوع).
- ⚠️ نوع مش مسموح (زي `application/zip`) أو أكبر من الحد = **رفض نهائي بلا إعادة** — 🔧 السبب بينكتب على الرسالة (`waMediaError`) حتى يبيّن للموظف بدل ما ينضيع بصمت.
- عطل مؤقت من ميتا (429 · 5xx · انقطاع) = إعادة. توكن منتهي أو وسيط محذوف = نهائي مع سببه.
- تشغيل المهمة مرتين = تحميل واحد (الرابط الموجود بيوقفها).
- قناة من مساحة تانية ما بتوصل للوسيط.

**التحقق:** `tests/whatsapp-inbound-media.test.ts` — 13 اختبار، **9 منهم بيفشلوا قبل التغيير**. البوابات: typecheck · lint · scan:secrets · build ✅ · 1250/1250 بـ 69 ملف ✅

**الباقي:** لوحة المحادثة بتعرض الوسيط **كرابط مرفق** (`message-bubble.tsx` — موجود من قبل، بلا تغيير واجهة). معاينة الصورة جوّا الفقاعة مش مبنية — تحسين لاحق إذا المالك بدّه.

## تحصين خصوصية وسائط الزبون الواردة (11 تشرين الأول 2026)

⚠️ **العيب (من الكوميت الي قبله بنفس الفرع):** وسيط الزبون كان يتخزّن بالمكتبة المشتركة بتصنيف `OTHER` و**العنوان = اسم ملفه الأصلي** (ممكن يكون فيه اسم الزبون). و`buildMediaContext` بلا منتج بتنادي `findRelevantMedia` على **كل** وسائط المساحة: رسالة صورة بلا نص (بحث فاضي) ترجّع **أحدث 3 وسائط** — يعني وسائط زباين **تانيين** بعنوانها ورابطها جوّا برومبت الموديل، وممكن جوّا رد.

🔧 **التصحيح:**
- تصنيف جديد `CUSTOMER_INBOUND` + عمود `messageId` nullable (ترحيل إضافي: `ADD VALUE` + عمود + فهرس — ولا حذف ولا تغيير نوع). الوسيط مربوط **برسالته بس**.
- استثناء بكل استعلام مشترك: `findRelevantMedia` · `findProductMedia` (المسارين) · `findFeedbackMedia` · `listMedia` (المكتبة وكل المنتقيات بتمر منها) · `buildMediaContext` · حلّ وسائط الآراء بسياق الذكاء · و**رفض صريح** بـ `generatePublicMediaUrl` (المسار الي بيبعت لميتا).
- طلب التصنيف صريح بيرجع فاضي — مش بس الاستثناء الضمني.
- **الاسم معتم دايمًا**: `wa-<24 خانة من sha256(مساحة:معرّف)>.<امتداد>`، والوصف فاضي. واسم الملف من الزبون ما عاد ينمرر للمهمة أصلًا.
- مدة احتفاظ: `WA_MEDIA_RETENTION_DAYS` (افتراضي **180** يوم · `0` = مطفي) — بتحذف الملف وصف الوسيط، والرسالة بتحتفظ بعلامة `waMediaExpiredAt`. الملف أولًا فالصف يضل لو فشل الحذف (ولا ملف يتيم).
- ⚠️🔧 ملاحظة حمراء مع تصحيحها البرتقالي بصفحة الوسائط: الحذف مؤتمت ونهائي، والمدة بالإعداد.

**التحقق:** `tests/wa-media-privacy.test.ts` — 13 اختبار، **11 منهم بيفشلوا على الكوميت الي قبله**: البحث الفاضي · بحث يطابق اسم الملف القديم · محادثة تانية · المكتبة · المنتقيات · الرابط العام · الاسم الأصلي. وواحد بيتأكد إن **وسيط المنتج الحقيقي لسا يوصل** (ولا كسر للسلوك الموجود).

## مدة الاحتفاظ بحمولة أحداث القنوات الخام (11 تشرين الأول 2026)

**المشكلة:** `WebhookEvent.payload` بيحفظ حمولة ميتا كما هي — رقم الزبون · نص رسالته · رمز نقرة الإعلان (`ctwa_clid`) — و**بلا أي مدة**. يعني كل رقم ونص مرّ على النظام بيضل مخزّن للأبد.

**شو انبنى:**
- `src/modules/channels/webhook-retention.ts`: كنس بيفرّغ الحمولة (`{ purged: true }`) ويختم `payloadPurgedAt`.
- ترحيل إضافي بس: عمود `payloadPurgedAt` nullable + فهرس `(payloadPurgedAt, createdAt)` للكنس. ولا عمود انحذف ولا نوع اتغيّر.
- الكنس من المجدول الساعي (عام — `WebhookEvent.workspaceId` ممكن يكون فاضي)، محدود 500 صف بالدورة.
- `WEBHOOK_PAYLOAD_RETENTION_DAYS` بـ `.env.example` و`core/env.ts` — افتراضي **30 يوم**، و`0` = الكنس مطفي والحمولة تبقى (قرار صريح للمالك).

**القرارات:**
- **الصف ما بينحذف أبدًا** — عدم تكرار الأحداث معتمد على `(source, externalEventId)`؛ حذف الصف معناه إن إعادة قديمة من ميتا تنعالج من جديد ويوصل الزبون رد مكرر. الي بينشال المحتوى بس (مثبّت باختبار).
- حدث معالَج أو فاشل نهائيًا وأقدم من المدة = بينكنس. ⚠️ حدث لسا عم ينعالج بيضل بحمولته — 🔧 مقصود حتى الإعادة تقدر تشتغل، وبينكنس أول ما يخلص أو يفشل.
- حقل `error` بيضل للتشخيص — الحمولة بس بتنشال.
- قيمة غلط بالإعداد = الافتراضي 30 مع تحذير بالسجل (ما بتوقف الكنس).

**التحقق:** `tests/webhook-payload-retention.test.ts` — 11 اختبار، منهم واحد بيتأكد إن **المجدول بيشغّل الكنس فعلًا** (مش وحدة ميتة) وواحد بيتأكد إن الصف المُفرَّغ **لسا يمنع إعادة نفس الحدث**.

### تحسين الكنس والملاحظة بالواجهة (نفس اليوم)

- الكنس صار **دفعة بعد دفعة** (500 بالدفعة) لحد ما يخلص المؤهّل أو تخلص ميزانية ~20 ثانية للدورة الساعية، بدل حد ثابت 500/ساعة. متراكم 1200 صف بينكنس كله بدورة وحدة (مثبّت باختبار). دفعة كلها فشلت = وقوف بلا حلقة لا نهائية، والميزانية المستهلكة بترجع معلّمة (`budgetExhausted`).
- ⚠️🔧 ملاحظة حمراء مع تصحيحها البرتقالي بصفحة «الربط مع الأنظمة»: الرقم **الفعلي** من إعداد الخادم (مش الافتراضي) — والكنس لو كان مطفي (`0`) الملاحظة بتقلب وبتقول إن الحمولة بتتخزّن **بلا مدة** مع طريقة تشغيله. المدة انضافت لـ `/api/integrations` حتى الصفحة تعرض الرقم الصح.

## إعادة هيكلة التنقل والدليل والهوية (21 تشرين الأول 2026)

> الخطة الكاملة: `خطة_إعادة_هيكلة_سيستم7.docx`. طلب واحد بكوميتات مستقلة — كل كوميت بواباته.

### ١. التنقل — من ٢٢ بند لـ ٧ مجموعات

⚠️ **المشكلة (مقيسة):** القائمة الجانبية ٢٢ بند بصف واحد بلا تجميع · نفس الشغلة بأكتر من مكان (إعداد الذكاء بـ٤ أماكن · التقارير بـ٤ · الأتمتة بـ٣) · أيقونات مكرّرة (`FlaskConical` لـ«مختبر التجميع» و«تجربة الذكاء»، و`Users` لـ«العملاء» و«الفريق») · ولا دليل ولا خطوات بكل الموقع.

🔧 **الحل:** `src/lib/nav-model.ts` مصدر الحقيقة — ٧ مجموعات (الرئيسية · المحادثات · المبيعات · الذكاء · الأتمتة · التقارير · الإعدادات). القائمة الجانبية بتعرض المجموعات (وتحت كل وحدة سطر بيقول شو جواتها)، وشريط تبويبات بأعلى الصفحة بيتنقّل بين صفحات المجموعة.

- **ولا مسار بيتغيّر** — الصفحات بتضل على روابطها الحالية (الروابط بالإشعارات والمفضلة وباب الوكلاء ما بتنكسر). و٤ صفحات كانت بلا بند بالقائمة (`/analytics/ai` · `/analytics/products` · `/settings/ai` · `/settings/account`) صارت تبويبات.
- المطابقة بأطول رابط: `/settings/ai` بتتبع «الضبط» مش «عام»، و`/orders/x` بتتبع «الطلبات». `/order-warehouse` اسم مستعار لصفحة الطلبات (re-export) فبيتبع مجموعتها.
- الصلاحيات: الصفحة الممنوعة بتنشال والمجموعة الفاضية بتختفي. «حسابي» بلا صلاحية (لكل عضو).
- صندوق الوارد (شاشة كاملة) بيطرح ارتفاع شريط التبويبات (`--shell-extra`) — فحصته بالمتصفح: `overflow = 0`.
- 🔧 ربط الألوان بمتغيّرات CSS (كوميت لاحق) بيصلّح عيب موجود من #26: بالوضع الداكن بند القائمة النشط كان **مستطيل أبيض** (`bg-primary-soft` لون ثابت فاتح).

**التحقق:** `tests/nav-structure.test.ts` — ولا صفحة ضايعة · الـ٢٢ رابط القديم كلها لسا شغّالة · أيقونات فريدة · صلاحيات حقيقية · مطابقة المسار · شريط التبويبات. وإعداد `vitest` صار يترجم JSX (`esbuild.jsx: automatic`) حتى تنفحص المكوّنات.

### ٢. خطوات البداية — «الخطوة بتودي للتانية»

⚠️ **قبل:** ولا دليل بكل الموقع — المستخدم الجديد ما بيعرف من وين يبلّش ولا شو الناقص ليشتغل الوكيل.

🔧 **بطاقة «ابدأ من هون» بالرئيسية** (`modules/setup/progress.ts` + `GET /api/setup/progress`). كل خطوة بتتعلّم «خلصت» **من بيانات المساحة الفعلية** — مش زر بتضغطه:

| # | الخطوة | بتخلص لما | إجبارية؟ |
|---|---|---|---|
| ١ | اربط قناة | في قناة بحالة `CONNECTED` (مش المنفصلة ولا الي فيها خطأ) | ✅ |
| ٢ | أضف منتجاتك | في منتج فعّال وغير مؤرشف | ✅ |
| ٣ | اضبط شخصية الوكيل | في شخصية فعّالة | اختيارية — في شخصية عامة جاهزة (`channel-persona.ts`) |
| ٤ | جرّب الوكيل | في جلسة ملعب وحدة | اختيارية |
| ٥ | شغّل الرد الآلي | الذكاء والرد الآلي مفعّلين **ومزوّد حقيقي بمفتاح فعلًا** (`getWorkspaceProvider` — فشل-مغلق، نفس منطق الاستوديو) | ✅ |

- `complete` = الخطوات **الإجبارية** خلصت (الموصى بها ما بتمنع). لما تكتمل البطاقة بتنطوي لشريط «النظام جاهز».
- ⚠️ «مزوّد بمفتاح» = **وجود** المفتاح والعنوان — بلا شبكة. ما بيتأكد إن المفتاح صالح أو إن الخدمة شغّالة (هاد فحص «الاستوديو» الحي). 🔧 الخطوة بتأشّر على `/settings/ai` حيث بيظهر الفحص.
- قراءة بس: ما بتعمل `upsert` لإعدادات الذكاء (الاستوديو بيعمل). محصورة بالمساحة. الرد أعلام منطقية بلا أرقام ولا أسماء ولا معرّفات.
- محصورة بـ `settings.manage` (المالك/المدير). `SALES_AGENT` و`VIEWER` ما بيشوفوها — الواجهة بتخفيها عند 403 بصمت.

**التحقق:** `tests/setup-progress.test.ts` — ٢٦ اختبار: كل إشارة (متصلة/منفصلة/خطأ · فعّال/معطّل/مؤرشف · مزوّد تجريبي/بلا مفتاح/بمفتاح · مطفّي) · الإجبارية مقابل الموصى بها · الترتيب · العزل بين المساحات · القراءة-فقط · شكل الرد · العرض (خطوة وحدة `aria-current=step` · «اختياري» · شريط التقدّم).

### ٣. الشرح جوّا كل صفحة

⚠️ **قبل:** ولا شرح بكل الموقع — «الكتالوجات» و«مختبر التجميع» ما فيهم ولا كلمة بتقول شو بيعملوا ولا شو بعدهم.

🔧 **`lib/page-guides.ts`:** لكل صفحة بالقائمة (٢٦) سطرين «شو هاي الصفحة؟» + نصيحة اختيارية + **«الخطوة الجاية»** برابط. بيظهروا **أول زيارة لكل صفحة بس** (بعدها مطويين، وزر «؟» بالشريط العلوي بيفتحهم، وEsc بيسكّرهم) — فالخبير ما بيشوفهم كل مرة، والجديد بيشوفهم بشكل طبيعي.

- «الخطوة الجاية» بتتبع نفس ترتيب بطاقة «ابدأ من هون» (قنوات ← منتجات ← شخصية ← تجربة ← ضبط) — الدليل والبطاقة بيحكوا نفس القصة، والاختبار بيفرضه.
- ما بتظهر الخطوة الجاية إذا العضو ما عنده صلاحية للصفحة (بدل ما يوصل لـ ٤٠٣).
- صندوق الوارد (شاشة كاملة بارتفاع محسوب): الشرح طبقة فوق المحتوى (overlay) ولا بيفتح لحاله — لوحة بتدفع المحتوى كانت رح تخرّب أعمدته الثلاثة.
- الرأس + شريط التبويبات صاروا **ثابتين مع التمرير** (غلاف `sticky` واحد) — صفحة طويلة ما بتضيّع التنقل.
- ⚠️ لقطت **خلل بالتطوير** بالفحص الحي: React (StrictMode) بيشغّل الأثر مرتين والمرة التانية بتشوف الصفحة «مزارة» فبتسكّر الشرح الي لسا انفتح. 🔧 مرجع `handledGuide` بيمنع إعادة المعالجة (الإنتاج ما كان متأثر بس الكود كان هشّ).
- التخزين محلي (`zr-guide-seen`) — تالف أو محجوب (وضع خاص) ما بيكسر شي، والقائمة محدودة بـ ٢٠٠.

**التحقق:** `tests/page-guides.test.ts` — كل صفحة بالقائمة إلها شرح (صفحة جديدة بلا شرح = فشل) · قصير وواضح · **ولا «Hermes» بأي نص مرئي** · كل خطوة جاية بتأشّر على صفحة حقيقية · ولا طريق مسدود · سلسلة الدليل = سلسلة البطاقة · `visitGuide` (أول مرة/ثاني مرة/صندوق الوارد/تخزين تالف/حد الطول) · اللوحة (محتوى · a11y · الخطوة الجاية بتختفي بلا صلاحية · overlay) · ربط القشرة.

### ٤. بنية الثيمات + إصلاح الوضع الداكن

⚠️ **العيب (من #26، لقطته بالفحص الحي):** `primary` و`brand-*` كانت ألوان **hex ثابتة** بـ `tailwind.config.ts` — فأي ثيم ما كان قادر يبدّلها، و`--primary*` بـ `.dark` كانت **متغيّرات ميتة** (ما حدا بيقراها). النتيجة بالوضع الداكن: `bg-primary-soft` ضل #ebf3fc → بند القائمة النشط **مستطيل أبيض بنص باهت**، وكل «شريحة أيقونة» (`bg-primary-soft text-primary`، ١٢ مكان) فاتحة فاقعة على واجهة داكنة.

🔧 **الحل:**
- `primary` · `primary-hover` · `primary-soft` · `brand-50…950` · `accent` · `showcase` صاروا `rgb(var(--…) / <alpha-value>)`. **قيم الثيم الافتراضي = الـhex القديم بالحرف** (الاختبار بيقارنها) → ولا بكسل بيتغيّر بالفاتح.
- ٣ أدوار منفصلة (لأن بالداكن التعبئة بتضل غامقة والنص لازم يصير فاتح): `--primary` تعبئة (أزرار) · `--primary-fg` نص/أيقونة على السطح (`text-primary` صار بيقراه) · `--primary-soft` خلفية خفيفة.
- الداكن: `--primary-soft` غامق (`15 44 71`) و`--primary-fg` فاتح — شريحة الأيقونة والبند النشط مقروئين. تعبئة الأزرار بالداكن ما اتغيّرت.
- `showcase` (لوحة الدخول، كانت `bg-[…]` ثابت) · الظلال `--shadow-card`/`--shadow-pop` (الثيمات بتبدّلها).

**نظام الثيمات** (`lib/theme.ts`): الثيم (`data-theme`) مستقل عن المظهر (`.dark`). `resolveTheme` + `THEME_INIT_SCRIPT` (قبل أول رسم — بلا وميض) مبنيين من نفس جدول `THEMES`، والاختبار بيشغّل السكربت الحقيقي بـ `vm` ويقارنه بالدالة على كل التركيبات. ثيم ليلي بطبيعته بيفرض الداكن **بلا ما يكتب اختيارك** (ترجع لاختيارك لما تبدّله). الحفظ بالجهاز (`localStorage`) — ولا ترحيل ولا عمود. منتقي بـ«حسابي» ← «المظهر» (بطاقة لكل ثيم بمعاينة ألوانه + فاتح/داكن).

⚠️ ملاحظة تطوير: تغيير `tailwind.config.ts` ما بيلتقطه `next dev` — لازم إعادة تشغيله (و`rm -rf .next`) وإلا CSS القديم بيضل.
⚠️ رقم خطوة بطاقة «ابدأ من هون» ما كان متمركز: صنف `.num` (`display:inline-block`) بيطغى على `flex`. 🔧 الرقم صار بـ`<span class="num">` جوّا الدائرة.

**التحقق:** `tests/theme-system.test.ts` — `resolveTheme` (مفتاح تالف/مجهول → افتراضي · الأولوية) · السكربت = الدالة على كل التركيبات + تخزين محجوب · `applyTheme`/`applyScheme` · `tailwind.config` بلا hex · سلّم brand الافتراضي = القديم بالحرف · **انحدار الداكن** (الخلفية الخفيفة غامقة والنص مقروء عليها) · **تباين كل ثيم × مظهر** (الثيم الجديد لازم يعدّي) · المنتقي.

### ٥. الثيم «إسلامي» + لوجو جديد + رسمات الدخول والترحيب

- **الثيم** (`THEMES` + `globals.css`): الفاتح عاجي وزمرّدي (`#0f5132`)، والداكن كحلي وذهبي. الذهبي (`--accent`) للخطوط والزخارف بس؛ النص من `--accent-fg`/`--primary-fg`. خط العناوين كوفي (Reem Kufi) بـ`preload: false` — الافتراضي ما بيدفع بايت.
- **زخارف SVG** (`public/brand/ornaments`): بلاطة گره 80px (خلفية الصفحة 5.5%) · نجمة ثمانية (فاصل تحت كل عنوان صفحة) · أقواس مدبّبة (أعلى القائمة). كلها `mask` + لون من المتغيّرات.
- **القائمة وبطاقة الترحيب**: نطاقات داكنة (زمرّد) بالمظهرين — المتغيّرات معاد تعريفها جوّا النطاق بس، والتباين مفحوص (`scopedPalette`).
- **رسمات GPT** (`public/brand/themes`، من ملف البرومبتات): `islamic-login` (3:4 · 35 ك.ب) خلفية لوحة الدخول، `islamic-hero` (شريط 4:1 مقصوص من 16:9 · 13 ك.ب) لبطاقة الترحيب. ⚠️ النص الأبيض بينحط فوق الرسمة — أول قياس عند 1024×768 طلّع وصف البند التالت **3.3:1**. 🔧 غلاف داكن بطبقتين فوق الصورة (عمودي + من جهة النص)، والمحتوى بيطلع لفوق على السما الهادية. **المقاس بعد التصليح** (أدنى 5% من البكسلات): الدخول عند 1024×768 · 1440×900 · 1920×1080 كله ≥ 4.5:1 (أضعف نص صغير 4.9)، وبطاقة الترحيب: العنوان 13.4 · الوصف 8.5.
- **لوجو جديد**: فقاعة محادثة والحرف Z مفرّغ منها (مسار `evenodd` واحد) بدل Z على بلاطة. شكل البلاطة بالثيم: مربّع مدوّر (افتراضي) · نجمة ثمانية (إسلامي). `app/icon.svg` بنفس المسار والاختبار بيمنع الانحراف.
- ⚠️ مولّد صور المالك **ما بيدعم 3:2** (رفض البرومبتات الأولى). 🔧 صارت 3:4 للدخول و16:9 للشريطين (محفوظة بالسكيل مع القاعدة).
- ⚠️ الأقنعة السودا الستة (شكلها للـOMS) انبعتت لهالجلسة بالغلط: ما انستعملت ولا انحفظت بالريبو.

**التحقق:** `tests/theme-system.test.ts` — نطاقات القائمة والبطاقة · كل `/brand/…` بالـCSS موجود · المقابض بالمكوّنات · الخط بلا preload · نسبة الرسمات وحجمها (< 150 ك.ب) · الغلاف فوق الصورة · `tests/brand-logo.test.ts`.

### ٦. ثيم «المدينة الليلية»

- ليلي دائمًا (`forcesDark`): كتلة وحدة `[data-theme="night"]` فوق `.dark`. زر فاتح/داكن بيتعطّل مع سبب (المنتقي والشريط العلوي)، واختيارك المحفوظ ما بينلمس — لما تبدّل لثيم تاني بترجع له.
- الألوان: بنفسجي غامق للأسطح · وردي للتعبئة (أبيض عليه ≥ 4.5) · سماوي للتمييز وحلقة التركيز · أصفر/برتقالي للشمس. الاختبار بيفرض التباين لكل الأدوار ولنطاق القائمة.
- **أصلي 100%**: أفق المدينة SVG مولَّد بـseed ثابت (`ornaments/night-skyline.svg` — ثابت بأسفل الشاشة بشفافية)، لوجو شمس بخطوط أفقية، شريط نيون أعلى القائمة وخط تحت عنوان كل صفحة بعنوان متدرّج، خط Lalezar بـ`preload: false`. ⚠️ ولا GTA ولا Rockstar ولا لقطة لعبة ولا ماركة (قرار المالك بعد ما انرفضت الصور الحقيقية: حقوق نشر).
- **رسمات GPT**: `night-login` (3:4) و`night-hero` (شريط 4:1). ⚠️ الشمس طلعت عاليمين — يعني تحت النص الأبيض بـRTL. 🔧 الرسمة بتنعكس أفقيًا بـCSS (`::before` بطبقة −2) والغلاف الداكن `::after` (−1) بـ٣ طبقات، و`isolation: isolate` عشان الطبقتين تضلّوا فوق خلفية اللوحة.
- **التباين فوق الرسمات** (أدنى 5% من البكسلات، نص أبيض): الدخول عند 1024×768 · 1440×900 · 1920×1080 كله ≥ 4.5:1 والبطاقة (العنوان 15.3 · الوصف 8.8). ⚠️ أول قياس عند 1024×768: سطر الفوتر **2.85:1** (انعكاسات النيون بأسفل الصورة). 🔧 طبقة غلاف سفلية → 5.55.

### ٧. الحالات الفاضية بتدلّ على الخطوة الجاية

⚠️ قبل: ٢٦ حالة فاضية من ٤٢ بلا أي زر — القائمة الفاضية كانت نهاية مسدودة («لا توجد متابعات» وبس)، والدليل بالقائمة بيحكي «شو بعد» وهي لأ. 🔧 هلأ كل قائمة فاضية **فعلية** (مش خطأ، ومش «اختر محادثة»، ومش الي بنفس الصفحة فوقها نموذج الإضافة) إلها خطوة: رابط `EmptyNext` (عملاء ← اربط قناة · تحويلات ← افتح الوارد · متابعات ← اضبط قاعدة أتمتة · طلبات ← افتح الوارد · تحليلات المنتجات ← شوف الطلبات · مختبر التجميع ← اربط صفحة) أو زر الإضافة (كتالوجات · آراء · فريق).

**فحص الجوال والحاسوب:** ٢٦ صفحة × 375px بالثيم الافتراضي، و٥ صفحات × (إسلامي · ليلي) بـ375px، والرئيسية والوارد بـ1280px بالثلاثة — **صفر تمرير أفقي** (الفحص بـ`scrollWidth − clientWidth`).

**التحقق:** `tests/empty-next.test.ts` — المكوّن · كل موقع بـ`action` · كل رابط `EmptyNext` بيأشّر على صفحة موجودة بالقائمة (بلا روابط ميتة).

### ٨. قفز سريع للصفحات من صندوق البحث

⚠️ قبل: صندوق البحث بالشريط العلوي كان بيبحث بالمحادثات بس — تكتب «طلبات» أو «زبون» ما بيصير شي، وتضطر تدوّر بالقائمة. 🔧 هلأ بيقترح الصفحات وإنت بتكتب (`lib/nav-search.ts`): عربي فصيح وعامي («زباين» · «اوردر» · «بضاعة» · «باسورد») وإنجليزي، بتطبيع الهمزات والتاء المربوطة والتشكيل. أسهم ↑↓ للتنقل · Enter للانتقال · **Enter بلا اختيار = بحث المحادثات زي ما كان** · Escape يسكّر · اختصار «/» أو Ctrl+K يفتح الصندوق (إلا وإنت بتكتب بحقل).

- بيشتغل على **الصفحات المسموحة للعضو بس** (`visibleGroups`) — ما بيدلّك على صفحة ممنوعة عليك.
- كل صفحة بالقائمة لازم إلها كلمات بديلة بـ`PAGE_KEYWORDS` — `tests/nav-search.test.ts` بيفشل لو صفحة جديدة ما انضافت (وإلا ما بتنلاقى).
- combobox بـ`aria-activedescendant` وlistbox، وبالثيمين بياخد ألوان الثيم.

**التحقق:** `tests/nav-search.test.ts` (٢٢ اختبار: التطبيع · ترتيب النتائج لـ١٥ استعلام · AND بين الكلمات · الصلاحيات · تغطية كل صفحة · بنية الصندوق) + جرّبته حيًا (/ ← «زبون» ← ↓ ← Enter ← /customers).

### ٩. إصلاح: خطوط عناوين الثيمين ما كانت تشتغل

⚠️ **العيب** (لقطته بفحص النسخة المبنية على 3000، مش بالاختبارات): `--font-display` كان معرّف ببلوكات الثيم، يعني على `<html>`، وبيرجع لـ`var(--font-reem)` — بس متغيّرات next/font (`--font-reem` · `--font-lalezar`) بتنحط كصنف على `<body>` فما بتنشاف من `html`. النتيجة: المتغيّر بيصير غير صالح وقت الحساب وبيرجع الخط العادي **بصمت** — عناوين الثيمين (كوفي للإسلامي، عريض لليلي) ما اتغيّروا ولا مرة. 🔧 صار `--font-display` معرّف على `body` (`[data-theme="…"] body`)، وجرّبته حيًا: العنوان بـReem Kufi بالإسلامي وLalezar بالليلي والخطين اتحمّلوا. `tests/theme-system.test.ts` بيفرض المكان (بلوكات الثيم ما بتعرّفه، والمتغيّرات على `body` بـlayout).

### ١٠. زر إظهار كلمة السر

⚠️ **قبل:** كل حقل سري كان `<Input type="password">` خام — ما في طريقة تتأكد إنك كتبته صح (وعالجوال أصعب)، فالغلطة بتبان بس لما الدخول يترفض.

🔧 **هلأ:** مكوّن واحد `PasswordInput` (`src/components/ui/password-input.tsx`): عين بنهاية الحقل بتبدّل بين المخفي والظاهر. اتركّب بالحقول الثمانية: الدخول وإنشاء الحساب · كلمة المرور بصفحة الحساب (٣) · مفتاح المزوّد المخصص · توكنات القنوات (٣). للمفاتيح والتوكنات `kind="secret"` (نص الزر «القيمة» مش «كلمة المرور»).

- العين بنهاية الحقل حسب اتجاهه (`dir`): الحقول `ltr` فالعين باليمين ولا بتغطّي النص. إيدج عنده عين خاصة فيه — مخفية (`-ms-reveal`) عشان ما تطلع عينين.
- الماوس ما بيسرق التركيز من الحقل (بتكمّل كتابة)، والكيبورد: Tab للزر وEnter. الزر `type="button"` — ما بيرسل الفورم.
- لون الأيقونة من متغيّرات الثيم (`text-ink-muted`). تباينها فوق الحقل وهي ساكنة: 6.2 (افتراضي فاتح) · 9.0 (افتراضي داكن) · 8.1 (إسلامي فاتح) · 7.9 (إسلامي داكن) · 9.5 (ليلي).
- حقول كلمة السر اليدوية بصفحة الفريق (إنشاء عضو · إعادة تعيين) نص ظاهر عن قصد — المدير بيشوف الكلمة وبيعطيها للموظف.

**التحقق:** `tests/password-input.test.ts` (١٢ اختبار: النوع ونص الزر · الشكل الأولي · الخصائص بتمرّ · اتجاه الغلاف · حارس إنه ما حدا يكتب `type="password"` خام). وبالمتصفح (نسخة 3010): الضغطة بتبدّل النوع والتركيز بيضل بالحقل · Tab ثم Enter بيشتغلوا من غير ما يرسلوا الفورم · 375px بلا تمرير أفقي · الأيقونة بنص الحقل بالضبط.
