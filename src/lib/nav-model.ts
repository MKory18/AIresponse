import type { Permission } from "@/modules/rbac/permissions";

/**
 * نموذج التنقل — مصدر الحقيقة الوحيد لشكل القائمة الجانبية وشريط التبويبات.
 *
 * ⚠️ قبل هالنموذج: القائمة الجانبية كانت ٢٢ بند بصف واحد بلا تجميع، ونفس
 * الشغلة موزّعة على أكتر من مكان (إعداد الذكاء بـ٤ أماكن · التقارير بـ٤ ·
 * الأتمتة بـ٣) — والمستخدم الجديد ما كان يعرف من وين يبلّش.
 *
 * 🔧 ٧ مجموعات حسب الشغلة. القائمة الجانبية بتعرض المجموعات، وشريط
 * تبويبات بأعلى الصفحة بيتنقّل بين صفحات المجموعة.
 *
 * ⚠️ بعدها ضل ٢٦ تبويب، منها ٥ صفحات بتكرّر غيرها: «الاستوديو» نسخة للقراءة
 * من «الضبط» · «سير العمل» و«القواعد» نفس الجدول بقائمتين · تقريرَي الذكاء
 * والمنتجات نفس تبويبات «التحليلات» · «عام» بطاقات روابط بس · مخزن الطلبات
 * نسخة حرفية من «الطلبات».
 * 🔧 كل وحدة اندمجت بأصلها (٢١ تبويب) — والرابط القديم **ما بينكسر**: بيحوّل
 * لمكانه الجديد (`NAV_REDIRECTS`)، فالإشعارات والمفضلة وباب الوكلاء بيضلوا شغّالين.
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
      // الترتيب = طريق الإعداد: علّمه ← جرّبه ← شغّله.
      { href: "/ai/playground", label: "التجربة", permission: "ai.configure" },
      { href: "/settings/ai", label: "التشغيل", permission: "ai.configure" },
    ],
  },
  {
    key: "automation",
    label: "الأتمتة",
    icon: "Workflow",
    placement: "main",
    pages: [
      { href: "/automation", label: "القواعد", permission: "automation.read" },
      { href: "/follow-ups", label: "المتابعات", permission: "followups.read" },
    ],
  },
  {
    key: "reports",
    label: "التقارير",
    icon: "ChartNoAxesCombined",
    placement: "main",
    pages: [
      { href: "/analytics", label: "التقارير", permission: "analytics.read" },
    ],
  },
  {
    key: "settings",
    label: "الإعدادات",
    icon: "Settings",
    placement: "bottom",
    pages: [
      { href: "/channels", label: "القنوات", permission: "channels.read" },
      { href: "/settings/team", label: "الفريق", permission: "users.manage" },
      { href: "/settings/account", label: "حسابي", permission: null },
    ],
  },
];

/**
 * روابط قديمة اندمجت صفحتها بغيرها: الرابط بيضل شغّال وبيحوّل لمكانه الجديد
 * (صفحة `page.tsx` صغيرة بتنادي `redirectToMerged`). مطابقة **حرفية** للمسار —
 * `/settings` بتحوّل، بس `/settings/ai` و`/settings/team` صفحات حقيقية.
 */
export const NAV_REDIRECTS: Record<string, string> = {
  "/order-warehouse": "/orders",
  "/ai/studio": "/settings/ai",
  "/workflows": "/automation",
  "/analytics/ai": "/analytics?tab=ai",
  "/analytics/products": "/analytics?tab=products",
  "/settings": "/settings/account",
};

/** شكل خفيف بيمرّ من الخادم للعميل — بلا صلاحيات. */
export interface NavGroupView {
  key: string;
  label: string;
  icon: string;
  placement: "main" | "bottom";
  pages: { href: string; label: string }[];
}

function applyRedirect(pathname: string): string {
  const target = NAV_REDIRECTS[pathname];
  return target ? target.split("?")[0]! : pathname;
}

/**
 * الصفحة الي بتخدم هالمسار: أطول رابط مطابق (بحيث `/orders/abc` يتبع
 * «الطلبات»)، والرابط المدموج بيتبع مكانه الجديد. `null` لمسار مجهول.
 */
export function pageForPath<G extends { pages: readonly { href: string }[] }>(
  pathname: string,
  groups: readonly G[]
): { group: G; page: G["pages"][number] } | null {
  const path = applyRedirect(pathname.split("?")[0]!.replace(/\/+$/, "") || "/");
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
