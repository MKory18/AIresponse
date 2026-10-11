# باب `/api/v1` بالـ Zaki OMS لنظام الردود — المواصفة + برومبت GLM

> **ليش:** الـ OMS الحقيقي (`MKory18/Zaki-ai-CRM`) ما فيه باب استقبال من نظام تاني — كل `/api/*` بجلسة متصفح (`requireContext`)، والطالع بس أحداث «التطبيقات». لهيك نظام الردود شغّال اليوم **بالوضع اليدوي** (نص «إدخال الطلب بالذكاء» + ربط الرقم). هالباب بيخلّي الترحيل مباشر (زر أو تلقائي) بلا نسخ ولصق.
> **الردود جاهزة من هلأ:** عميل v1 بـ `src/modules/oms/client.ts` (`apiVersion: "v1"`) — بس تبدّل بالإعدادات لـ «API · v1» وتحط التوكن.
> ⚠️ **لحد ما ينبنى:** شاشة «إدخال الطلب بالذكاء» بتبعت النص لـ OpenRouter إذا `OPENROUTER_API_KEY` مضبوط — 🔧 شيله من بيئة الـ OMS (المحلّل الحتمي كافي لصيغتنا). **الباب الجديد ممنوع يمرّر أي نص لموديل.**

## 1. القواعد (نفس عقد المنظومة)

| البند | القيمة |
|---|---|
| المصادقة | `Authorization: Bearer <token>` — توكن لكل نظام بالشركة، SHA-256 بس بالقاعدة، صلاحيات مسماة، 90 يوم، إيقاف فوري |
| صلاحيات توكن الردود | `products.read` · `customers.lookup` · `orders.create` · `orders.read` · `orders.note` — ولا شي غيرها |
| الطلب | `X-Request-Id` (بيرجع بالرد) · `Idempotency-Key` لكل إنشاء |
| المبالغ | نص عشري بخانتين `"15.00"` |
| التواريخ | ISO 8601 بإزاحة المنطقة |
| الخطأ | `{"error":{"code","message","details"},"request_id"}` · 401 توكن · 403 صلاحية · 404 · 409 تعارض · 422 مدخلات · 429 حد · 500 |
| الحد | 60 طلب بالدقيقة للتوكن |
| ولا موديل | ولا مسار بالباب بيبعت نص لأي موديل ذكاء (داخلي أو خارجي) |

## 2. النقاط

### `GET /api/v1/products?for=replies&limit=100`
```json
{"items": [{"code": "TIN01", "name": "منتج الطنين", "price": "15.00", "currency": "USD",
  "wholesale_price": "11.00", "discount_cap": "10.00", "stock_status": "IN_STOCK",
  "offers": [{"title": "حبتين بـ 25", "quantity": 2, "price": "25.00", "saving": "5.00", "remaining_qty": null, "expires_at": null}],
  "complements": ["TIN02"]}]}
```
- المنتجات الفعّالة للشركة بس · السعر والعروض من الـ OMS نفسه (مصدر الحقيقة) · بلا تكلفة ولا مخزون رقمي حساس.

### `GET /api/v1/customers/lookup?phone=0936654998`
```json
{"exists": true, "blacklisted": false, "orders_count": 3, "total_value": "60.00"}
```
- تطبيع الرقم بنفس `normalizePhoneNumber` · `blacklisted` من `activeBlock` · **بلا اسم ولا عنوان بالرد** (الردود ما بتحتاجهم).

### `POST /api/v1/orders`
رؤوس: `Idempotency-Key: <مفتاح الطلب بالردود — ثابت لكل طلب>` · `X-Request-Id: rep_<orderNumber>`
```json
{"external_ref": "ORD-MG8K2J-X7Q", "source": "replies", "channel": "whatsapp",
 "customer": {"name": "أبو أحمد", "phone": "0936654998", "city": "حلب", "address": "الفرقان، جانب الجامع"},
 "items": [{"product_code": "TIN01", "name": "منتج الطنين", "quantity": 2, "unit_price": "15.00", "line_total": "30.00"}],
 "totals": {"subtotal": "30.00", "discount": "0.00", "delivery_fee": "3.00", "total": "33.00", "currency": "USD"},
 "notes": "…",
 "attribution": {"method": "CODE", "ad_id": null, "ad_source_type": null, "ctwa_clid": null,
   "ref_code": "K7Q2", "ref_code_at": "2026-10-09T20:14:00+03:00", "touch_at": "2026-10-09T20:14:00+03:00",
   "page_id": null, "psid": null, "waba_id": null, "conversation_ref": "cv_abcdefghijkl"}}
```
رد `201` (أو `200` لنفس المفتاح — نفس الطلب، ولا نسخة تانية):
```json
{"order_id": "8a1f…", "order_number": "SY-2026-0148", "status": "NEW"}
```
- **إعادة استخدام منطق الإنشاء الموجود** (نفس مسار `POST /api/orders` / تأكيد `ai-intake`): `findOrCreateCustomer` · `activeBlock` (زبون محظور = `422 CUSTOMER_BLACKLISTED`) · `resolveRegionId` · `computeCod` · `orderRefFields` · `activeOffersFor` · `logAudit` · `emitAppEvent('order.created')`.
- **السعر:** الـ OMS بيعيد الحساب من كتالوجه؛ اختلاف عن `totals` = يقبل بسعره ويرجّع `price_adjusted: true` (أو `409 PRICE_MISMATCH` حسب سياسة المالك) — ما بيثق بأرقام نظام تاني.
- **الإسناد:** خانات على `Order` (`adId · ctwaClid · refCode · refCodeAt · touchAt · pageId · psid · wabaId · channel · externalRef · source`) — هي مصدر الميديا باير (CAPI) والكليبر (`GET /api/v1/orders/attribution?has_ref=true`). `ctwa_clid` و`psid` مشفّرين بالقاعدة.
- **عدم التكرار:** جدول `IdempotencyKey(companyId, key, requestHash, responseJson)` — نفس المفتاح بجسم مختلف = `409 IDEMPOTENCY_CONFLICT`.

### `GET /api/v1/orders/{id}`
```json
{"order_id": "8a1f…", "order_number": "SY-2026-0148", "status": "CONFIRMED", "shipping_status": "SHIPPED", "updated_at": "…+03:00"}
```

### `POST /api/v1/orders/{id}/notes`
```json
{"kind": "follow_up", "note": "الزبون طلب التوصيل بعد الساعة 5"}
```
رد: `{"ok": true}` · `Idempotency-Key` إلزامي · ملاحظة بـ `OrderActivity` بمصدر «الردود».

## 3. الأحداث (موجودة — بلا تغيير)

الـ OMS بيبعت أصلًا `order.created · order.confirmed · order.shipped · order.delivered · order.returned · order.cancelled` موقّعة لكل تطبيق — الردود بتستقبلها على `POST {REPLIES}/api/webhooks/oms/{key}` وبتطابق بـ `orderId` أولًا. الباب الجديد ما بيغيّر شي هون.
- **الردود بتعتمد على حقلين موجودين بالحمولة:** `total` و`currency` (موجودين اليوم بأحداث التأكيد والشحن والإنشاء) — ربط يدوي بالرقم ما بيكمل إلا إذا طابقوا طلبنا. **لا تشيلهم من الأحداث.**
- **عدم التكرار عندنا من `at` بالجسم الموقّع** (مش من `X-Zaki-Delivery`) — خلي `at` ثابت بإعادة المحاولة (هيك هو اليوم: الجسم بينكتب مرة بصف التسليم).

## 4. شاشة التوكنات بالـ OMS

الإعدادات ← التطبيقات ← «توكنات الأنظمة»: إنشاء (يظهر مرة) · الصلاحيات · آخر استخدام · إيقاف فوري — نفس تصميم شاشة التطبيقات الحالية.

## 5. برومبت GLM (للـ OMS)

```text
أنت بتشتغل على ريبو Zaki OMS (MKory18/Zaki-ai-CRM) — Next.js App Router + Prisma + PostgreSQL.
المهمة: باب /api/v1 للأنظمة (أولها نظام الردود — سيستم 7) بالضبط حسب docs/OMS-DOOR-V1.md المرفق، بلا كسر أي شي موجود.

القواعد:
1. ما تعيد بناء شي موجود: الإنشاء يمر من نفس منطق POST /api/orders وتأكيد ai-intake
   (findOrCreateCustomer · activeBlock · resolveRegionId · computeCod · orderRefFields ·
   activeOffersFor · productCost · logAudit · emitAppEvent). استخرج المنطق المشترك لدالة
   وحدة إذا لزم، والمسارين القديمين ينادوها — بلا تغيير سلوكهم (اختباراتهم الحالية لازم تضل ناجحة).
2. المصادقة: موديل SystemToken (companyId · name · system · tokenHash sha256 unique · prefix ·
   scopes[] · rateLimitPerMin · expiresAt · revokedAt · lastUsedAt) + requireSystemToken(scope)
   بيرجّع companyId من التوكن (ولا مرة من الطلب). حد طلبات بنفس محدد السرعة الموجود.
3. عدم التكرار: موديل IdempotencyRecord (companyId · key · requestHash · status · responseJson ·
   createdAt) unique(companyId,key). نفس المفتاح ونفس الجسم = نفس الرد (200)، جسم مختلف = 409.
4. حقول الإسناد على Order: externalRef · source · channel · adId · adSourceType · ctwaClidEnc ·
   refCode · refCodeAt · touchAt · pageId · psidEnc · wabaId · conversationRef — ctwa_clid وpsid
   مشفّرين بنفس آلية تشفير أسرار التطبيقات. ترحيل Prisma إضافي فقط (لا حذف ولا تغيير نوع).
5. السعر من كتالوج الـ OMS دايمًا: أعد الحساب، وإذا اختلف عن totals رجّع price_adjusted: true
   مع الأرقام المعتمدة (ولا تقبل سعر نظام تاني كما هو).
6. ممنوع أي نداء لموديل ذكاء بأي مسار من الباب.
7. الخطأ الموحّد {"error":{"code","message","details"},"request_id"} و X-Request-Id بالرد.
8. شاشة «توكنات الأنظمة» تحت الإعدادات ← التطبيقات (إنشاء يظهر مرة · صلاحيات · إيقاف).
9. اختبارات Vitest لكل نقطة: توكن غلط/منتهي/موقوف 401 · صلاحية ناقصة 403 · عزل الشركات ·
   مفتاح مكرر = نفس الطلب · مفتاح بجسم مختلف 409 · زبون محظور 422 · سعر مختلف = price_adjusted ·
   الأرقام نص بخانتين · ولا اسم/عنوان برد customers/lookup · order.created بينبعث مرة وحدة.
10. لا تغيّر أحداث التطبيقات الحالية ولا شكلها.

سلّم: الترحيل · المسارات · الشاشة · الاختبارات · وسطر بالعربي بملف التقدم.
```

## 6. بالردود بعد ما ينبنى

> ⚠️ رابط الـ OMS بينفحص (https + DNS) عند كل ترحيل ومزامنة. 🔧 إذا الـ OMS على نفس السيرفر برابط داخلي (`http://oms:3000`): `INTEGRATIONS_ALLOW_PRIVATE_NETWORK=true` ببيئة الردود — وإلا الترحيل بيرجع `OMS_URL_REJECTED` قبل ما يطلع التوكن.


الإعدادات ← الربط مع الأنظمة ← الـ OMS: «API — ترحيل مباشر» · «v1» · توكن الردود من شاشة توكنات الـ OMS · «اختبر الاتصال» (لازم يقول «الباب شغّال والتوكن مقبول») · وإذا بدك: «ترحيل تلقائي بعد التأكيد» (⚠️ مؤتمت — 🔧 خليه مطفي إذا بدك مراجعة قبل الشحن).
