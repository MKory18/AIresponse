import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listMembers, inviteMember } from "@/modules/members/service";

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  role: z.string().min(1).max(32),
  permissions: z.array(z.string().max(64)).max(40).optional(),
});

/** Team roster (users.manage). */
export const GET = createHandler(
  { permission: "users.manage" },
  async ({ auth }) => ok({ members: await listMembers(prisma, auth!.workspaceId) })
);

/** Invite an existing user by email (users.manage). */
export const POST = createHandler(
  { body: inviteSchema, permission: "users.manage" },
  async ({ auth, body, req }) => {
    const member = await inviteMember(
      prisma,
      { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined },
      body
    );
    return ok({ member }, 201);
  }
);
