import { redirectToMerged } from "@/lib/nav-redirect";

/**
 * كان «الاستوديو»: نسخة للقراءة من إعدادات الذكاء + نفس فحص الاتصال. حالته
 * صارت بطاقة فوق «التشغيل» (`settings/ai/ai-status-card.tsx`) والرابط بيحوّل لهناك.
 */
export default function AIStudioPage() {
  redirectToMerged("/ai/studio");
}
