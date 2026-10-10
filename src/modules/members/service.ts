import { AppError, ConflictError, NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import { isPermission } from "@/modules/rbac/permissions";
import type { ActorContext, Db } from "@/modules/customers/service";
import type { MemberStatus, Prisma, UserRole } from "@prisma/client";

/**
 * Team management (P3). All functions are workspace-scoped by construction:
 * every lookup constrains workspaceId first, so a caller can never address
 * another workspace's membership (defense in depth under the route-level
 * `users.manage` gate). Every administrative mutation is audited.
 *
 * Invitations reuse the existing WorkspaceMember row (status INVITED +
 * expiresAt) — no new tables. Accepting requires the logged-in identity
 * itself (no tokens to leak); expiry defaults to 7 days.
 */

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

/** Roles assignable through the API — SUPER_ADMIN is never assignable. */
export const ASSIGNABLE_ROLES = [
  "OWNER",
  "ADMIN",
  "MANAGER",
  "SALES_AGENT",
  "SUPPORT_AGENT",
  "VIEWER",
] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

function assertAssignableRole(role: string): asserts role is AssignableRole {
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
    throw new AppError("Role cannot be assigned through this API", 422, "INVALID_ROLE");
  }
}

function assertValidPermissions(permissions: unknown): asserts permissions is string[] {
  if (!Array.isArray(permissions) || permissions.length > 40) {
    throw new AppError("Invalid permissions array", 422, "INVALID_PERMISSIONS");
  }
  for (const p of permissions) {
    if (typeof p !== "string" || !isPermission(p)) {
      throw new AppError(`Unknown permission: ${String(p).slice(0, 60)}`, 422, "INVALID_PERMISSIONS");
    }
  }
}

async function getOwnedMember(db: Db, workspaceId: string, memberId: string) {
  const member = (await db.workspaceMember.findUnique({ where: { id: memberId } })) as {
    id: string;
    workspaceId: string;
    userId: string;
    role: UserRole;
    status: MemberStatus;
    permissions: string[];
  } | null;
  if (!member || member.workspaceId !== workspaceId) throw new NotFoundError("Workspace member");
  return member;
}

async function ensureOwnerRemaining(db: Db, workspaceId: string, excludeMemberId?: string): Promise<void> {
  const owners = (await db.workspaceMember.findMany({
    where: { workspaceId, role: "OWNER", status: "ACTIVE" },
    select: { id: true },
  })) as { id: string }[];
  const remaining = owners.filter((o) => o.id !== excludeMemberId);
  if (remaining.length === 0) {
    throw new AppError("Workspace must keep at least one active owner", 409, "OWNER_REQUIRED");
  }
}

async function verifyOwnerFloor(db: Db, workspaceId: string): Promise<void> {
  const owners = (await db.workspaceMember.findMany({
    where: { workspaceId, role: "OWNER", status: "ACTIVE" },
    select: { id: true },
  })) as { id: string }[];
  if (owners.length === 0) {
    throw new AppError("Workspace must keep at least one active owner", 409, "OWNER_REQUIRED");
  }
}

export async function listMembers(db: Db, workspaceId: string) {
  // Two-step (no include-join): behaves identically on Postgres and the
  // in-memory test double.
  const rows = (await db.workspaceMember.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
  })) as Array<{
    id: string;
    userId: string;
    role: string;
    status: string;
    permissions: string[];
    expiresAt: Date | string | null;
  }>;
  const users = (await db.user.findMany({
    where: { id: { in: rows.map((r) => r.userId) } },
    select: { id: true, email: true, name: true },
  })) as Array<{ id: string; email: string; name: string }>;
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    status: m.status,
    permissions: m.permissions ?? [],
    expiresAt: m.expiresAt ?? null,
    user: byId.get(m.userId) ?? { id: m.userId, email: null, name: null },
  }));
}

export async function inviteMember(
  db: Db,
  ctx: ActorContext,
  input: { email: string; role: string; permissions?: string[] }
) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
    throw new AppError("Invalid email address", 422, "INVALID_EMAIL");
  }
  assertAssignableRole(input.role);
  if (input.permissions !== undefined) assertValidPermissions(input.permissions);

  const user = (await db.user.findUnique({ where: { email } })) as { id: string } | null;
  if (!user) {
    // No user fabrication: invitees must register first (safe message, no
    // disclosure beyond what the admin typed).
    throw new NotFoundError("User");
  }

  const existing = (await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: ctx.workspaceId, userId: user.id } },
  })) as { id: string; status: string } | null;

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  if (existing) {
    if (existing.status === "ACTIVE") {
      throw new ConflictError("User is already an active member");
    }
    if (existing.status === "SUSPENDED") {
      throw new AppError("Membership is suspended — reactivate it instead of re-inviting", 422, "MEMBER_SUSPENDED");
    }
    // Refresh a pending invitation (new expiry + role).
    const updated = await db.workspaceMember.update({
      where: { id: existing.id },
      data: { role: input.role, permissions: input.permissions ?? [], expiresAt },
    });
    await recordAudit(db, {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: "member.invited",
      entityType: "WorkspaceMember",
      entityId: existing.id,
      metadata: { email, role: input.role, refreshed: true },
    });
    return updated;
  }

  const created = await db.workspaceMember.create({
    data: {
      workspaceId: ctx.workspaceId,
      userId: user.id,
      role: input.role,
      permissions: input.permissions ?? [],
      status: "INVITED",
      expiresAt,
    },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "member.invited",
    entityType: "WorkspaceMember",
    entityId: (created as { id: string }).id,
    metadata: { email, role: input.role },
  });
  return created;
}

export async function acceptInvite(db: Db, userId: string, workspaceId: string) {
  // Self-only: the invitee is proven by the session, no tokens involved.
  const row = (await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  })) as { id: string; status: string; expiresAt: Date | string | null } | null;
  if (!row || row.status !== "INVITED") throw new NotFoundError("Invitation");
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
    throw new AppError("Invitation expired — ask an admin to re-invite", 410, "INVITE_EXPIRED");
  }
  const updated = await db.workspaceMember.update({
    where: { id: row.id },
    data: { status: "ACTIVE", expiresAt: null },
  });
  await recordAudit(db, {
    workspaceId,
    userId,
    action: "member.accepted",
    entityType: "WorkspaceMember",
    entityId: row.id,
  });
  return updated;
}

export async function updateMember(
  db: Db,
  ctx: ActorContext,
  memberId: string,
  input: { role?: string; permissions?: string[]; status?: string }
) {
  const member = await getOwnedMember(db, ctx.workspaceId, memberId);
  if (member.userId === ctx.userId) {
    // No self-service escalation or self-lockout — ask another admin.
    throw new AppError("Members cannot modify their own membership", 403, "CANNOT_EDIT_SELF");
  }
  const data: Prisma.WorkspaceMemberUpdateInput = {};
  if (input.role !== undefined) {
    assertAssignableRole(input.role);
    data.role = input.role;
  }
  if (input.permissions !== undefined) {
    assertValidPermissions(input.permissions);
    data.permissions = input.permissions;
  }
  if (input.status !== undefined) {
    if (input.status !== "ACTIVE" && input.status !== "SUSPENDED") {
      throw new AppError("Status must be ACTIVE or SUSPENDED", 422, "INVALID_STATUS");
    }
    data.status = input.status as "ACTIVE" | "SUSPENDED";
  }
  if (Object.keys(data).length === 0) {
    throw new AppError("Nothing to update", 422, "EMPTY_UPDATE");
  }
  // Owner floor: demoting/suspending the last active owner is refused.
  const wasOwner = member.role === "OWNER" && member.status === "ACTIVE";
  const staysOwner =
    (data.role ?? member.role) === "OWNER" && (data.status ?? member.status) === "ACTIVE";
  if (wasOwner && !staysOwner) {
    await ensureOwnerRemaining(db, ctx.workspaceId, member.id);
  }
  const updated = await db.workspaceMember.update({ where: { id: member.id }, data });
  if (wasOwner && !staysOwner) {
    // Post-write verification closes the check-then-act race: two concurrent
    // demotes both pass the pre-check, but the loser compensates (restores)
    // instead of leaving the workspace ownerless.
    try {
      await verifyOwnerFloor(db, ctx.workspaceId);
    } catch (err) {
      await db.workspaceMember.update({
        where: { id: member.id },
        data: { role: member.role, status: member.status },
      });
      throw err;
    }
  }
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "member.updated",
    entityType: "WorkspaceMember",
    entityId: member.id,
    metadata: { changes: Object.keys(data) },
  });
  return updated;
}

export async function removeMember(db: Db, ctx: ActorContext, memberId: string) {
  const member = await getOwnedMember(db, ctx.workspaceId, memberId);
  if (member.userId === ctx.userId) {
    throw new AppError("Members cannot remove their own membership", 403, "CANNOT_EDIT_SELF");
  }
  const wasOwner = member.role === "OWNER" && member.status === "ACTIVE";
  if (wasOwner) {
    await ensureOwnerRemaining(db, ctx.workspaceId, member.id);
  }
  await db.workspaceMember.delete({ where: { id: member.id } });
  if (wasOwner) {
    // Same race compensation as updateMember: restore the row if the floor broke.
    try {
      await verifyOwnerFloor(db, ctx.workspaceId);
    } catch (err) {
      await db.workspaceMember.create({
        data: {
          workspaceId: member.workspaceId,
          userId: member.userId,
          role: member.role,
          permissions: member.permissions ?? [],
          status: member.status,
        },
      });
      throw err;
    }
  }
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "member.removed",
    entityType: "WorkspaceMember",
    entityId: member.id,
  });
  return { removed: true };
}
