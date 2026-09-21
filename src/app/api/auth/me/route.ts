import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { AuthenticationError } from "@/core/errors";
import { readSession } from "@/modules/auth/session";
import { listWorkspacesForUser } from "@/modules/workspaces/service";

export const GET = createHandler({ public: true }, async () => {
  const session = await readSession();
  if (!session) throw new AuthenticationError();

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, name: true, isSuperAdmin: true },
  });
  if (!user) throw new AuthenticationError("Session user no longer exists");

  const workspaces = await listWorkspacesForUser(user.id);
  const activeWorkspace = workspaces.find((w) => w.id === session.workspaceId) ?? null;
  return ok({ user, activeWorkspace, workspaces });
});
