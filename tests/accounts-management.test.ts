import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createMember, resetMemberPassword } from "@/modules/members/service";
import { updateOwnProfile } from "@/modules/auth/profile";
import { hashPassword, verifyPassword } from "@/modules/auth/password";

/**
 * إدارة الحسابات:
 * 1) إنشاء حساب جديد مباشرة من إدارة الفريق (اسم + بريد + كلمة مرور) — بلا انتظار تسجيل.
 * 2) إعادة تعيين كلمة مرور عضو من الإدارة.
 * 3) «حسابي»: تغيير الاسم بلا كلمة مرور، والبريد وكلمة المرور بكلمة المرور الحالية.
 */

const WS = "ws-accounts";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

beforeEach(async () => {
  db = createFakeDb();
  const owner = (await db.user.create({
    data: { email: "owner@x.test", name: "مالك", passwordHash: "seed-hash" },
  })) as unknown as { id: string };
  await db.workspace.create({ data: { id: WS, name: "W", slug: "w" } } as never);
  await db.workspaceMember.create({
    data: { workspaceId: WS, userId: owner.id, role: "OWNER", status: "ACTIVE" },
  } as never);
});

async function ownerUserId(): Promise<string> {
  const stores = (db as unknown as { _stores: Record<string, Array<Record<string, unknown>>> })._stores;
  return String(stores.user.find((u) => u.email === "owner@x.test")!.id);
}

async function store(userId: string, wsId = WS) {
  return { userId, workspaceId: wsId };
}

describe("createMember — إنشاء حساب مباشرة من الإدارة", () => {
  it("ينشئ المستخدم + عضوية ACTIVE، وكلمة المرور تنخزن مُعمّاة فقط", async () => {
    const member = (await createMember(db as Db, await store(await ownerUserId()), {
      name: "أنس المبيعات",
      email: "sales@x.test",
      password: "S3cure-pass!",
      role: "SALES_AGENT",
    })) as unknown as { userId: string; status: string };

    expect(member.status).toBe("ACTIVE");
    const stores = (db as unknown as { _stores: Record<string, Array<Record<string, unknown>>> })._stores;
    const user = stores.user.find((u) => u.email === "sales@x.test")!;
    expect(user.name).toBe("أنس المبيعات");
    expect(String(user.passwordHash)).not.toBe("S3cure-pass!");
    expect(await verifyPassword("S3cure-pass!", String(user.passwordHash))).toBe(true);
    expect(stores.workspaceMember.some((m) => m.userId === user.id && m.status === "ACTIVE")).toBe(true);

    const actions = (stores.auditLog as Array<Record<string, unknown>>).map((a) => a.action);
    expect(actions).toContain("member.created");
  });

  it("البريد الموجود مسبقًا = رفض صريح (سياسة إنشاء جديد مو دعوة)", async () => {
    await expect(
      createMember(db as Db, await store(await ownerUserId()), {
        name: "مكرر", email: "owner@x.test", password: "S3cure-pass!", role: "VIEWER",
      })
    ).rejects.toMatchObject({ code: "EMAIL_TAKEN" });
  });

  it("المالك بقدر ينشئ حساب OWNER، و SUPER_ADMIN ممنوعة من هذا الباب", async () => {
    const ctx = await store(await ownerUserId());
    await expect(
      createMember(db as Db, ctx, { name: "شريك", email: "o2@x.test", password: "S3cure-pass!", role: "OWNER" })
    ).resolves.toBeTruthy();
    await expect(
      createMember(db as Db, ctx, { name: "ممنوع", email: "o3@x.test", password: "S3cure-pass!", role: "SUPER_ADMIN" })
    ).rejects.toMatchObject({ code: "INVALID_ROLE" });
  });

  it("ADMIN (غير المالك) بقدر ينشئ عضو عادي، ما بقدر ينشئ OWNER", async () => {
    const adminUser = (await db.user.create({
      data: { email: "admin@x.test", name: "أ", passwordHash: "h" },
    })) as unknown as { id: string };
    await db.workspaceMember.create({
      data: { workspaceId: WS, userId: adminUser.id, role: "ADMIN", status: "ACTIVE" },
    } as never);
    const ctx = await store(adminUser.id);

    await createMember(db as Db, ctx, {
      name: "موظف", email: "vip@x.test", password: "S3cure-pass!", role: "SUPPORT_AGENT",
    });
    await expect(
      createMember(db as Db, ctx, { name: "ترقية", email: "newowner@x.test", password: "S3cure-pass!", role: "OWNER" })
    ).rejects.toMatchObject({ code: "OWNER_ROLE_REQUIRED" });
  });
});

describe("resetMemberPassword — إعادة تعيين كلمة مرور عضو", () => {
  it("كلمة المرور تتبدل، القديمة ما بتنفع، والسجل ما بذكر قيمة كلمة المرور", async () => {
    const created = (await createMember(db as Db, await store(await ownerUserId()), {
      name: "موظف", email: "emp@x.test", password: "old-pass-123", role: "SALES_AGENT",
    })) as unknown as { id: string };

    await resetMemberPassword(db as Db, await store(await ownerUserId()), created.id, {
      newPassword: "brand-new-77",
    });

    const stores = (db as unknown as { _stores: Record<string, Array<Record<string, unknown>>> })._stores;
    const user = stores.user.find((u) => u.email === "emp@x.test")!;
    expect(await verifyPassword("brand-new-77", String(user.passwordHash))).toBe(true);
    expect(await verifyPassword("old-pass-123", String(user.passwordHash))).toBe(false);

    const audits = (stores.auditLog as Array<Record<string, unknown>>).filter((a) => a.action === "member.password_reset");
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain("brand-new-77");
  });

  it("العضو ما بيرجّع كلمة مروره من هنا (بالصلاحية المحظورة) — والاعتماد صفحة «حسابي»", async () => {
    const ctx = await store(await ownerUserId());
    const created = (await createMember(db as Db, ctx, {
      name: "موظف", email: "self@x.test", password: "old-pass-123", role: "SALES_AGENT",
    })) as unknown as { id: string; userId: string };
    await expect(
      resetMemberPassword(db as Db, { userId: created.userId, workspaceId: WS }, created.id, { newPassword: "n-a-t-u-r-e-8" })
    ).rejects.toMatchObject({ code: "CANNOT_EDIT_SELF" });
  });

  it("ما بيل مربع لصف OWNER إلا مالك", async () => {
    const ownerCtx = await store(await ownerUserId());
    const member = (await createMember(db as Db, ownerCtx, {
      name: "شريك", email: "sh@x.test", password: "S3cure-pass!", role: "OWNER",
    })) as unknown as { id: string; userId: string };
    const adminUser = (await db.user.create({
      data: { email: "admin2@x.test", name: "أ", passwordHash: "h" },
    })) as unknown as { id: string };
    await db.workspaceMember.create({
      data: { workspaceId: WS, userId: adminUser.id, role: "ADMIN", status: "ACTIVE" },
    } as never);

    await expect(
      resetMemberPassword(db as Db, { userId: adminUser.id, workspaceId: WS }, member.id, { newPassword: "n-a-t-u-r-e-8" })
    ).rejects.toMatchObject({ code: "OWNER_ROLE_REQUIRED" });
  });
});

describe("updateOwnProfile — صفحة «حسابي»", () => {
  it("الاسم يتبدل بلا كلمة مرور، والبريد وكلمة المرور تحتاج كلمة المرور الحالية", async () => {
    const uid = await ownerUserId();
    const ctx = await store(uid);
    await db.user.update({ where: { id: uid }, data: { passwordHash: await hashPassword("current-pass-1") } } as never);

    const renamed = (await updateOwnProfile(db as Db, ctx, { name: "اسم جديد" })) as unknown as { name: string };
    expect(renamed.name).toBe("اسم جديد");

    await expect(updateOwnProfile(db as Db, ctx, { email: "owner2@x.test" })).rejects.toMatchObject({
      code: "CURRENT_PASSWORD_REQUIRED",
    });
    await expect(
      updateOwnProfile(db as Db, ctx, { email: "owner2@x.test", currentPassword: "wrong-pass" })
    ).rejects.toMatchObject({ code: "INVALID_CURRENT_PASSWORD" });

    const changed = (await updateOwnProfile(db as Db, ctx, {
      email: "owner2@x.test", currentPassword: "current-pass-1",
    })) as unknown as { email: string };
    expect(changed.email).toBe("owner2@x.test");

    await updateOwnProfile(db as Db, ctx, { newPassword: "fresh-pass-9x", currentPassword: "current-pass-1" });
    const stores = (db as unknown as { _stores: Record<string, Array<Record<string, unknown>>> })._stores;
    const freshHash = stores.user.find((u) => u.id === uid)!.passwordHash as string;
    expect(await verifyPassword("fresh-pass-9x", freshHash)).toBe(true);
    expect(await verifyPassword("current-pass-1", freshHash)).toBe(false);
  });

  it("بريد مستخدم من حساب ثاني = رفض، والبريد يتخفّض lowercase", async () => {
    const uid = await ownerUserId();
    const ctx = await store(uid);
    await db.user.update({ where: { id: uid }, data: { passwordHash: await hashPassword("pw-123456") } } as never);
    await db.user.create({ data: { email: "taken@x.test", name: "لا", passwordHash: "h" } } as never);

    await expect(
      updateOwnProfile(db as Db, ctx, { email: "taken@x.test", currentPassword: "pw-123456" })
    ).rejects.toMatchObject({ code: "EMAIL_TAKEN" });

    const res = (await updateOwnProfile(db as Db, ctx, {
      email: "MIXED@X.TEST", currentPassword: "pw-123456",
    })) as unknown as { email: string };
    expect(res.email).toBe("mixed@x.test");
  });

  it("بلا أي حقل = رفض صريح", async () => {
    await expect(updateOwnProfile(db as Db, await store(await ownerUserId()), {})).rejects.toMatchObject({ code: "EMPTY_UPDATE" });
  });
});
