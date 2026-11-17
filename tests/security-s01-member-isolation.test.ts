import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { inviteMember, resetMemberPassword, updateMember } from "@/modules/members/service";

/**
 * S-01 — عزل المساحات بإدارة الأعضاء (التفاصيل: docs/HANDOVER-2026-10-27.md §4.1).
 */

const WS_A = "ws-a";
const WS_B = "ws-b";
type Db = Prisma.TransactionClient;

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb: mk } = await import("./helpers/inmemory-db");
  const db = mk();
  (globalThis as Record<string, unknown>).__s01Db = db;
  return { prisma: db };
});
vi.mock("@/core/api/rate-limit", () => ({
  rateLimitDb: async () => undefined,
  rateLimitMemory: () => undefined,
  clearRateLimitMemory: () => undefined,
}));
vi.mock("@/modules/auth/context", () => ({
  getAuthContext: async () => ({
    userId: (globalThis as any).__s01Actor,
    workspaceId: WS_A,
    role: "OWNER",
    memberPermissions: [],
    can: () => true,
    require: () => undefined,
  }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

let db: ReturnType<typeof createFakeDb>;
let ownerA: any;
let ownerB: any;

const mkUser = async (email: string, hash = "hash-" + email) =>
  (await db.user.create({ data: { email, name: email, passwordHash: hash } })) as any;
const addMember = async (workspaceId: string, userId: string, role: string, status = "ACTIVE") =>
  (await db.workspaceMember.create({ data: { workspaceId, userId, role, status } } as never)) as any;
const pwd = async (id: string) => ((await db.user.findUnique({ where: { id } })) as any).passwordHash as string;
const ctxA = () => ({ userId: ownerA.id, workspaceId: WS_A });

beforeEach(async () => {
  db = (await import("@/core/db/prisma")).prisma as unknown as ReturnType<typeof createFakeDb>;
  for (const k of Object.keys(db._stores)) (db._stores as any)[k].length = 0;
  await db.workspace.create({ data: { id: WS_A, name: "A", slug: "a" } } as never);
  await db.workspace.create({ data: { id: WS_B, name: "B", slug: "b" } } as never);
  ownerA = await mkUser("owner-a@x.test");
  ownerB = await mkUser("owner-b@x.test", "B-ORIGINAL-HASH");
  await addMember(WS_A, ownerA.id, "OWNER");
  await addMember(WS_B, ownerB.id, "OWNER");
  (globalThis as any).__s01Actor = ownerA.id;
});

describe("S-01 resetMemberPassword", () => {
  it("1) حساب من مساحة تانية ← 403 وكلمة سره ما تغيّرت", async () => {
    const inv = (await inviteMember(db as Db, ctxA(), { email: "owner-b@x.test", role: "VIEWER" })) as any;
    await expect(
      resetMemberPassword(db as Db, ctxA(), inv.id, { newPassword: "Attacker#2026" })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await pwd(ownerB.id)).toBe("B-ORIGINAL-HASH");
  });

  it("2) صف مدعو (INVITED) ← 403 حتى لو الحساب بمساحة وحدة", async () => {
    const lone = await mkUser("lone@x.test", "LONE-HASH");
    const row = await addMember(WS_A, lone.id, "VIEWER", "INVITED");
    await expect(
      resetMemberPassword(db as Db, ctxA(), row.id, { newPassword: "Attacker#2026" })
    ).rejects.toMatchObject({ statusCode: 403, code: "MEMBER_NOT_ACTIVE" });
    expect(await pwd(lone.id)).toBe("LONE-HASH");
  });

  it("3) عضو فعّال مشترك بين مساحتين ← 403 USER_SHARED_ACROSS_WORKSPACES", async () => {
    const shared = await mkUser("shared@x.test", "SHARED-HASH");
    const row = await addMember(WS_A, shared.id, "SALES_AGENT");
    await addMember(WS_B, shared.id, "SALES_AGENT");
    await expect(
      resetMemberPassword(db as Db, ctxA(), row.id, { newPassword: "Attacker#2026" })
    ).rejects.toMatchObject({ statusCode: 403, code: "USER_SHARED_ACROSS_WORKSPACES" });
    expect(await pwd(shared.id)).toBe("SHARED-HASH");
  });

  it("المسار المشروع بيضل شغّال: عضو فعّال بمساحة وحدة ← بتتغيّر", async () => {
    const mine = await mkUser("mine@x.test", "OLD");
    const row = await addMember(WS_A, mine.id, "SALES_AGENT");
    const res = await resetMemberPassword(db as Db, ctxA(), row.id, { newPassword: "Fresh#Pass2026" });
    expect(res.passwordReset).toBe(true);
    expect(await pwd(mine.id)).not.toBe("OLD");
  });
});

describe("S-01 updateMember", () => {
  it("4) تفعيل صف مدعو من الإدارة ← 422 (التفعيل بقبول صاحب الحساب)", async () => {
    const victim = await mkUser("victim@x.test");
    const row = await addMember(WS_A, victim.id, "VIEWER", "INVITED");
    await expect(updateMember(db as Db, ctxA(), row.id, { status: "ACTIVE" })).rejects.toMatchObject({
      statusCode: 422,
      code: "INVITE_NOT_ACCEPTED",
    });
    const after = (await db.workspaceMember.findUnique({ where: { id: row.id } })) as any;
    expect(after.status).toBe("INVITED");
  });

  it("تعليق/تفعيل عضو فعّال أو موقوف ما تأثّر", async () => {
    const m = await mkUser("m@x.test");
    const row = await addMember(WS_A, m.id, "VIEWER", "ACTIVE");
    await updateMember(db as Db, ctxA(), row.id, { status: "SUSPENDED" });
    await updateMember(db as Db, ctxA(), row.id, { status: "ACTIVE" });
    expect(((await db.workspaceMember.findUnique({ where: { id: row.id } })) as any).status).toBe("ACTIVE");
  });
});

describe("S-01 رد الدعوة الموحّد", () => {
  it("إيميل موجود وإيميل مش موجود ← نفس الحالة ونفس الجسم", async () => {
    const { POST } = await import("@/app/api/workspaces/members/route");
    const call = (email: string) =>
      POST(
        new NextRequest("http://localhost/api/workspaces/members", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, role: "VIEWER" }),
        }),
        { params: {} } as never
      );
    const exists = await call("owner-b@x.test");
    const ghost = await call("nobody-here@x.test");
    expect(exists.status).toBe(ghost.status);
    expect(await exists.json()).toEqual(await ghost.json());
  });
});
