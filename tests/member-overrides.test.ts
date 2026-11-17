/**
 * الحزمة 4.2 — الفريق (04-PERMISSIONS §5.4–5.5): صلاحيات العضو الإضافية بقواعد منح ·
 * إنشاء عضو هو الطريق الوحيد (الدعوة مطفية) · كلمة مرور مؤقتة بتنطلب تغييرها · المنتقي حسب الرتبة.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { acceptInvite, assignableRolesFor, createMember, inviteMember, resetMemberPassword, updateMember } from "@/modules/members/service";
import { updateOwnProfile } from "@/modules/auth/profile";
import { hashPassword } from "@/modules/auth/password";
import { isMemberInviteAllowed } from "@/core/signup-gate";
import { hasPermission } from "@/modules/rbac/permissions";

type Db = Prisma.TransactionClient;
const WS = "ws-ov";
const src = (p: string) => readFileSync(p, "utf8");
let db: ReturnType<typeof createFakeDb>;
let ownerId: string;
let adminId: string;
let managerId: string;

const canFor = (role: string) => (p: string) => hasPermission(role, [], p as never);
const ownerCtx = () => ({ userId: ownerId, workspaceId: WS, can: canFor("OWNER") });
const adminCtx = () => ({ userId: adminId, workspaceId: WS, can: canFor("ADMIN") });
const managerCtx = () => ({ userId: managerId, workspaceId: WS, can: canFor("MANAGER") });

async function mkUser(email: string, name = "عضو") {
  return (await db.user.create({ data: { email, name, passwordHash: "x" } })) as any;
}
async function addMember(userId: string, role: string, status = "ACTIVE", permissions: string[] = []) {
  return (await db.workspaceMember.create({ data: { workspaceId: WS, userId, role, status, permissions } } as never)) as any;
}

const saved = process.env.ALLOW_MEMBER_INVITES;
beforeEach(async () => {
  delete process.env.ALLOW_MEMBER_INVITES;
  db = createFakeDb();
  await db.workspace.create({ data: { id: WS, name: "W", slug: "w" } } as never);
  const o = await mkUser("owner@x.test", "مالك");
  const a = await mkUser("admin@x.test", "شريك");
  const m = await mkUser("manager@x.test", "مشرف");
  ownerId = o.id;
  adminId = a.id;
  managerId = m.id;
  await addMember(o.id, "OWNER");
  await addMember(a.id, "ADMIN");
  await addMember(m.id, "MANAGER");
});
afterEach(() => {
  if (saved === undefined) delete process.env.ALLOW_MEMBER_INVITES;
  else process.env.ALLOW_MEMBER_INVITES = saved;
});

describe("الدعوة مطفية افتراضيًا (ALLOW_MEMBER_INVITES)", () => {
  it("افتراضي مطفي، وصريح فقط (1|true|yes) بيفتحها", () => {
    expect(isMemberInviteAllowed()).toBe(false);
    for (const v of ["1", "true", "YES"]) {
      process.env.ALLOW_MEMBER_INVITES = v;
      expect(isMemberInviteAllowed(), v).toBe(true);
    }
    for (const v of ["0", "false", "", "maybe"]) {
      process.env.ALLOW_MEMBER_INVITES = v;
      expect(isMemberInviteAllowed(), v).toBe(false);
    }
  });

  it("inviteMember ← 403 MEMBER_INVITES_DISABLED حتى للمالك، وما في صف اتعمل", async () => {
    await mkUser("someone@x.test");
    const before = db._stores.workspaceMember.length;
    await expect(inviteMember(db as Db, ownerCtx() as never, { email: "someone@x.test", role: "VIEWER" })).rejects.toMatchObject({ statusCode: 403, code: "MEMBER_INVITES_DISABLED" });
    expect(db._stores.workspaceMember.length).toBe(before);
  });

  it("وإذا انفتحت الدعوة، قبول الدعوة شغّال (المسار محفوظ بالكود)", async () => {
    process.env.ALLOW_MEMBER_INVITES = "1";
    const u = await mkUser("someone@x.test");
    await inviteMember(db as Db, ownerCtx() as never, { email: "someone@x.test", role: "VIEWER" });
    const acc = (await acceptInvite(db as Db, u.id, WS)) as any;
    expect(acc.status).toBe("ACTIVE");
  });
});

describe("قواعد المنح", () => {
  async function newMember(role = "SALES_AGENT") {
    return (await createMember(db as Db, ownerCtx() as never, { name: "موظف جديد", email: `n${Math.random().toString(36).slice(2, 7)}@x.test`, password: "Temp#12345", role })) as any;
  }

  it("المانح لازم يملك اللي بيمنحه: مشرف بيمنح اللي عنده، وما بيمنح اللي ما عنده (CANNOT_GRANT)", async () => {
    const target = await newMember("SALES_AGENT");
    const ok = await updateMember(db as Db, managerCtx() as never, target.id, { permissions: ["orders.amend", "products.wholesale"] });
    expect((ok as any).permissions).toEqual(["orders.amend", "products.wholesale"]);
    await expect(updateMember(db as Db, managerCtx() as never, target.id, { permissions: ["integrations.manage"] })).rejects.toMatchObject({ statusCode: 403, code: "CANNOT_GRANT" });
    await expect(updateMember(db as Db, managerCtx() as never, target.id, { permissions: ["users.manage"] })).rejects.toMatchObject({ code: "CANNOT_GRANT" });
    // ما اتغيّر شي بالمرفوض
    expect(((await db.workspaceMember.findUnique({ where: { id: target.id } })) as any).permissions).toEqual(["orders.amend", "products.wholesale"]);
  });

  it("رموز حساسة (orders.delete · team.owners · integrations.manage · users.manage) ما بتنمنح كإضافة لدور مش مالك/شريك", async () => {
    const target = await newMember("SALES_AGENT");
    for (const p of ["orders.delete", "team.owners", "integrations.manage", "users.manage"]) {
      await expect(updateMember(db as Db, ownerCtx() as never, target.id, { permissions: [p] }), p).rejects.toMatchObject({ statusCode: 422, code: "PERMISSION_NOT_GRANTABLE" });
    }
    // والمالك بيمنحها لحاله لعضو دوره شريك (ADMIN) — مسموح
    const partner = await newMember("ADMIN");
    const ok = await updateMember(db as Db, ownerCtx() as never, partner.id, { permissions: ["integrations.manage"] });
    expect((ok as any).permissions).toEqual(["integrations.manage"]);
  });

  it("الشريك ما بيمنح orders.delete (ما بيملكها) حتى لو الهدف شريك", async () => {
    const partner = await newMember("ADMIN");
    await expect(updateMember(db as Db, adminCtx() as never, partner.id, { permissions: ["orders.delete"] })).rejects.toMatchObject({ code: "CANNOT_GRANT" });
  });

  it("إنشاء عضو بإضافات: نفس قاعدة المنح", async () => {
    await expect(
      createMember(db as Db, managerCtx() as never, { name: "عضو", email: "g@x.test", password: "Temp#12345", role: "SALES_AGENT", permissions: ["integrations.manage"] })
    ).rejects.toMatchObject({ code: "CANNOT_GRANT" });
  });

  it("رمز مجهول ← 422 INVALID_PERMISSIONS", async () => {
    const target = await newMember();
    await expect(updateMember(db as Db, ownerCtx() as never, target.id, { permissions: ["nope.nope"] })).rejects.toMatchObject({ code: "INVALID_PERMISSIONS" });
  });
});

describe("تغيير الدور بيمسح الإضافات", () => {
  it("دور جديد بلا permissions ← الإضافات بتنمسح · ومعها permissions ← بتنحفظ الجديدة · نفس الدور ← ما بيمسح", async () => {
    const m = (await createMember(db as Db, ownerCtx() as never, { name: "عضو", email: "r@x.test", password: "Temp#12345", role: "SALES_AGENT", permissions: ["orders.amend"] })) as any;
    const same = (await updateMember(db as Db, ownerCtx() as never, m.id, { role: "SALES_AGENT", status: "ACTIVE" })) as any;
    expect(same.permissions).toEqual(["orders.amend"]);
    const changed = (await updateMember(db as Db, ownerCtx() as never, m.id, { role: "SUPPORT_AGENT" })) as any;
    expect(changed.role).toBe("SUPPORT_AGENT");
    expect(changed.permissions).toEqual([]);
    const both = (await updateMember(db as Db, ownerCtx() as never, m.id, { role: "MANAGER", permissions: ["catalogs.assign"] })) as any;
    expect(both.permissions).toEqual(["catalogs.assign"]);
  });
});

describe("كلمة مرور مؤقتة ← تغيير إلزامي", () => {
  it("createMember بيحط mustChangePassword، وإعادة التعيين كمان، وتغييرها من «حسابي» بيمسحه", async () => {
    const m = (await createMember(db as Db, ownerCtx() as never, { name: "عضو", email: "p@x.test", password: "Temp#12345", role: "VIEWER" })) as any;
    const user = () => (db._stores.user as any[]).find((u) => u.id === m.userId);
    expect(user().mustChangePassword).toBe(true);
    // تحسب: الحساب بدّل كلمته
    await db.user.update({ where: { id: m.userId }, data: { passwordHash: await hashPassword("Temp#12345") } } as never);
    await updateOwnProfile(db as Db, { userId: m.userId, workspaceId: WS } as never, { currentPassword: "Temp#12345", newPassword: "MyOwn#2026!" });
    expect(user().mustChangePassword).toBe(false);
    // إعادة تعيين من الإدارة ← بترجع تنطلب
    await resetMemberPassword(db as Db, ownerCtx() as never, m.id, { newPassword: "Reset#12345" });
    expect(user().mustChangePassword).toBe(true);
  });

  it("الشاشة الإلزامية بالـ layout بدل القشرة، بـ PasswordInput، ومن /api/auth/me", () => {
    const layout = src("src/app/(dashboard)/layout.tsx");
    expect(layout).toContain("user.mustChangePassword");
    expect(layout.indexOf("ForcePasswordChange")).toBeGreaterThan(-1);
    expect(src("src/components/auth/force-password-change.tsx")).toContain("PasswordInput");
    expect(src("src/components/auth/force-password-change.tsx")).not.toMatch(/type="password"/);
    expect(src("src/app/api/auth/me/route.ts")).toContain("mustChangePassword: true");
  });

  it("الترحيل إضافي بالكامل (عمود بقيمة افتراضية، بلا حذف)", () => {
    const sql = src("prisma/migrations/20261118000000_member_must_change_password/migration.sql");
    expect(sql).toMatch(/ADD COLUMN\s+"mustChangePassword" BOOLEAN NOT NULL DEFAULT false/);
    expect(sql).not.toMatch(/DROP|ALTER COLUMN|TRUNCATE|DELETE/i);
  });
});

describe("المنتقي حسب رتبة الفاعل", () => {
  it("المالك بيعطي كل الأدوار، غيره بلا «مالك»", () => {
    expect(assignableRolesFor("OWNER")).toContain("OWNER");
    for (const r of ["ADMIN", "MANAGER", "SALES_AGENT", null, undefined]) expect(assignableRolesFor(r as never), String(r)).not.toContain("OWNER");
    expect(assignableRolesFor("ADMIN")).toContain("ADMIN");
  });
});

describe("المسارات والواجهة", () => {
  it("مسارات الأعضاء بحد سرعة، وبتمرّر can للخدمة، والقائمة بترجّع assignableRoles و invitesEnabled", () => {
    const list = src("src/app/api/workspaces/members/route.ts");
    const one = src("src/app/api/workspaces/members/[id]/route.ts");
    expect(list.match(/rateLimit:/g)?.length).toBe(1);
    expect(one.match(/rateLimit:/g)?.length).toBe(2);
    expect(list).toContain("can: (p: string) => auth!.can(");
    expect(one).toContain("can: (p: string) => auth!.can(");
    expect(list).toContain("assignableRoles");
    expect(list).toContain("invitesEnabled");
  });

  it("صفحة الفريق: لوحة صلاحيات العضو + منتقي بالأدوار المسموحة + دعوة مخفية + تأكيد قبل مسح الإضافات", () => {
    const t = src("src/app/(dashboard)/settings/team/team-view.tsx");
    expect(t).toContain("<MemberPermissionsDialog");
    expect(t).toContain("roleChoices(");
    expect(t).toContain("{invitesEnabled && (");
    expect(t).toContain("تغيير الدور بيمسح الصلاحيات الإضافية");
    const d = src("src/app/(dashboard)/settings/team/member-permissions.tsx");
    for (const s of ["من دوره", "PERMISSION_AREAS", "احفظ الصلاحيات", "اختار دور أقل"]) expect(d, s).toContain(s);
  });
});
