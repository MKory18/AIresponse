import { getTrends } from "@/modules/analytics/trends";
import { analyticsRoute } from "../_shared";

/** P10 — الاتجاهات الزمنية: قراءة الجدول اليومي المجمّع (بنية موجودة)
 *  + تسجيل مهمة تجميع idempotently للأيام المفقودة (إصلاح ذاتي تحليلي). */
export const GET = analyticsRoute(getTrends as never);
