import { createHandler, ok } from "@/core/api/handler";
import { createWorkspaceSchema } from "@/modules/auth/schemas";
import { setSessionCookie } from "@/modules/auth/session";
import { createWorkspaceForUser, listWorkspacesForUser, updateWorkspaceDetails } from "@/modules/workspaces/service";
import { switchWorkspaceSchema } from "@/modules/auth/schemas";
import { prisma } from "@/core/db/prisma";
import { AuthorizationError } from "@/core/errors";
import { z } from "zod";

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

const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

/** Rename / re-timezone the CURRENT workspace (workspace.manage). */
export const PUT = createHandler(
  { body: updateWorkspaceSchema, permission: "workspace.manage" },
  async ({ auth, body, req }) => {
    const workspace = await updateWorkspaceDetails(
      prisma,
      { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined },
      body
    );
    return ok({ workspace });
  }
);
