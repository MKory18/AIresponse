import { pageForPath } from "@/lib/nav-model";

/**
 * عدّادات القائمة الجانبية من بنود «يحتاجك» (2.3ب): كل بند بيتحسب على المجموعة اللي بيودّي رابطه لصفحتها
 * (`/conversations?id=…` ← المحادثات · `/orders?order=…` ← الطلبات). **مصدر واحد** مع العدّاد بالرأس واللوحة.
 * بنود الأعطال الحرجة (`/settings/integrations` · `/channels`…) بتنحسب على «الإعدادات» — بتبيّن نقطة هناك كمان.
 */
export function countsByGroup(
  items: readonly { href: string; severity: string }[],
  groups: readonly { key: string; pages: readonly { href: string }[] }[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const path = item.href.split("?")[0]!;
    const hit = pageForPath(path, groups);
    // صفحة جديدة لسا مش بالقائمة (مثلًا /settings/integrations قبل 3.6): بتنحسب على الإعدادات.
    const key = hit?.group.key ?? (path.startsWith("/settings") ? "settings" : null);
    if (key) out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
