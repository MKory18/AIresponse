/**
 * الحزمة 4.1 — المجالات والرموز والمسارات (04-PERMISSIONS §4–§5.3 · §6).
 * المجالات هي اللي بيشوفها المالك؛ الرموز للكود. هون: اكتمال المجالات · جدول الأدوار الجديد ·
 * تصحيح المسارات · والقاعدة «ولا role === برّا rbac/ و members/».
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { PERMISSION_AREAS, HIDDEN_PERMISSIONS, areaLevels } from "@/modules/rbac/areas";
import { PERMISSIONS, ROLE_PERMISSIONS, hasPermission, type Permission } from "@/modules/rbac/permissions";
import { deleteOrder } from "@/modules/orders/order-service";
import { routeHandoff } from "@/modules/handoffs/handoff-service";
import { isOwnerRole } from "@/modules/rbac/owner-guard";

type Db = Prisma.TransactionClient;
const src = (p: string) => readFileSync(p, "utf8");
const can = (role: string, p: Permission) => hasPermission(role, [], p);

describe("المجالات", () => {
  const displayed = areaLevels().flatMap((l) => l.level.perms);

  it("كل رمز معروض ضمن مستوى واحد بالضبط، وكل رمز بمجال موجود بـ PERMISSIONS", () => {
    expect(new Set(displayed).size).toBe(displayed.length);
    for (const p of displayed) expect((PERMISSIONS as readonly string[]).includes(p), p).toBe(true);
  });

  it("المعروض + المخفي (الأتمتة · المتابعات · الحملات · الخصم) = كل الرموز، بلا تقاطع", () => {
    const hidden = new Set<string>(HIDDEN_PERMISSIONS);
    for (const p of displayed) expect(hidden.has(p), p).toBe(false);
    expect([...displayed, ...HIDDEN_PERMISSIONS].sort()).toEqual([...PERMISSIONS].sort());
  });

  it("ستة مجالات بأسماء المالك، ولكل مستوى اسم عربي ورمز واحد على الأقل", () => {
    expect(PERMISSION_AREAS.map((a) => a.label)).toEqual(["المحادثات", "الطلبات", "المتجر", "الوكيل الذكي", "التقارير", "الإعدادات"]);
    for (const l of areaLevels()) {
      expect(l.label.length).toBeGreaterThan(3);
      expect(l.level.perms.length).toBeGreaterThan(0);
    }
  });

  it("الرموز الميتة معلّمة @deprecated بالكود", () => {
    const s = src("src/modules/rbac/permissions.ts");
    expect(s).toMatch(/@deprecated[^\n]*\n\s*"automation\.execute"/);
    expect(s).toMatch(/@deprecated[^\n]*\n\s*"followups\.write"/);
  });
});

describe("جدول الأدوار الجديد (§4.4)", () => {
  it("المالك: كل الرموز. الشريك: كل شي ما عدا orders.delete و team.owners", () => {
    expect(new Set(ROLE_PERMISSIONS.OWNER)).toEqual(new Set(PERMISSIONS));
    const gap = PERMISSIONS.filter((p) => !ROLE_PERMISSIONS.ADMIN!.includes(p)).sort();
    expect(gap).toEqual(["orders.delete", "team.owners"]);
  });

  it("الحذف النهائي وإدارة المالكين للمالك بس", () => {
    for (const role of ["ADMIN", "MANAGER", "SALES_AGENT", "SUPPORT_AGENT", "VIEWER"]) {
      expect(can(role, "orders.delete"), role).toBe(false);
      expect(can(role, "team.owners"), role).toBe(false);
    }
    expect(can("OWNER", "orders.delete")).toBe(true);
    expect(can("OWNER", "team.owners")).toBe(true);
  });

  it("الربط (OMS · تيليجرام): مالك وشريك بس — المشرف ما بيغيّر توكن الـ OMS", () => {
    expect(can("OWNER", "integrations.manage")).toBe(true);
    expect(can("ADMIN", "integrations.manage")).toBe(true);
    for (const role of ["MANAGER", "SALES_AGENT", "SUPPORT_AGENT", "VIEWER"]) expect(can(role, "integrations.manage"), role).toBe(false);
    expect(can("MANAGER", "channels.connect")).toBe(true); // بيربط صفحة
  });

  it("نشر الشخصية: مالك · شريك · مشرف", () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER"]) expect(can(role, "personas.publish"), role).toBe(true);
    for (const role of ["SALES_AGENT", "SUPPORT_AGENT", "VIEWER"]) expect(can(role, "personas.publish"), role).toBe(false);
  });

  it("الاستلام من الوكيل: كل من بيرد (channels.send_human) — والمشاهد لا", () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER", "SALES_AGENT", "SUPPORT_AGENT"]) {
      expect(can(role, "channels.send_human") && can(role, "conversations.takeover"), role).toBe(true);
    }
    expect(can("VIEWER", "conversations.takeover")).toBe(false);
    // أي دور عنده takeover عنده send_human
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      if (perms.includes("conversations.takeover")) expect(perms.includes("channels.send_human"), role).toBe(true);
    }
  });

  it("الوارد بيحتاج channels.read: موظف المبيعات والدعم صار عندهم", () => {
    expect(can("SALES_AGENT", "channels.read")).toBe(true);
    expect(can("SUPPORT_AGENT", "channels.read")).toBe(true);
  });

  it("المبيعات: بيثبّت ويلغي ويعدّل، بس ما بيوزّع ولا بيعتمد تعديل بعد التثبيت", () => {
    for (const p of ["orders.write", "orders.seal", "orders.cancel"] as const) expect(can("SALES_AGENT", p), p).toBe(true);
    for (const p of ["conversations.assign", "orders.amend", "orders.delete"] as const) expect(can("SALES_AGENT", p), p).toBe(false);
  });

  it("الدعم: بيرد وبيستلم وما بيشوف «ثبّت/عدّل» (بلا orders.write ولا seal)", () => {
    expect(can("SUPPORT_AGENT", "orders.read")).toBe(true);
    for (const p of ["orders.write", "orders.seal", "orders.cancel"] as const) expect(can("SUPPORT_AGENT", p), p).toBe(false);
  });

  it("المشاهد: قراءة بس", () => {
    for (const p of ROLE_PERMISSIONS.VIEWER!) expect(p.endsWith(".read"), p).toBe(true);
  });
});

describe("تصحيح المسارات (§5.3) — كل سطر بصلاحيته", () => {
  const perm = (file: string) => src(file);

  it.each([
    ["src/app/api/conversations/[id]/takeover/route.ts", 'permission: "conversations.takeover"'],
    ["src/app/api/conversations/[id]/release-ai/route.ts", 'permission: "conversations.takeover"'],
    ["src/app/api/channels/facebook/route.ts", 'permission: "channels.connect"'],
    ["src/app/api/conversations/[id]/coach/route.ts", 'permission: "conversations.reply"'],
    ["src/app/api/personas/[id]/versions/[version]/publish/route.ts", 'permission: "personas.publish"'],
    ["src/app/api/orders/[id]/route.ts", 'permission: "orders.delete"'],
    ["src/app/api/settings/oms/route.ts", 'permission: "integrations.manage"'],
    ["src/app/api/settings/oms/sync/route.ts", 'permission: "integrations.manage"'],
    ["src/app/api/settings/oms/test/route.ts", 'permission: "integrations.manage"'],
    ["src/app/api/settings/telegram-orders/route.ts", 'permission: "integrations.manage"'],
    ["src/app/api/settings/telegram-orders/test/route.ts", 'permission: "integrations.manage"'],
  ])("%s ← %s", (file, expected) => {
    expect(perm(file)).toContain(expected);
  });

  it("الربط ما بقي على settings.manage، وrollback الشخصية ما نكسر (نفس الصلاحية الأقوى)", () => {
    for (const f of ["settings/oms/route.ts", "settings/oms/sync/route.ts", "settings/oms/test/route.ts", "settings/telegram-orders/route.ts", "settings/telegram-orders/test/route.ts"]) {
      expect(src(`src/app/api/${f}`)).not.toContain('"settings.manage"');
    }
    expect(src("src/app/api/conversations/[id]/coach/route.ts")).toContain("rateLimit");
    expect(src("src/app/api/personas/[id]/versions/[version]/rollback/route.ts")).toContain('permission: "personas.publish"');
  });

  it("إسناد تحويل لغيرك = conversations.assign، وتحويل مستلمه غيرك كمان", () => {
    const r = src("src/app/api/handoffs/[id]/route.ts");
    expect(r).toMatch(/case "route": \{[\s\S]*?auth!\.require\("conversations\.assign"\)/);
    expect(r).toMatch(/case "release": \{[\s\S]*?assignedTo !== auth!\.userId\) auth!\.require\("conversations\.assign"\)/);
  });

  it("analytics/rebuild: الصلاحية على المساحة المستهدفة وبعضوية ACTIVE", () => {
    const r = src("src/app/api/analytics/rebuild/route.ts");
    expect(r).toContain('membership.status === "ACTIVE"');
    expect(r).toContain('"settings.manage"');
    expect(r).not.toContain('auth!.can("settings.manage")');
  });
});

describe("سلوك فعلي", () => {
  let db: ReturnType<typeof createFakeDb>;
  const WS = "ws-rbac";
  beforeEach(async () => {
    db = createFakeDb();
    await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
  });

  it("deleteOrder: بلا orders.delete ← 403 OWNER_ONLY_ORDERS، ومعه ← بيحذف", async () => {
    const o = (await db.order.create({ data: { workspaceId: WS, orderNumber: "ORD-D", customerId: "c", status: "NEW", total: 1, currency: "USD" } } as never)) as any;
    const denied = { userId: "u1", workspaceId: WS, can: (p: string) => p !== "orders.delete" };
    await expect(deleteOrder(db as Db, denied as never, o.id)).rejects.toMatchObject({ code: "OWNER_ONLY_ORDERS" });
    expect(db._stores.order).toHaveLength(1);
    const allowed = { userId: "u1", workspaceId: WS, can: () => true };
    await expect(deleteOrder(db as Db, allowed as never, o.id)).resolves.toMatchObject({ deleted: true });
    expect(db._stores.order).toHaveLength(0);
  });

  it("routeHandoff: كل عضو نشط بيملك handoffs.claim (الدعم · إضافات العضو) والمشاهد لا", async () => {
    await db.conversation.create({ data: { id: "cv", workspaceId: WS, customerId: "cu", channelId: "ch", channelConversationId: "x" } } as never);
    await db.humanHandoff.create({ data: { workspaceId: WS, conversationId: "cv", customerId: "cu", reason: "MANUAL", priority: "NORMAL", status: "OPEN" } } as never);
    const h = (db._stores.humanHandoff as any[])[0];
    const mk = async (id: string, role: string, permissions: string[] = []) => {
      await db.user.create({ data: { id, email: `${id}@x.io`, name: id, passwordHash: "x", availability: "ONLINE" } } as never);
      await db.workspaceMember.create({ data: { workspaceId: WS, userId: id, role, status: "ACTIVE", permissions } } as never);
    };
    await mk("viewer", "VIEWER");
    await mk("support", "SUPPORT_AGENT");
    const first = (await routeHandoff(db as Db, WS, h.id, "LEAST_LOADED")) as any;
    expect(first.assignedTo).toBe("support");
  });

  it("isOwnerRole", () => {
    expect(isOwnerRole("OWNER")).toBe(true);
    for (const r of ["ADMIN", "MANAGER", "VIEWER", "SUPER_ADMIN", null, undefined]) expect(isOwnerRole(r as never), String(r)).toBe(false);
  });
});

describe("ولا role === برّا rbac/ و members/ (قبول المرحلة 4)", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }
  it("بالمصدر كله", () => {
    const re = /\brole\s*[!=]==?\s*["'](OWNER|ADMIN|MANAGER|SALES_AGENT|SUPPORT_AGENT|VIEWER|SUPER_ADMIN)["']/;
    const bad = walk("src")
      .filter((f) => !f.replace(/\\/g, "/").includes("src/modules/rbac/") && !f.replace(/\\/g, "/").includes("src/modules/members/"))
      .filter((f) => re.test(src(f)));
    expect(bad).toEqual([]);
  });
});
