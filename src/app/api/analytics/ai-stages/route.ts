import { analyticsRoute } from "../_shared";
import { getAiStageLatency } from "@/modules/analytics/service";

// P13 — زمن كل مرحلة من مراحل خط أنابيب الذكاء (P50/P95) ضمن النطاق.
export const GET = analyticsRoute(getAiStageLatency);
