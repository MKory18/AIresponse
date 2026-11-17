import { NAV_GROUPS, pageForPath, type NavGroup } from "@/lib/nav-model";
import type { Permission } from "@/modules/rbac/permissions";

/**
 * حارس الصفحات من الخادم (2.2، 04-PERMISSIONS §6): الواجهة ما بتكتفي بإخفاء بند القائمة —
 * فتح رابط صفحة ممنوعة مباشرة بيرجّع العضو لأول صفحة مسموحة له مع `?denied=1`
 * (الواجهة بتعرض تنبيه «ما عندك صلاحية»). الـAPI بيضل هو الحكم الأخير على البيانات.
 *
 * دالة صرفة (بلا قاعدة بيانات ولا Next) علشان تنختبر مباشرة.
 */

export type PageDecision = { kind: "allow" } | { kind: "redirect"; to: string };

/** أول صفحة مسموحة بترتيب القائمة؛ `null` = ولا صفحة مسموحة. */
export function firstAllowedPage(
  can: (permission: Permission) => boolean,
  groups: readonly NavGroup[] = NAV_GROUPS
): string | null {
  for (const group of groups) {
    for (const page of group.pages) {
      if (page.permission === null || can(page.permission)) return page.href;
    }
  }
  return null;
}

export function decidePageAccess(
  pathname: string,
  can: (permission: Permission) => boolean,
  groups: readonly NavGroup[] = NAV_GROUPS
): PageDecision {
  const hit = pageForPath(pathname, groups);
  // مسار مجهول للقائمة (مثلًا صفحة فرعية جديدة) ما بنحجبه هون — API بيحكم.
  if (!hit) return { kind: "allow" };
  const required = hit.page.permission;
  if (required === null || can(required)) return { kind: "allow" };
  const landing = firstAllowedPage(can, groups);
  // ما في ولا صفحة مسموحة غير «حسابي» (permission null) عادةً، فهاد نادر؛ نرجّع لـ«حسابي».
  return { kind: "redirect", to: `${landing ?? "/settings/account"}?denied=1` };
}

/** الهيدر اللي بيحطه `middleware.ts` علشان الـlayout يعرف المسار (الـlayout ما بيقرأ pathname). */
export const PATH_HEADER = "x-zaki-path";
