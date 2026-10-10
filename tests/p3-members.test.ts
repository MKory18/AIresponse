import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import {
  acceptInvite,
  inviteMember,
  listMembers,
  removeMember,
  updateMember,
} from "@/modules/members/service";
import { updateWorkspaceDetails } from "@/modules/workspaces/service";

/**
 * P3 team management — service level on the in-memory double.
 * No new tables: invitations reuse WorkspaceMember(INVITED + expiresAt).
 */
const WS = "ws-p3";
const OTHER = "ws-p3-other";
const OWNER = { userId: "owner-1", workspaceId: WS };
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let ownerMemberId: string;

async function mkUser(email: string, name = "عضو") {
  return (await db.user.create({ data: { email, name, passwordHash: "x" } })) as any;
}

async function seedOwner() {
  db = createFakeDb();
  const owner = await mkUser("owner@x.test", "مالك");
  OWNER.userId = owner.id;
  await db.workspace.create({ data: { id: WS, name: "W", slug: "w" } } as never);
  const m = (await db.workspaceMember.create({
    data: { workspaceId: WS, userId: owner.id, role: "OWNER", status: "ACTIVE" },
  } as never)) as any;
  ownerMemberId = m.id;
}

beforeEach(seedOwner);

describe("P3 invitations (INVITED + expiry, no new tables)", () => {
  it("invites an existing user, lists them, accepts, and audits", async () => {
    const u = await mkUser("agent@x.test");
    const inv = (await inviteMember(db as Db, OWNER, { email: "agent@x.test", role: "SALES_AGENT" })) as any;
    expect(inv.status).toBe("INVITED");
    expect(new Date(inv.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const list = await listMembers(db as Db, WS);
    expect(list.map((m) => m.user.email).sort()).toEqual(["agent@x.test", "owner@x.test"]);
    const acc = (await acceptInvite(db as Db, u.id, WS)) as any;
    expect(acc.status).toBe("ACTIVE");
    expect(acc.expiresAt).toBeNull();
    const actions = (db._stores.auditLog as any[]).map((a) => a.action);
    expect(actions).toContain("member.invited");
    expect(actions).toContain("member.accepted");
  });

  it("refuses unknown users (no fabrication), duplicates, and suspended re-invites", async () => {
    await expect(inviteMember(db as Db, OWNER, { email: "ghost@x.test", role: "VIEWER" })).rejects.toThrow();
    await inviteMember(db as Db, OWNER, { email: (await mkUser("a@x.test")).email, role: "VIEWER" });
    await expect(inviteMember(db as Db, OWNER, { email: "owner@x.test", role: "VIEWER" })).rejects.toThrow();
    const s = await mkUser("s@x.test");
    await db.workspaceMember.create({ data: { workspaceId: WS, userId: s.id, role: "VIEWER", status: "SUSPENDED" } } as never);
    await expect(inviteMember(db as Db, OWNER, { email: "s@x.test", role: "VIEWER" })).rejects.toMatchObject({
      code: "MEMBER_SUSPENDED",
    });
  });

  it("refreshes pending invitations and rejects expired accepts", async () => {
    const u = await mkUser("r@x.test");
    await inviteMember(db as Db, OWNER, { email: "r@x.test", role: "VIEWER" });
    const again = (await inviteMember(db as Db, OWNER, { email: "r@x.test", role: "ADMIN" })) as any;
    expect(again.role).toBe("ADMIN");
    expect((await listMembers(db as Db, WS)).filter((m) => m.user.email === "r@x.test")).toHaveLength(1);
    // Expire manually, then accept must refuse.
    const row = (db._stores.workspaceMember as any[]).find((m) => m.userId === u.id);
    row.expiresAt = new Date(Date.now() - 1000);
    await expect(acceptInvite(db as Db, u.id, WS)).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
  });

  it("accept is self-only and workspace-scoped", async () => {
    const u = await mkUser("self@x.test");
    await inviteMember(db as Db, OWNER, { email: "self@x.test", role: "VIEWER" });
    await expect(acceptInvite(db as Db, "someone-else", WS)).rejects.toThrow();
    await expect(acceptInvite(db as Db, u.id, OTHER)).rejects.toThrow();
  });
});

describe("P3 roles, suspension, ownership floor", () => {
  async function activeMember(email: string, role = "VIEWER") {
    const u = await mkUser(email);
    await inviteMember(db as Db, OWNER, { email, role });
    const acc = (await acceptInvite(db as Db, u.id, WS)) as any;
    return { user: u, memberId: acc.id };
  }

  it("updates role/permissions/suspension with audit, never self", async () => {
    const { memberId } = await activeMember("e@x.test");
    const upd = (await updateMember(db as Db, OWNER, memberId, { role: "MANAGER", permissions: ["orders.write"] })) as any;
    expect(upd.role).toBe("MANAGER");
    const sus = (await updateMember(db as Db, OWNER, memberId, { status: "SUSPENDED" })) as any;
    expect(sus.status).toBe("SUSPENDED");
    await expect(updateMember(db as Db, OWNER, ownerMemberId, { role: "VIEWER" })).rejects.toMatchObject({
      code: "CANNOT_EDIT_SELF",
    });
    const actions = (db._stores.auditLog as any[]).map((a) => a.action);
    expect(actions).toContain("member.updated");
  });

  it("refuses SUPER_ADMIN assignment, unknown roles and permissions", async () => {
    await expect(inviteMember(db as Db, OWNER, { email: (await mkUser("s1@x.test")).email, role: "SUPER_ADMIN" })).rejects.toMatchObject({
      code: "INVALID_ROLE",
    });
    await expect(
      inviteMember(db as Db, OWNER, { email: (await mkUser("s2@x.test")).email, role: "NOPE" })
    ).rejects.toMatchObject({ code: "INVALID_ROLE" });
    await expect(
      inviteMember(db as Db, OWNER, { email: (await mkUser("s3@x.test")).email, role: "VIEWER", permissions: ["root.all"] })
    ).rejects.toMatchObject({ code: "INVALID_PERMISSIONS" });
  });

  it("protects the last active owner (demote/suspend/remove all refused)", async () => {
    const { user, memberId } = await activeMember("o2@x.test", "ADMIN");
    const O2 = { userId: user.id, workspaceId: WS };
    // Promote second admin to owner first — then demoting the first is fine.
    await updateMember(db as Db, OWNER, memberId, { role: "OWNER" });
    await updateMember(db as Db, O2, ownerMemberId, { role: "ADMIN" });
    // Now o2 is the only owner: demote/suspend/remove refused (by the other admin).
    await expect(updateMember(db as Db, OWNER, memberId, { role: "VIEWER" })).rejects.toMatchObject({
      code: "OWNER_REQUIRED",
    });
    await expect(updateMember(db as Db, OWNER, memberId, { status: "SUSPENDED" })).rejects.toMatchObject({
      code: "OWNER_REQUIRED",
    });
    await expect(removeMember(db as Db, OWNER, memberId)).rejects.toMatchObject({
      code: "OWNER_REQUIRED",
    });
  });

  it("concurrent demotes of both owners never leave zero owners (race compensated)", async () => {
    const a = await activeMember("ca@x.test", "ADMIN");
    const b = await activeMember("cb@x.test", "ADMIN");
    await updateMember(db as Db, OWNER, a.memberId, { role: "OWNER" });
    await updateMember(db as Db, OWNER, b.memberId, { role: "OWNER" });
    // Demote the original owner first so only a/b remain owners.
    const ownerRow = (db._stores.workspaceMember as any[]).find((m) => m.id === ownerMemberId);
    ownerRow.role = "ADMIN";
    const results = await Promise.allSettled([
      updateMember(db as Db, { userId: a.user.id, workspaceId: WS }, b.memberId, { role: "VIEWER" }),
      updateMember(db as Db, { userId: b.user.id, workspaceId: WS }, a.memberId, { role: "VIEWER" }),
    ]);
    // Invariant under every interleaving: at least one active owner remains,
    // and every refusal is the owner floor (never a silent over-demotion).
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "OWNER_REQUIRED" });
    }
    const owners = (db._stores.workspaceMember as any[]).filter((m) => m.role === "OWNER" && m.status === "ACTIVE");
    expect(owners.length).toBeGreaterThanOrEqual(1);
  });

  it("removes members with audit, never self, never cross-workspace", async () => {
    const { memberId } = await activeMember("gone@x.test");
    expect(await removeMember(db as Db, OWNER, memberId)).toEqual({ removed: true });
    await expect(removeMember(db as Db, OWNER, ownerMemberId)).rejects.toMatchObject({ code: "CANNOT_EDIT_SELF" });
    await expect(removeMember(db as Db, OWNER, "missing")).rejects.toThrow();
    const actions = (db._stores.auditLog as any[]).map((a) => a.action);
    expect(actions).toContain("member.removed");
  });
});

describe("P3 workspace isolation + details", () => {
  it("lists only the requested workspace members", async () => {
    await db.workspace.create({ data: { id: OTHER, name: "O", slug: "o" } } as never);
    const u = await mkUser("other@x.test");
    await db.workspaceMember.create({ data: { workspaceId: OTHER, userId: u.id, role: "OWNER", status: "ACTIVE" } } as never);
    expect((await listMembers(db as Db, WS)).map((m) => m.user.email)).toEqual(["owner@x.test"]);
    expect((await listMembers(db as Db, OTHER)).map((m) => m.user.email)).toEqual(["other@x.test"]);
  });

  it("updates the session workspace only (no workspaceId input to tamper)", async () => {
    await db.workspace.create({ data: { id: OTHER, name: "O", slug: "o" } } as never);
    const upd = (await updateWorkspaceDetails(db as Db, OWNER, { name: "اسم جديد" })) as any;
    expect(upd.name).toBe("اسم جديد");
    const other = (await db.workspace.findUnique({ where: { id: OTHER } })) as any;
    expect(other.name).toBe("O");
    await expect(updateWorkspaceDetails(db as Db, OWNER, { name: "x" })).rejects.toThrow();
    const actions = (db._stores.auditLog as any[]).map((a) => a.action);
    expect(actions).toContain("workspace.updated");
  });
});
