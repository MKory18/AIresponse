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
