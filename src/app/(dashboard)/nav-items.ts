import { t } from "@/lib/i18n";
import type { Permission } from "@/modules/rbac/permissions";

export const NAV_ITEMS: { href: string; label: string; icon: string; permission: Permission; badge?: string }[] = [
  { href: "/dashboard", label: t.nav.dashboard, icon: "LayoutDashboard", permission: "analytics.read" },
  { href: "/conversations", label: t.nav.inbox, icon: "MessageSquare", permission: "conversations.read" },
  { href: "/customers", label: t.nav.customers, icon: "Users", permission: "customers.read" },
  { href: "/orders", label: t.nav.orders, icon: "ShoppingBag", permission: "orders.read" },
  { href: "/products", label: t.nav.products, icon: "Package", permission: "products.read" },
  { href: "/media", label: t.nav.media, icon: "Images", permission: "media.read" },
  { href: "/feedback", label: t.nav.feedback, icon: "MessageCircle", permission: "feedback.read" },
  { href: "/knowledge", label: t.nav.knowledge, icon: "BookOpen", permission: "knowledge.read" },
  { href: "/personas", label: t.nav.personas, icon: "UserRound", permission: "personas.read" },
  { href: "/ai/studio", label: "استوديو الذكاء", icon: "SlidersHorizontal", permission: "ai.configure" },
  { href: "/ai/playground", label: t.nav.playground, icon: "FlaskConical", permission: "ai.configure" },
  { href: "/channels", label: t.nav.channels, icon: "Radio", permission: "channels.read" },
  { href: "/automation", label: t.nav.automation, icon: "Workflow", permission: "automation.read" },
  { href: "/workflows", label: "سير العمل", icon: "GitBranch", permission: "automation.read" },
  { href: "/follow-ups", label: t.nav.followups, icon: "Clock", permission: "followups.read" },
  { href: "/campaigns", label: "الحملات", icon: "Megaphone", permission: "campaigns.read" },
  { href: "/handoffs", label: t.nav.handoffs, icon: "Hand", permission: "handoffs.read" },
  { href: "/analytics", label: t.nav.analytics, icon: "ChartNoAxesCombined", permission: "analytics.read" },
  { href: "/settings", label: t.nav.settings, icon: "Settings", permission: "settings.manage" },
  { href: "/settings/team", label: t.nav.team, icon: "Users", permission: "users.manage" },
];
