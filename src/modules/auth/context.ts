import { prisma } from "@/core/db/prisma";
import { AuthenticationError, AuthorizationError } from "@/core/errors";
import { readSession } from "./session";
import {
  effectivePermissions,
  type Permission,
} from "@/modules/rbac/permissions";

export interface AuthContext {
  userId: string;
  workspaceId: string;
  role: string;
  memberPermissions: string[];
  can: (permission: Permission) => boolean;
  require: (permission: Permission) => void;
}

/**
 * Resolves the current authenticated user together with their membership in the
 * active workspace. Permission data is always loaded fresh from the database so
 * role changes take effect immediately.
 */
export async function getAuthContext(): Promise<AuthContext> {
  const session = await readSession();
  if (!session) throw new AuthenticationError();

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, isSuperAdmin: true },
  });
  if (!user) throw new AuthenticationError("Session user no longer exists");

  const workspaceId = session.workspaceId;
  if (!workspaceId) {
    throw new AuthorizationError("No active workspace in session");
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
    select: { role: true, permissions: true, status: true },
  });
  if (!membership || membership.status !== "ACTIVE") {
    throw new AuthorizationError("You are not an active member of this workspace");
  }

  const effective = user.isSuperAdmin
    ? effectivePermissions("SUPER_ADMIN", membership.permissions)
    : effectivePermissions(membership.role, membership.permissions);

  return {
    userId: user.id,
    workspaceId,
    role: membership.role,
    memberPermissions: membership.permissions,
    can: (permission) => effective.has(permission),
    require: (permission) => {
      if (!effective.has(permission)) {
        throw new AuthorizationError(`Missing permission: ${permission}`);
      }
    },
  };
}
