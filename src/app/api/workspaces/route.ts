import { createHandler, ok } from "@/core/api/handler";
import { createWorkspaceSchema } from "@/modules/auth/schemas";
import { setSessionCookie } from "@/modules/auth/session";
import { createWorkspaceForUser, listWorkspacesForUser } from "@/modules/workspaces/service";
import { switchWorkspaceSchema } from "@/modules/auth/schemas";
import { prisma } from "@/core/db/prisma";
import { AuthorizationError } from "@/core/errors";

export const GET = createHandler({}, async ({ auth }) => {
  const workspaces = await listWorkspacesForUser(auth!.userId);
  return ok({ workspaces, activeWorkspaceId: auth!.workspaceId });
});

export const POST = createHandler(
  { body: createWorkspaceSchema, rateLimit: { limit: 10, windowMs: 60_000 } },
  async ({ body, auth }) => {
    const workspace = await createWorkspaceForUser(auth!.userId, body.name);
    await setSessionCookie({ userId: auth!.userId, workspaceId: workspace.id });
    return ok({ workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug } }, 201);
  }
);

export const PATCH = createHandler(
  { body: switchWorkspaceSchema },
  async ({ body, auth }) => {
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: body.workspaceId, userId: auth!.userId } },
    });
    if (!membership || membership.status !== "ACTIVE") {
      throw new AuthorizationError("Not a member of this workspace");
    }
    await setSessionCookie({ userId: auth!.userId, workspaceId: body.workspaceId });
    return ok({ ok: true, activeWorkspaceId: body.workspaceId });
  }
);
