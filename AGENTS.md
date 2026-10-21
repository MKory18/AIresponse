# Zaki response — سيستم 7 (نظام الردود) · قواعد الوكلاء

> **ملف القواعد الموحّد.** بيقرأه GLM (opencode) مباشرة، وClaude Code عن طريق `CLAUDE.md` (`@AGENTS.md`).
> أي قاعدة جديدة بتنكتب هون بس — ولا قاعدة بملف تاني.

منصة ردود ومبيعات متعددة المستأجرين (Next.js 14 App Router · RTL · Prisma/Postgres · zod · Vitest) — جزء من منظومة Zaki:
الـ OMS · الميديا باير · الكليبر · المالية · سيستم 1 · الأزمات · المهام · مساحة العمل · جسر Hermes.
المراحل P0–P12 موثّقة بـ `docs/PROGRESS.md`. الربط مع المنظومة وباب Hermes: `docs/INTEGRATIONS.md` (المرجع الأول).
العقود بين الأنظمة: `contracts/` · باب الـ OMS القادم + برومبت GLM: `docs/OMS-DOOR-V1.md`.

## قواعد المالك (إلزامية بكل جلسة)

- **الرد على المالك بالعربي (أردني)** — نتيجة مباشرة بلا شرح خطوات داخلية. المالك مش مبرمج.
- **أي خطر أو شي مؤتمت = أحمر مع ملاحظة، والتصحيح تحته بالبرتقالي — ما منلغي الميزة، منعلّمها.**
  بالواجهة: `RiskNote` + `FixNote` (أو `RiskWithFix`) من `src/components/integrations/ui.tsx`. بالتوثيق: ⚠️ للأحمر و🔧 للتصحيح.
- **ما تعيد بناء شي موجود بيأدي الوظيفة** — عدّل · وسّع · طوّر. قبل أي إضافة: دوّر بالكود عن الموجود.
- ولا بيانات زبون (اسم · رقم · عنوان) لموديل خارجي · توكن الإعلانات ما بيوصل لأي موديل · ولا اعتماد مالي من تيليجرام.
- تواصل B2B: لا أسعار ولا كلمة «package». اللوحات والتقارير: بلا ضرائب، وكل مؤشر معه قاعدة احتسابه.
- المخرجات المكتوبة للمالك: .docx + PDF (بيقرأ عالجوال).
- كل تغيير: اختبار بيفشل قبل التصليح وبينجح بعده · بلا كسر سلوك موجود (الاختبارات القديمة لازم تضل خضرا).

## آلية العمل (مين بيعمل شو)

1. **التخطيط** (الأفكار · التقسيم · المنطق): Claude (Opus) بمحادثة المالك.
2. **البناء:** GLM (opencode على سيرفرات المالك) — على **فرع جديد**، مش على `main`.
3. **الرفع:** فرع + طلب دمج (PR). **ممنوع الرفع المباشر على `main`.**
4. **الفحص التلقائي:** CI (`.github/workflows/ci.yml`) بيشتغل لحاله مع كل PR — typecheck · lint · test · secrets · build · ترحيل على Postgres حقيقي. أحمر = ممنوع الدمج.
5. **المراجعة والتطوير والربط:** Claude Code على نفس الفرع.
6. **الدمج:** بعد CI أخضر وشيك Claude — المبرمج نظرة أخيرة.

- ⚠️ وكيلين على نفس الريبو بنفس الوقت = تعارضات وشغل ضايع (صار فعلًا: `main` اتغيّر وفرع P12 مفتوح، والـ CI ما اشتغل على الطلب لأنه كان فيه تعارض — والـ CI على `main` ضل أحمر 5 مرات وما حدا انتبه).
  🔧 وكيل واحد لكل فرع · قبل أي شغل: `git fetch origin && git merge origin/main` · طلب دمج فيه تعارض ما بيشغّل CI أبدًا — حلّ التعارض أول · «أخضر عندي» ما بيكفي: الحكم للـ CI.

## منظومة Zaki — الريبوهات

| النظام | الريبو | الحالة | العلاقة مع سيستم 7 |
|---|---|---|---|
| سيستم 7 — الردود والمبيعات (هاد الريبو) | `MKory18/AIresponse` | شغّال | المحور: سجل الأنظمة · الصادر الموقّع · باب الوكلاء · `contracts/` |
| الـ OMS / CRM (salesflow) | `MKory18/Zaki-ai-CRM` | **الأصل الوحيد** · شغّال (Next 16 · Prisma 6 · Node 24) | بيبعت أحداث الطلبات الستة موقّعة (`contracts/oms-app-events.v1`) · سيستم 7 بيرحّل الطلبات يدويًا اليوم و`/api/v1` لما ينبني |
| نسخ الـ OMS | `MKory18/zaki-ai-OSM-1` · `iahmed30004000-wq/zaki-ai-OSM` | ⚠️ نسخ مطابقة | ولا شي |
| Hermes | برنامج وكيل مفتوح المصدر على سيرفر المالك (مش ريبو إلنا) | شغّال | باب الوكلاء agent-door/v1 + مزوّد ردود اختياري ⚠️ |
| الكليبر · مساحة العمل · سيستم 1 · المالية · المهام · الميديا باير · الأزمات | لسا ما انرفعوا | مخطط | العقد جاهز: `/api/v1/*` + الصادر الموقّع (`docs/INTEGRATIONS.md`) — أي نظام جديد بيلتزم فيه |

- ⚠️ 3 نسخ من الـ OMS بنفس الكود: إذا GLM رفع على نسخة وClaude طوّر على نسخة تانية بيصيروا مختلفين بصمت.
  🔧 الشغل بس على `MKory18/Zaki-ai-CRM` · النسخ احتياط للقراءة (أو أرشفة من إعدادات GitHub).
- ⚠️ الريبوهات عامة (Public): أي حدا بيقرأ الكود وطريقة التوقيع والربط.
  🔧 حوّلها Private من `Settings → General → Danger Zone → Change repository visibility` — تطبيق Claude بيضل واصل. (حماية `main` على ريبو Private بدها GitHub Pro.)

## المزامنة بين الريبوهات

- **أول كل جلسة:** `git fetch origin` ودمج `main` بفرعك.
- **قبل أي شغل بيلمس الـ OMS:** اسحب آخر نسخة من `MKory18/Zaki-ai-CRM` (قراءة) وقارن `src/lib/apps/events.ts` ونقاط الإطلاق التلاتة (`src/lib/public-order.ts` · `src/app/api/orders/[id]/confirmation/route.ts` · `src/app/api/orders/[id]/shipping/route.ts`) مع `contracts/oms-app-events.v1/` — أي فرق = ⚠️ للمالك قبل أي تعديل.
- **ريبو جديد بالمنظومة:** المالك بيبعت رابطه مرة وحدة ← بينضاف لجدول الريبوهات فوق.
- **تغيير بعقد:** حسب قواعد النسخ بـ `contracts/README.md` (v1 ما بينكسر · الأصل هون).

## البوابات (قبل أي commit)

```bash
npm run typecheck
npm run lint
npm test                 # Vitest على قاعدة بالذاكرة (tests/helpers/inmemory-db.ts) — ما بيحتاج Postgres
npm run scan:secrets
npm run build
```

- ببيئة معزولة بلا محرك Prisma: خطأ `PrismaClientInitializationError` واحد لكل ملف اختبار متوقع وغير مؤثر — شغّل `npx vitest run --dangerouslyIgnoreUnhandledErrors` وتأكد ما في أي خطأ غيره. بالـ CI ما في هالخطأ.
- الـ CI والإنتاج على **Node 22** (`Dockerfile` · `ci.yml` · `engines`). اختبار بيعتمد على تنسيق الوقت لازم يضل `hourCycle: "h23"` مش `hour12: false` — ثابتة بكل الإصدارات (Node 20 كان يطبع منتصف الليل «24:00:00»، والكود بـ `core/analytics/time.ts` بيحيّد الحالة صريح).
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
| المزوّد الخارجي (الوكيل الذكي) | `src/modules/ai/router.ts` (`isHermesSelected` · `isHermesPersonaMode`) · `stages/*` · `hermes-diagnostics.ts` — الشخصيات المحلية بتقود الصوت بكل مزوّد · ⚠️ بلا تحويل تلقائي للموظف على المسار الخارجي |
| وسائط القنوات الواردة | `src/modules/channels/whatsapp/media-download.ts` (معرّف ميتا ← رابط مؤقت ← بايتات ← مخزننا) · الصف من `channels/inbound-job.ts` بمفتاح `wa-media:مساحة:wamid` · الحذف بـ `media-retention.ts` |
| خصوصية وسيط الزبون | تصنيف `CUSTOMER_INBOUND` + `MediaAsset.messageId` · `excludeCustomerInbound()` بـ `media/service.ts` **لازم ينضاف لأي استعلام وسائط جديد** · الاسم معتم دايمًا |
| مدة الاحتفاظ بالحمولة الخام | `src/modules/channels/webhook-retention.ts` — كنس ساعي من المجدول · `WEBHOOK_PAYLOAD_RETENTION_DAYS` (30 · `0` مطفي) · الصف يبقى (عدم التكرار) |
| العقود | `contracts/` (الأصل) · `tests/contracts-*.test.ts` |
| المسارات | `/api/v1/*` (القدرة · حملات الكليبر · أحداث الأنظمة) · `/api/agent/tools` · `/api/agent/call` · `/api/webhooks/oms/[key]` · `/api/integrations/*` |
| الواجهة | `settings/integrations` · `settings/agents` · `settings/ai` · بطاقة الـ OMS بصفحة الطلب · تبويب الامتثال بالمنتج · بطاقة الموافقة بالمحادثة |
| التنقل | `src/lib/nav-model.ts` (مصدر الحقيقة: ٧ مجموعات + تبويباتها) · `components/app-sidebar.tsx` (المجموعات) · `components/group-tabs.tsx` (شريط التبويبات) · `components/nav-icons.ts` |
| الثيمات | `src/lib/theme.ts` (المفاتيح · `resolveTheme` · سكربت ما قبل الرسم) · `globals.css` (متغيّرات كل ثيم) · `tailwind.config.ts` (ألوان من `var(--…)`) · `components/theme-picker.tsx` (المنتقي بـ«حسابي») · `tests/theme-system.test.ts` |
| الدليل | `src/lib/page-guides.ts` (الشرح + الخطوة الجاية + `visitGuide` أول زيارة) · `components/page-guide.tsx` · `modules/setup/progress.ts` + `components/setup-checklist.tsx` (بطاقة «ابدأ من هون» من بيانات المساحة) |

## ثوابت ما بتنكسر

- الـ OMS الحقيقي **ما فيه باب استقبال من نظام تاني** — الوضع اليدوي شغّال اليوم. أحداثه: `sha256=` HMAC على `ts.body` (ts بالميلي ثانية) · رقم الطلب `SY-2026-0148` · `total`/`currency` بالحمولة — كله مثبّت بـ `contracts/oms-app-events.v1`.
- ربط يدوي بالرقم ما بيكمل إلا إذا الحدث طابق (العملة · المجموع · الوقت). عدم تكرار أحداث الـ OMS من الجسم الموقّع (`event:orderId:at`) مش من `X-Zaki-Delivery`.
- عقد agent-door/v1 حرفي: `additionalProperties:false` بكل كائن · nullable بـ `anyOf` · بلا `format` · tuple بحدود zod — `tests/p12-agent-door.test.ts` بيحرسه.
- أي مفتاح عدم تكرار جديد (صادر · مهام · مراجع لأنظمة تانية) **لازم فيه المساحة** (أو وسم `opaqueTag`).
- `ctwaClidEnc` و`psidEnc` ما بيطلعوا بأي رد API (`withoutClickSecrets`).
- **صفحة جديدة بلوحة التحكم لازم تنضاف لـ `NAV_GROUPS`** (`src/lib/nav-model.ts`) بمجموعتها ويصلاحيتها — وإلا `tests/nav-structure.test.ts` بيفشل («صفحة بلا مجموعة»). **ولا مسار بيتغيّر** عند إعادة التجميع: الروابط بالإشعارات والمفضلة وباب الوكلاء بتضل شغّالة.
- **ألوان الثيم من متغيّرات CSS بس** — ممنوع hex ثابت بـ `tailwind.config.ts` أو `bg-[#hex]` بمكوّن (الاختبار بيفشل): ثيم ما بيقدر يبدّل لون ثابت. **ثيم جديد** = `THEMES` بـ `theme.ts` + كتلة `[data-theme="…"]` بـ `globals.css` بكل الأدوار، و`tests/theme-system.test.ts` بيفرض التباين (نص ≥ 7:1 · مخفّف ≥ 4.5 · `text-primary` على السطح والشريحة ≥ 4.5 · أبيض على التعبئة ≥ 4.5). الثيم الافتراضي بيتفرض إنه = الألوان القديمة بالحرف.
- **وكل صفحة جديدة لازم إلها شرح** بـ `PAGE_GUIDES` (`src/lib/page-guides.ts`): «شو هاي الصفحة» + «الخطوة الجاية» بتأشّر على صفحة بالقائمة — `tests/page-guides.test.ts` بيفرضه. ولا «Hermes» بنص الشرح (قرار المالك: تسميات عامة).
- وسيط الزبون الوارد (`CUSTOMER_INBOUND`) مربوط برسالته بس: ممنوع يطلع بالمكتبة أو منتقي أو سياق ذكاء أو رابط عام، والاسم معتم — أي استعلام وسائط جديد لازم يمرّ من `excludeCustomerInbound()` (`tests/wa-media-privacy.test.ts` بيحرسه).
- عدم تكرار الإرسال: SENT · DELIVERED · READ نهائية لنفس المفتاح.
- قواعد سيستم 1 (المسموح · الممنوع) بتوصل لكل مسار بيكتب رد: كل المزوّدين · التجربة اليدوية (`tests/p12-merge-main.test.ts`).
- **ولا «Hermes» بأي نص مرئي بالموقع** (قرار المالك): تسميات عامة — «الوكيل الذكي» · «مزوّد الذكاء الاصطناعي». القيم الداخلية (`hermes` · `hermes-bridge` · `HERMES_*` · `hermes-agent`) والتعليقات والتوثيق والاختبارات بتضل — `tests/persona-management.test.ts` + `tests/p12-merge-main.test.ts` بيحرسوها.

## المعلّق

- طلب الدمج #1 (P12 + دمج وضع Hermes) — CI أخضر · بانتظار مراجعة المالك والدمج.
- باب `/api/v1` بالـ OMS (برومبت GLM جاهز بـ `docs/OMS-DOOR-V1.md`) ← بعده بالإعدادات: «API · v1» + توكن.
- ⚠️ إدخال الطلبات بالذكاء بالـ OMS (`src/app/api/orders/ai-intake/route.ts`) بيبعت نص الطلب كامل (اسم · رقم · عنوان) لـ OpenRouter وبموديل مجاني افتراضيًا، وبيتخطّى إعدادات الذكاء بالـ OMS نفسه.
  🔧 يمرّ عبر `aiChat` بإعدادات الـ OMS بمزوّد `LOCAL` (GLM على سيرفراتك) — أو شيل `OPENROUTER_API_KEY` من بيئة الـ OMS لحد ما ينصلح.
- ⚠️ الريبوهات عامة · 3 نسخ من الـ OMS — التصحيح فوق بجدول الريبوهات.
- تحقق حي مع الأنظمة بعد النشر (روابط وتوكنات حقيقية) · سيستم 6 (الأزمات) غير مبني.
