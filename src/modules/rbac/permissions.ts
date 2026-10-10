export const PERMISSIONS = [
  "customers.read",
  "customers.write",
  "conversations.read",
  "conversations.reply",
  "conversations.assign",
  "conversations.delete",
  "orders.read",
  "orders.write",
  "orders.discount",
  "orders.discount.approve",
  "products.read",
  "products.write",
  "products.wholesale",
  "media.read",
  "media.write",
  "feedback.read",
  "feedback.write",
  "knowledge.read",
  "knowledge.write",
  "personas.read",
  "personas.write",
  "ai.configure",
  "channels.read",
  "channels.connect",
  "channels.send_human",
  "automation.read",
  "automation.write",
  "automation.execute",
  "followups.read",
  "followups.write",
  "followups.cancel",
  "handoffs.read",
  "handoffs.claim",
  "handoffs.resolve",
  // P9 — الحملات التسويقية وشرائح الجمهور.
  "campaigns.read",
  "campaigns.write",
  "campaigns.approve",
  "analytics.read",
  "usage.read",
  "users.manage",
  "settings.manage",
  "workspace.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

const SALES_SUPPORT: Permission[] = [
  "customers.read",
  "customers.write",
  "conversations.read",
  "conversations.reply",
  "orders.read",
  "orders.write",
  "products.read",
  "media.read",
  "feedback.read",
  "knowledge.read",
  "personas.read",
  "analytics.read",
];

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  SUPER_ADMIN: ALL,
  OWNER: ALL,
  ADMIN: ALL,
  MANAGER: [
    ...SALES_SUPPORT,
    "conversations.assign",
    "conversations.delete",
    "products.write",
    "media.write",
    "feedback.write",
    "knowledge.write",
    "personas.write",
    "ai.configure",
    "channels.read",
    "channels.connect",
    "automation.read",
    "automation.write",
    "automation.execute",
    "followups.read",
    "followups.write",
    "followups.cancel",
    "handoffs.read",
    "handoffs.claim",
    "handoffs.resolve",
    "channels.send_human",
    "usage.read",
    "settings.manage",
    // P8 — الخصم ضمن السقف + رؤية سعر الجملة + اعتماد فوق السقف (المدير فقط).
    "orders.discount",
    "products.wholesale",
    "orders.discount.approve",
    // P9 — الحملات: إنشاء/تحرير/جدولة + الاعتماد والنشر (المدير).
    "campaigns.read",
    "campaigns.write",
    "campaigns.approve",
  ],
  SALES_AGENT: [
    ...SALES_SUPPORT,
    "channels.send_human",
    "followups.read",
    "handoffs.read",
    "handoffs.claim",
    "handoffs.resolve",
    // P8 — خصم ضمن السقف فقط. رؤية سعر الجملة والاعتماد فوق السقف ليست
    // لهما (صلاحيتا MANAGER) — إنفاذ من الخادم، لا من الواجهة.
    "orders.discount",
    // P9 — قراءة الحملات فقط؛ الإنشاء/الاعتماد لصلاحيات أعلى.
    "campaigns.read",
  ],
  SUPPORT_AGENT: SALES_SUPPORT.filter((p) => p !== "orders.write"),
  VIEWER: [
    "customers.read",
    "conversations.read",
    "orders.read",
    "products.read",
    "media.read",
    "feedback.read",
    "knowledge.read",
    "personas.read",
    "channels.read",
    "automation.read",
    "campaigns.read",
    "analytics.read",
  ],
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** Effective permissions = role matrix + member-level overrides. */
export function effectivePermissions(
  role: string,
  memberPermissions: string[] = []
): Set<Permission> {
  const base = ROLE_PERMISSIONS[role] ?? [];
  const set = new Set<Permission>(base);
  for (const p of memberPermissions) {
    if (isPermission(p)) set.add(p);
  }
  return set;
}

export function hasPermission(
  role: string,
  memberPermissions: string[],
  required: Permission
): boolean {
  return effectivePermissions(role, memberPermissions).has(required);
}

export function hasAnyPermission(
  role: string,
  memberPermissions: string[],
  required: Permission[]
): boolean {
  const set = effectivePermissions(role, memberPermissions);
  return required.some((p) => set.has(p));
}
