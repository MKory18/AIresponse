import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { updateMember, removeMember } from "@/modules/members/service";

const updateSchema = z.object({
  role: z.string().min(1).max(32).optional(),
  permissions: z.array(z.string().max(64)).max(40).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
});

/** Change role / permissions / suspension (users.manage). */
export const PATCH = createHandler(
  { body: updateSchema, permission: "users.manage" },
  async ({ auth, body, params, req }) => {
    const member = await updateMember(
      prisma,
      { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined },
      String(params.id),
      body
    );
    return ok({ member });
  }
);

/** Remove a membership (users.manage). */
export const DELETE = createHandler(
  { permission: "users.manage" },
  async ({ auth, params }) => {
    const result = await removeMember(
      prisma,
      { userId: auth!.userId, workspaceId: auth!.workspaceId },
      String(params.id)
    );
    return ok(result);
  }
);
