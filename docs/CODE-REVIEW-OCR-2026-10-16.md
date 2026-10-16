# فحص المشروع كامل — OpenCodeReview (ocr v1.13.0)

- **التاريخ:** 2026-10-16 · **الفرع:** `revert/openai-base-url`
- **النطاق:** المشروع كامل — 403 ملف إنتاجي في `src/` + إعدادات + سكربتات + عقود
- **الطريقة:** وضع التفويض (Delegation Mode) — 6 وكلاء مراجعة بالتوازي حسب قواعد الأداة، والمواضع الخطيرة تثبتت يدويًا بالكود
- ⚠️ الفحص بدون LLM خارجي — ولا بيانات زبائن ترحّل لأي موديل (إلزام قواعد المشروع). مع مفتاح مزوّد في `.env` ينفع `ocr scan` مستقلًا كاملًا

## الحصيلة

| الفئة | العدد |
|---|---|
| HIGH | 10 |
| MEDIUM | ~60 |
| LOW | ~70 |

> 1372 اختبارًا يمرون والـ CI أخضر — ومع ذلك #9 مكروك: اختبارات الواجهة هي الفجوة الأولى.

---

## ⚠️ HIGH — مثبتة يدويًا

1. **توقيع ويب هوك الـ OMS يقبل تزييفًا بالوضع اليدوي.**
   `src/app/api/webhooks/oms/route.ts:57` · `src/modules/oms/connection.ts:18,162`
   التحقق من `decryptSecret(conn.tokenEncrypted)`. الوضع اليدوي بلا توكن بيتخزن له ثابت معلوم بالكود: `__oms_no_token__`.
   🔧 التوقيع من `webhookSecretEncrypted` + رفض المسار القديم إذا `mode==="manual"` أو التوكن علامة مؤقتة.

2. **مفتاح المنصة الجماعي يرحّل لعنوان مخصص.**
   `src/modules/ai/router.ts:382-391` — `customBaseUrl` مع `openai/openrouter` يلحّق `OPENAI_API_KEY`/`OPENROUTER_API_KEY` المنصّي Bearer لعنوان خارجي عام (الحرس يمنع LAN فقط).
   🔧 منع المزج — مفتاح لكل مساحة أو رفض التركيبة · فحص `validateEndpointUrl` لحظة الحسم (`:361`).

3. **النص الحر لرسالة الزبون يمرّ للمزوّد الخارجي.**
   `src/modules/ai/stages/extraction.ts:110` · `stages/response.ts:177` — بوابة `privacy-gate.ts` تخفي الـ PII المعلن فقط.
   🔧 قرار مالك: إن كان الممنوع — حجز المراحل على LOCAL/الوكيل الذكي فقط.

4. **الـ Embeddings: نص غير مغسل لأبعاد OpenAI.**
   `src/modules/knowledge/embeddings.ts:74-87` — `scrubForEmbedding` يجرد هاتف/بريد فقط، أسماء/عناوين/نص حر يتشيرل كاملة.
   🔧 تجريد أعم أو حجب المزوّد الخارجي من الفهرسة.

5. **Worker يتجمد كليًا مع مهمة واحدة.**
   `scripts/worker.ts:52` — لا timeout لكل handler.
   🔧 `JOB_TIMEOUT_MS` + تحرير.

6. **حساب المبالغ بالفواصل العائمة.**
   `src/modules/orders/pricing.ts:32-46` — `Number(price)*qty` بلا Decimal قرشي.
   🔧 حساب بالقرش + تقريب مفرد قبل التخزين.

7. **وسائط الزبون الواردة تدخل سياق الذكاء/الكاتولج.**
   `src/modules/catalog/service.ts:308-320` — استعلام `mediaAsset`+`productMedia` بدون `excludeCustomerInbound()` · إلحاق وسائط المنتج بلا فحص فئة `CUSTOMER_INBOUND`.
   🔧 إلحاق الحارس + فحص الفئة عند الإلحاق.

8. **رسالة واردة فاشلة تكبت الدفعة أيضاً.**
   `src/modules/channels/inbound-job.ts:96-99` — `{success:true}` لو نجحت رسالة واحدة: الفاشلة ما تتدارك (`DUPLICATE` بإعادة التسليم).
   🔧 `{success:false}` كلما `failed>0`.

9. **مساعد البيع (Coach) معطّل من الواجهة.**
   `src/components/inbox/inbox.tsx:393` — `fetch POST` بلا body · المسار يطلب `z.object().strict()` → `INVALID_BODY` دائمًا.
   🔧 إرسال `body:"{}"` أو تعديل السكيمة.

10. **تصعيد صلاحيات الأعضاء بلا فحص رتبة.**
    `src/modules/members/service.ts:21-28,239` — `users.manage` يرفع OWNER جديد/يعزل OWNER قائم (الفحص الوحيد self-edit).
    🔧 فحص الرتبة قبل أي تغيير.

---

## 🟠 MEDIUM — مختارات

**أمن/صلاحيات**
- Request routing من `x-forwarded-for`: خداع العميل يفتح براكس محكم — `src/core/api/handler.ts:59`
- سقف الطلب 110MB عبر `content-length` بس — `handler.ts:80`
- سجلات الأخطاء بـ `req.url` الكامل (بحث العملاء) — `handler.ts:129,136` → سجل `pathname` فقط
- register بدون `$transaction` — `api/auth/register/route.ts:17-22` → حساب معطلة عند فشل المسار
- Telegram/TikTok secrets plaintext في DB metadata — `connect.ts:135` · `tiktok/webhook.ts:45`
- `JOBS_SECRET` مقارنة `!==` — `api/jobs/run/route.ts:19-23` → `timingSafeEqual`
- `users.manage` يعرض بناء role بدون تحقق — bcrypt waiting dummy

**Race**
- `transitionOrder`/الـ idempotency بلا `$transaction` كلها — `orders/order-service.ts:97-161,287-293`
- outbound claim غير atomically — `outbound.ts:181-216` · resolver خارج try — `:686-692`
- نافذة `WebhookEvent.create→enqueueJob` على كل القنوات — `facebook/webhook.ts:73-91`
- takeover/release/claim بلا claim تحقق — `threads.ts:605-631` · `handoff-service.ts:90-135`
- campaign-runner rate window read-modify-write — `campaign-runner.ts:149-167`
- private reply تبعد الGraphизай قبل النجاح — `facebook/comments.ts:101-118` · `instagram/comments.ts:90-107`
- workspace slug race — `workspaces/service.ts:21-25`

**أداء**
- إحصاءات بالذاكرة على 92 يوم بدل SQL aggregation — `src/modules/analytics/service.ts` + طرات
- agent-door: 100k صف بالذاكرة (metrics.ts:51-64,227-239) — groupBy SQL
- sync OMS: حتى 500 HTTP متسلسل — `oms/sync.ts:195`
- rate-limit rows لا تفرغ أبدًا — `rate-limit.ts:57-64` → كنس ساعي
- clipper: `Math.min` Processor RangeError (clipper.ts:501)
- knowledge: pdf-parse bomb + الحجم بعد ما يلتحم بالذاكرة (`extract.ts:10-12`, upload)
- sync 5000 منتج ما تجمّع — `sync.ts:124`

**عقد/قواعد**
- «مسودات Hermes» بنص أداة — `agent-door/tools.ts:760` → «مسودات الوكيل الذكي»
- معايد manual-number: تسامح 30% بالأجمالي — `oms/app-webhook.ts:112`
- auto-handoff أوcodes definitive قليلة — `auto-handoff.ts:133`
- integrations/oms: `(db as any)` متكرر — `handoff.ts:55` + هام
- `OmsWorkspaceMismatchError` مسرAA — `oms/webhook.ts:149`
- PII guard: أرقام بست `*_id` مراجع قا load — `pii-guard.ts:69,87`
- `Idempotency-Key` نفس ال Body حفظ — `clipper.ts:388`

**HTTP/Routes**
- `api/faqs/route.ts:16-23` — PATCH مكرر على المجموعة؛ `params.id` ما يوجد → 500
- `api/handoffs/[id]/route.ts:14` — `resolve` بفحص `handoffs.claim` — يجب `handoffs.resolve`
- `core/analytics/time.ts:66-70` — أخطاء التواريخ Error عادي → 500 بدل 422 + فرز start>end
- `hourCycle h23` بدل `hour12:false` — يجب شرع AGENTS.md (elements 24:00)
- استعلام `analytics/page.tsx:126` + loadDraft بلا `AbortController`

---

## 🟡 LOW — نموذج

- CSP `unsafe-inline` في الإنتاج (`next.config.mjs:19`)
- Dockerfile: `npm ci || npm install` يلغِ الsame · postgres 5432 مكشوف بكلمة `postgres/postgres` (`docker-compose.yml:34-42`)
- `masking.ts` ياتراقم (tests فقط` — حذف أو test-only
- `defaultAssignToSelf` و `CONFIRMING` وت `AUTOMATION_TRIGGERS` المخلّمة ميتة
- Login time-time enumeration — dummy bcrypt
- rate-limit memoryBuckets يتفرغ — `rate-limit.ts:41`
- بدرة 100 no cursor — `catalog/service.ts:52-56` · `providers listings too`
- JWT بالخ تسpio لا العاكس — `session.ts:28` · SESSION route عروض لا revocation
- شرطة Aws المسموعة: `masking.ts` LIVE university — flush per its pills
- spa PhP: العرض والقاموس أيل두 الخرق البري جدا他们对)— передач ن Тип

## ملفات نظيفة (فحصت وسليمة)

- `src/core/crypto.ts` — HMAC/AES-256-GCM بتوقيت ثابت + IV عشوائي
- `src/modules/media/storage.ts` — path-traversal + magic bytes سليمة · توكن الوسائط العامة موقع
- تصدير CSV — حارس formula injection + سقف + audit + صلاحية
- createHandler + كل المسارات — workspaceId من `auth.workspaceId` بلا IDOR، والـ `getOwned` محفوظ
- تسعير الطلبات من DB — بلا مجاميع موثوقة من العميل
- وحدة التوين والسلسلة — بلا، `=` للنص الحر ما سفرا

## خطة التصليح

1. الخط 1: HIGH (10) — أمان الدولة
2. الخط 2: MEDIUM أمني (an race/allowed) — A11 race بالق block
3. الخط 3: MEDIUM أث — SQL groupBy + rate-limit cleanup
4. الخط 4: LOW + code hygiene

قواعد الإيقاع: كل تصليح على فرع مع اختبار فاشل→نجاح · CI أخضر قبل الدمج · ولا كسر سلوك موجود.

## المعدات

- الأداة: `npm install -g @alibaba-group/open-code-review` → `ocr` v1.13.0
- تشغيل: `ocr delegate rule src ...` (بدون LLM خارجي) + 6 وكلاء + تحقق يدوي
- التقرير الكامل: هذا الملف · التثبيت: بالخطير فوق
