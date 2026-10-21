import type { Permission } from "@/modules/rbac/permissions";

/**
 * نموذج التنقل — مصدر الحقيقة الوحيد لشكل القائمة الجانبية وشريط التبويبات.
 *
 * ⚠️ قبل هالنموذج: القائمة الجانبية كانت ٢٢ بند بصف واحد بلا تجميع، ونفس
 * الشغلة موزّعة على أكتر من مكان (إعداد الذكاء بـ٤ أماكن · التقارير بـ٤ ·
 * الأتمتة بـ٣) — والمستخدم الجديد ما كان يعرف من وين يبلّش.
 *
 * 🔧 هلأ: ٧ مجموعات حسب الشغلة. القائمة الجانبية بتعرض المجموعات، وشريط
 * تبويبات بأعلى الصفحة بيتنقّل بين صفحات المجموعة.
 *
 * **ولا مسار بيتغيّر.** كل صفحة بتضل على رابطها الحالي — الي بيتغيّر بس كيف
 * بتتجمّع بالقائمة. يعني الروابط بالإشعارات والمفضلة وباب الوكلاء كلها
 * بتضل شغّالة بلا تحويلات.
 */

export interface NavPage {
  href: string;
  label: string;
  /** `null` = متاحة لكل عضو مسجّل (مثل «حسابي»). */
  permission: Permission | null;
}

export interface NavGroup {
  key: string;
  label: string;
  /** مفتاح بسجل الأيقونات `NAV_ICONS`. كل مجموعة أيقونتها فريدة. */
  icon: string;
  /** `bottom` = بآخر القائمة تحت فاصل (الإعدادات). */
  placement: "main" | "bottom";
  pages: NavPage[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    key: "home",
    label: "الرئيسية",
    icon: "LayoutDashboard",
    placement: "main",
    pages: [{ href: "/dashboard", label: "لوحة التحكم", permission: "analytics.read" }],
  },
  {
    key: "chats",
    label: "المحادثات",
    icon: "MessageSquare",
    placement: "main",
    pages: [
      { href: "/conversations", label: "الوارد", permission: "conversations.read" },
      { href: "/handoffs", label: "التحويلات", permission: "handoffs.read" },
      { href: "/customers", label: "العملاء", permission: "customers.read" },
      { href: "/intelligence", label: "مختبر التجميع", permission: "conversations.read" },
    ],
  },
  {
    key: "sales",
    label: "المبيعات",
    icon: "ShoppingBag",
    placement: "main",
    pages: [
      { href: "/orders", label: "الطلبات", permission: "orders.read" },
      { href: "/products", label: "المنتجات", permission: "products.read" },
      { href: "/catalogs", label: "الكتالوجات", permission: "catalogs.read" },
      { href: "/campaigns", label: "الحملات", permission: "campaigns.read" },
    ],
  },
  {
    key: "ai",
    label: "الذكاء",
    icon: "Sparkles",
    placement: "main",
    pages: [
      { href: "/personas", label: "الشخصية", permission: "personas.read" },
      { href: "/knowledge", label: "المعرفة", permission: "knowledge.read" },
      { href: "/media", label: "الوسائط", permission: "media.read" },
      { href: "/feedback", label: "آراء العملاء", permission: "feedback.read" },
      { href: "/settings/ai", label: "الضبط", permission: "ai.configure" },
      { href: "/ai/studio", label: "الاستوديو", permission: "ai.configure" },
      { href: "/ai/playground", label: "التجربة", permission: "ai.configure" },
    ],
  },
  {
    key: "automation",
    label: "الأتمتة",
    icon: "Workflow",
    placement: "main",
    pages: [
      { href: "/automation", label: "القواعد", permission: "automation.read" },
      { href: "/workflows", label: "سير العمل", permission: "automation.read" },
      { href: "/follow-ups", label: "المتابعات", permission: "followups.read" },
    ],
  },
  {
    key: "reports",
    label: "التقارير",
    icon: "ChartNoAxesCombined",
    placement: "main",
    pages: [
      { href: "/analytics", label: "نظرة عامة", permission: "analytics.read" },
      { href: "/analytics/ai", label: "الذكاء", permission: "analytics.read" },
      { href: "/analytics/products", label: "المنتجات", permission: "analytics.read" },
    ],
  },
  {
    key: "settings",
    label: "الإعدادات",
    icon: "Settings",
    placement: "bottom",
    pages: [
      { href: "/channels", label: "القنوات", permission: "channels.read" },
      { href: "/settings", label: "عام", permission: "settings.manage" },
      { href: "/settings/team", label: "الفريق", permission: "users.manage" },
      { href: "/settings/account", label: "حسابي", permission: null },
    ],
  },
];

/**
 * أسماء مستعارة: مسارات بتعرض صفحة غيرها (re-export). بتتبع مجموعة الأصل
 * وما بتظهر كتبويب لحالها.
 */
export const NAV_ALIASES: Record<string, string> = {
  "/order-warehouse": "/orders",
};

/** شكل خفيف بيمرّ من الخادم للعميل — بلا صلاحيات. */
export interface NavGroupView {
  key: string;
  label: string;
  icon: string;
  placement: "main" | "bottom";
  pages: { href: string; label: string }[];
}

function applyAlias(pathname: string): string {
  for (const [alias, target] of Object.entries(NAV_ALIASES)) {
    if (pathname === alias || pathname.startsWith(alias + "/")) return target + pathname.slice(alias.length);
  }
  return pathname;
}

/**
 * الصفحة الي بتخدم هالمسار: أطول رابط مطابق (بحيث `/settings/ai` يتبع
 * «الضبط» مش «عام»، و`/orders/abc` يتبع «الطلبات»). `null` لمسار مجهول.
 */
export function pageForPath<G extends { pages: readonly { href: string }[] }>(
  pathname: string,
  groups: readonly G[]
): { group: G; page: G["pages"][number] } | null {
  const path = applyAlias(pathname.split("?")[0]!.replace(/\/+$/, "") || "/");
  let best: { group: G; page: G["pages"][number] } | null = null;
  for (const group of groups) {
    for (const page of group.pages) {
      if (path === page.href || path.startsWith(page.href + "/")) {
        if (!best || page.href.length > best.page.href.length) best = { group, page };
      }
    }
  }
  return best;
}

/**
 * المجموعات المسموحة لهالعضو: الصفحة المحجوبة بتنشال، والمجموعة الي ما
 * بقي فيها ولا صفحة بتختفي كليًا (ما في بند قائمة بيودّي لصفحة ممنوعة).
 */
export function visibleGroups(
  groups: readonly NavGroup[],
  can: (permission: Permission) => boolean
): NavGroupView[] {
  return groups
    .map((g) => ({
      key: g.key,
      label: g.label,
      icon: g.icon,
      placement: g.placement,
      pages: g.pages
        .filter((p) => p.permission === null || can(p.permission))
        .map(({ href, label }) => ({ href, label })),
    }))
    .filter((g) => g.pages.length > 0);
}

/** الصفحة الي بتفتحها المجموعة من القائمة الجانبية: أول صفحة مسموحة. */
export function groupLanding(group: { pages: readonly { href: string }[] }): string {
  return group.pages[0]!.href;
}
