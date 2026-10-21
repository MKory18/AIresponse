import {
  LayoutDashboard,
  MessageSquare,
  ShoppingBag,
  Sparkles,
  Workflow,
  ChartNoAxesCombined,
  Settings,
} from "lucide-react";
import type { LucideProps } from "lucide-react";
import type { ComponentType } from "react";

/**
 * أيقونات مجموعات التنقل. ملف لحاله (مش جوّا الشريط الجانبي) حتى اختبار
 * `nav-structure` يفحص إن كل مجموعة أيقونتها موجودة وفريدة.
 *
 * ⚠️ قبل: «مختبر التجميع» و«تجربة الذكاء» كانوا نفس الأيقونة بالضبط
 * (`FlaskConical`)، و«العملاء» و«الفريق» كمان (`Users`) — العين ما بتفرّق.
 */
export const NAV_ICONS: Record<string, ComponentType<LucideProps>> = {
  LayoutDashboard,
  MessageSquare,
  ShoppingBag,
  Sparkles,
  Workflow,
  ChartNoAxesCombined,
  Settings,
};
