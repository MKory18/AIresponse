import { redirectToMerged } from "@/lib/nav-redirect";

/** كانت نفس تبويب «الذكاء» بالتقارير بفترة ثابتة — الرابط بيحوّل للتبويب. */
export default function AIAnalyticsPage() {
  redirectToMerged("/analytics/ai");
}
