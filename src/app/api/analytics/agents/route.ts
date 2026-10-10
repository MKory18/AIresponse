import { getAgentAnalytics } from "@/modules/analytics/agents";
import { analyticsRoute } from "../_shared";

/** P10 — أداء الموظفين: تقارير حساسة بصلاحية مستقلة `analytics.agents`
 *  (المدير فما فوق) — إنفاذ من الخادم قبل أي قراءة. تعريفات الإسناد
 *  الرسمية موثقة داخل الوحدة وتُعاد مع الرد. */
export const GET = analyticsRoute(getAgentAnalytics as never, "analytics.agents");
