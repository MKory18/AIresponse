# Zaki response — سيستم 7 (نظام الردود)

منصة ردود ومبيعات متعددة المستأجرين (Next.js 14 App Router · RTL · Prisma/Postgres · zod · Vitest) — جزء من منظومة Zaki:
الـ OMS · الميديا باير · الكليبر · المالية · سيستم 1 · الأزمات · المهام · مساحة العمل · جسر Hermes.
المراحل P0–P12 موثّقة بـ `docs/PROGRESS.md`. الربط مع المنظومة وباب Hermes: `docs/INTEGRATIONS.md` (المرجع الأول). باب الـ OMS القادم + برومبت GLM: `docs/OMS-DOOR-V1.md`.

## قواعد المالك (إلزامية بكل جلسة)

- **الرد على المالك بالعربي (أردني)** — نتيجة مباشرة بلا شرح خطوات داخلية. المالك مش مبرمج.
- **أي خطر أو شي مؤتمت = أحمر مع ملاحظة، والتصحيح تحته بالبرتقالي — ما منلغي الميزة، منعلّمها.**
  بالواجهة: `RiskNote` + `FixNote` (أو `RiskWithFix`) من `src/components/integrations/ui.tsx`. بالتوثيق: ⚠️ للأحمر و🔧 للتصحيح.
- **ما تعيد بناء شي موجود بيأدي الوظيفة** — عدّل · وسّع · طوّر. قبل أي إضافة: دوّر بالكود عن الموجود.
- ولا بيانات زبون (اسم · رقم · عنوان) لموديل خارجي · توكن الإعلانات ما بيوصل لأي موديل · ولا اعتماد مالي من تيليجرام.
- تواصل B2B: لا أسعار ولا كلمة «package». اللوحات والتقارير: بلا ضرائب، وكل مؤشر معه قاعدة احتسابه.
- المخرجات المكتوبة للمالك: .docx + PDF (بيقرأ عالجوال).
- كل تغيير: اختبار بيفشل قبل التصليح وبينجح بعده · بلا كسر سلوك موجود (الاختبارات القديمة لازم تضل خضرا).

## البوابات (قبل أي commit)

```bash
npm run typecheck
npm run lint
npm test                 # Vitest على قاعدة بالذاكرة (tests/helpers/inmemory-db.ts) — ما بيحتاج Postgres
npm run scan:secrets
npm run build
```

- ببيئة معزولة بلا محرك Prisma: خطأ `PrismaClientInitializationError` واحد لكل ملف اختبار متوقع وغير مؤثر — شغّل `npx vitest run --dangerouslyIgnoreUnhandledErrors` وتأكد ما في أي خطأ غيره.
- `tests/setup.ts` بيثبّت DNS وهمي عام (ولا شبكة بالاختبارات)؛ اختبارات الـ DNS بتركّب محلّلها بـ `setIntegrationDnsLookup`.
- تعديل `prisma/schema.prisma` = ترحيل إضافي بس (لا حذف ولا تغيير نوع) + فحص الانجراف.

## خريطة الربط (P12)

| المجال | الملفات |
|---|---|
| سجل الأنظمة والاتصالات | `src/modules/integrations/systems.ts` · `connections.ts` (أسرار مشفّرة · فحص الرابط مع DNS) |
| صندوق الصادر الموقّع | `integrations/outbox.ts` — مفتاح عدم التكرار `مساحة:نظام:نوع:مفتاح` · الرابط من الاتصال الحالي لحظة الإرسال |
| حارس البيانات | `integrations/pii-guard.ts` — صيغ المراجع المعروفة · الروابط بعد شيل cuid |
| الكليبر · القدرة · الامتثال · الإشارات | `clipper.ts` · `capacity.ts` · `compliance.ts` · `ops-signals.ts` · `scheduler.ts` |
| الإسناد والموافقة | `attribution.ts` (حلقات · «بداية المحادثة بتحكم») · `consent.ts` |
| الـ OMS | `src/modules/oms/` — `app-webhook.ts` (أحداث التطبيقات الحقيقية) · `manual.ts` (نص الإدخال + الربط) · `handoff.ts` · `auto-handoff.ts` (8 محاولات + كنس ساعي) · `client.ts` (legacy · v1) |
| باب الوكلاء (Hermes) | `src/modules/agent-door/` — `tools.ts` (11 أداة · مخططات حرفية) · `door.ts` · `drafts.ts` · `status.ts` |
| المسارات | `/api/v1/*` (القدرة · حملات الكليبر · أحداث الأنظمة) · `/api/agent/tools` · `/api/agent/call` · `/api/webhooks/oms/[key]` · `/api/integrations/*` |
| الواجهة | `settings/integrations` · `settings/agents` · بطاقة الـ OMS بصفحة الطلب · تبويب الامتثال بالمنتج · بطاقة الموافقة بالمحادثة |

## ثوابت ما بتنكسر

- الـ OMS الحقيقي (`MKory18/Zaki-ai-CRM`) **ما فيه باب استقبال من نظام تاني** — الوضع اليدوي شغّال اليوم. أحداثه: `sha256=` HMAC على `ts.body` (ts بالميلي ثانية) · رقم الطلب `SY-2026-0148` · `total`/`currency` بالحمولة.
- ربط يدوي بالرقم ما بيكمل إلا إذا الحدث طابق (العملة · المجموع · الوقت). عدم تكرار أحداث الـ OMS من الجسم الموقّع (`event:orderId:at`) مش من `X-Zaki-Delivery`.
- عقد agent-door/v1 حرفي: `additionalProperties:false` بكل كائن · nullable بـ `anyOf` · بلا `format` · tuple بحدود zod — `tests/p12-agent-door.test.ts` بيحرسه.
- أي مفتاح عدم تكرار جديد (صادر · مهام · مراجع لأنظمة تانية) **لازم فيه المساحة** (أو وسم `opaqueTag`).
- `ctwaClidEnc` و`psidEnc` ما بيطلعوا بأي رد API (`withoutClickSecrets`).
- عدم تكرار الإرسال: SENT · DELIVERED · READ نهائية لنفس المفتاح.

## المعلّق

- رفع الفرع `feat/p12-zaki-ecosystem` لـ GitHub وفتح PR (لو لسا) — بيحتاج تطبيق Claude على الريبو.
- باب `/api/v1` بالـ OMS (برومبت GLM جاهز بـ `docs/OMS-DOOR-V1.md`) ← بعده بالإعدادات: «API · v1» + توكن.
- ⚠️ `OPENROUTER_API_KEY` ببيئة الـ OMS بيبعت نص الزبون لموديل خارجي — 🔧 لازم ينشال من هناك.
- تحقق حي مع الأنظمة بعد النشر (روابط وتوكنات حقيقية) · سيستم 6 (الأزمات) غير مبني · وسائط واتساب الواردة · مدة احتفاظ `WebhookEvent.payload`.
