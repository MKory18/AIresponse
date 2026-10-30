# نسخ احتياطي واسترجاع — قاعدة بيانات سيستم ٧

> تشغيلي (المرحلة ٣). **لا يحذف ولا يغيّر أي بيانات** — نسخ وقراءة فقط.
> الهدف: نسخة يومية مجدولة + تجربة استرجاع موثّقة بعدّ صفوف مطابق.

## 1. المتطلبات

- أدوات PostgreSQL (`pg_dump` · `pg_restore` · `psql`) على نفس نسخة السيرفر (17+).
- متغيّر `DATABASE_URL` (نفس صيغة `.env`).
- مساحة القرص لنسخة القاعدة (+ الملفات المرفوعة إن وُجدت).

## 2. النسخ الاحتياطي

سكربت جاهز: `scripts/db-backup.ps1`

```powershell
$env:DATABASE_URL = "postgresql://…/ai_commerce"
.\scripts\db-backup.ps1 -OutDir "D:\backups\zaki"
```

ينتج:
- `ai_commerce-YYYYMMDD-HHmmss.dump` — نسخة مخصّصة (custom format، مضغوطة).
- `ai_commerce-YYYYMMDD-HHmmss.counts.json` — عدّ صفوف للمقارنة لاحقًا.

**الجدولة اليومية (Windows Task Scheduler):**

```powershell
schtasks /Create /SC DAILY /TN "Zaki DB Backup" /ST 03:00 ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"F:\برمجة\Zaki ai response\scripts\db-backup.ps1\" -OutDir D:\backups\zaki"
```

احتفظ بـ ٧ نسخ يومية على الأقل + نسخة أسبوعية خارج السيرفر.

## 3. تجربة الاسترجاع (لا تلمس قاعدة الإنتاج)

1. أنشئ قاعدة فاضية للاسترجاع:

   ```powershell
   $env:PGPASSWORD = "…"
   createdb -h localhost -U aiapp ai_commerce_restore
   ```

2. استرجع النسخة فيها:

   ```powershell
   .\scripts\db-restore.ps1 -Dump "D:\backups\zaki\ai_commerce-….dump" `
     -TargetUrl "postgresql://aiapp:…@localhost:5432/ai_commerce_restore?schema=public"
   ```

3. **التحقق بعدّ الصفوف** — قارن مصدر بمسترجَع:

   ```powershell
   node --import tsx scripts/db-counts.ts > counts-source.json
   $env:DATABASE_URL = "postgresql://…/ai_commerce_restore"; node --import tsx scripts/db-counts.ts > counts-restore.json
   Compare-Object (Get-Content counts-source.json) (Get-Content counts-restore.json)
   ```

   **صفر فرق = استرجاع كامل.** أي فرق = استرجاع ناقص — لا تعتمد النسخة.

4. تأكيد الترحيلات على المسترجَع: `npx prisma migrate status` (لازم يقول "up to date").

## 4. سكربتات

| السكربت | الوظيفة |
|---|---|
| `scripts/db-backup.ps1` | نسخة مخصّصة + ملف عدّ صفوف |
| `scripts/db-restore.ps1` | استرجاع `--clean --if-exists` على قاعدة هدف محدّدة |
| `scripts/db-counts.ts` | طباعة عدّ الصفوف للجداول الأساسية (JSON) |

## 5. ملاحظات أمان

- النسخ تحتوي بيانات شخصية (اسم/رقم/عنوان) — احفظها مشفّرة وبصلاحية مالك فقط.
- `PGPASSWORD` بمتغيّر بيئة للجلسة، لا يُكتب بملف ولا يُطبع.
- لا تسترجع فوق قاعدة الإنتاج مباشرة إلا بموافقة صريحة وقاعدة فارغة أولًا.

## 6. حالة التحقق بهذه الجلسة

- السكربتات والوثيقة جاهزة.
- **تجربة الاسترجاع الحيّة بدها أدوات `pg_*` ومهلة صيانة** — ما نُفّذت بالبيئة الحالية (أدوات `pg_dump` غير مثبّتة). تنفيذها مُدرَج كمهمة تشغيلية بالإنتاج.
