import type { Permission } from "@/modules/rbac/permissions";

export const NAV_ITEMS: { href: string; label: string; icon: string; permission: Permission }[] = [
  { href: "/dashboard", label: "لوحة التحكم", icon: "LayoutDashboard", permission: "analytics.read" },
  { href: "/conversations", label: "المحادثات", icon: "MessagesSquare", permission: "conversations.read" },
  { href: "/customers", label: "العملاء", icon: "Users", permission: "customers.read" },
  { href: "/orders", label: "الطلبات", icon: "Package", permission: "orders.read" },
  { href: "/products", label: "المنتجات", icon: "ShoppingBag", permission: "products.read" },
  { href: "/media", label: "الوسائط", icon: "Image", permission: "media.read" },
  { href: "/feedback", label: "آراء العملاء", icon: "Star", permission: "feedback.read" },
  { href: "/knowledge", label: "قاعدة المعرفة", icon: "BookOpen", permission: "knowledge.read" },
  { href: "/personas", label: "شخصية AI", icon: "Bot", permission: "personas.read" },
  { href: "/ai/playground", label: "ملعب AI", icon: "Bot", permission: "ai.configure" },
  { href: "/channels", label: "القنوات", icon: "Radio", permission: "channels.read" },
  { href: "/automation", label: "الأتمتة", icon: "Workflow", permission: "automation.read" },
  { href: "/analytics", label: "التحليلات", icon: "BarChart3", permission: "analytics.read" },
  { href: "/settings", label: "الإعدادات", icon: "Settings", permission: "settings.manage" },
];
