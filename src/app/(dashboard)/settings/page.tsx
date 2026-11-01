import { redirectToMerged } from "@/lib/nav-redirect";

/**
 * كانت «عام»: ٣ بطاقات روابط (حسابي · الذكاء · الفريق) نفس تبويبات المجموعة
 * وقائمة الحساب، وملاحظة «ستُستكمل لاحقًا». الرابط بيحوّل لـ«حسابي» — مفتوحة لكل عضو.
 */
export default function SettingsPage() {
  redirectToMerged("/settings");
}
