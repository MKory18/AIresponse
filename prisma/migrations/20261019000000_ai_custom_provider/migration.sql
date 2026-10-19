-- مزوّد مخصص لمساحة العمل (أي واجهة OpenAI-compatible خارجية):
-- المفتاح ينخزن مشفّراً (AES-256-GCM) — نسخة إضافية فقط (لا حذف ولا تغيير أنواع).
ALTER TABLE "AISettings" ADD COLUMN     "customApiKeyEnc" TEXT;
