import type { Permission } from "./permissions";

/**
 * مجالات الصلاحيات (الحزمة 4.1، 04-PERMISSIONS §4.3) — **اللي بيشوفه المالك**؛ الرموز بتضل للكود.
 * منها بينبني: جدول «شو بيقدر كل دور؟» · مفاتيح صلاحيات العضو (4.2) · وصف الدور.
 * قاعدة (`tests/rbac-areas.test.ts`): كل رمز معروض ضمن مستوى واحد بالضبط، وكل رمز مخفي مذكور صراحة،
 * والمجموعتين بيغطّوا كل `PERMISSIONS`. مستوى المجال = يقدر لو ملك **كل** رموزه.
 */
export interface PermissionLevel {
  key: string;
  label: string;
  perms: readonly Permission[];
}
export interface PermissionArea {
  key: string;
  label: string;
  levels: readonly PermissionLevel[];
}

export const PERMISSION_AREAS: readonly PermissionArea[] = [
  {
    key: "conversations",
    label: "المحادثات",
    levels: [
      { key: "view", label: "يشوف", perms: ["conversations.read", "customers.read"] },
      { key: "reply", label: "يرد ويعدّل بيانات العميل", perms: ["channels.send_human", "conversations.reply", "customers.write"] },
      { key: "takeover", label: "يستلم من الوكيل ويحلّ التحويلات", perms: ["conversations.takeover", "handoffs.read", "handoffs.claim", "handoffs.resolve"] },
      { key: "assign", label: "يوزّع على الموظفين", perms: ["conversations.assign"] },
      { key: "delete", label: "يحذف", perms: ["conversations.delete"] },
    ],
  },
  {
    key: "orders",
    label: "الطلبات",
    levels: [
      { key: "view", label: "يشوف", perms: ["orders.read"] },
      { key: "edit", label: "يعدّل ويثبّت", perms: ["orders.write", "orders.seal"] },
      { key: "cancel", label: "يلغي", perms: ["orders.cancel"] },
      { key: "amend", label: "يعتمد تعديل بعد التثبيت", perms: ["orders.amend"] },
      { key: "delete", label: "يحذف نهائيًا", perms: ["orders.delete"] },
    ],
  },
  {
    key: "store",
    label: "المتجر",
    levels: [
      { key: "view", label: "يشوف", perms: ["products.read", "catalogs.read"] },
      { key: "edit", label: "يعدّل المنتجات والتوصيل", perms: ["products.write", "catalogs.write", "catalogs.assign", "media.write"] },
      { key: "wholesale", label: "يشوف سعر الجملة", perms: ["products.wholesale"] },
    ],
  },
  {
    key: "agent",
    label: "الوكيل الذكي",
    levels: [
      { key: "view", label: "يشوف", perms: ["personas.read", "knowledge.read", "media.read", "feedback.read"] },
      { key: "edit", label: "يعدّل المحتوى (شخصية · معرفة)", perms: ["personas.write", "knowledge.write", "feedback.write"] },
      { key: "publish", label: "ينشر ويشغّل", perms: ["personas.publish", "ai.configure"] },
    ],
  },
  {
    key: "reports",
    label: "التقارير",
    levels: [
      { key: "view", label: "يشوف", perms: ["analytics.read"] },
      { key: "agents", label: "يشوف أداء الموظفين", perms: ["analytics.agents"] },
      { key: "usage", label: "يشوف الكلفة", perms: ["usage.read"] },
    ],
  },
  {
    key: "settings",
    label: "الإعدادات",
    levels: [
      { key: "channels", label: "الصفحات والقنوات", perms: ["channels.read", "channels.connect"] },
      { key: "integrations", label: "الربط (OMS · تيليجرام)", perms: ["integrations.manage"] },
      { key: "team", label: "الفريق", perms: ["users.manage"] },
      { key: "workspace", label: "المساحة", perms: ["workspace.manage", "settings.manage"] },
      { key: "owners", label: "إدارة المالكين", perms: ["team.owners"] },
    ],
  },
];

/**
 * رموز بتضل بالكود (مسارات واختبارات) بس ما بتنعرض طول ما صفحاتها مخفية بقرار المالك
 * (04-PERMISSIONS §4.2): الأتمتة · المتابعات · الحملات · الخصم.
 */
export const HIDDEN_PERMISSIONS: readonly Permission[] = [
  "automation.read",
  "automation.write",
  "automation.execute",
  "followups.read",
  "followups.write",
  "followups.cancel",
  "campaigns.read",
  "campaigns.write",
  "campaigns.approve",
  "orders.discount",
  "orders.discount.approve",
];

export function areaLevels(): Array<{ area: PermissionArea; level: PermissionLevel; id: string; label: string }> {
  return PERMISSION_AREAS.flatMap((area) => area.levels.map((level) => ({ area, level, id: `${area.key}.${level.key}`, label: `${area.label}: ${level.label}` })));
}
