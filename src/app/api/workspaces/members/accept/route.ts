import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { acceptInvite } from "@/modules/members/service";
import { readSession } from "@/modules/auth/session";
import { setSessionCookie } from "@/modules/auth/session";
import { AuthenticationError } from "@/core/errors";

const acceptSchema = z.object({
  workspaceId: z.string().cuid(),
});

/**
 * Accept your own invitation. Public wrapper with manual session handling:
 * the invitee may have NO active workspace yet, so the standard auth context
 * (which requires one) cannot gate this route. Identity still comes from
 * the signed session — only INVITED rows convert, and only for yourself.
 */
export const POST = createHandler(
  { body: acceptSchema, public: true },
  async ({ body }) => {
    const session = await readSession();
    if (!session) throw new AuthenticationError();
    const member = await acceptInvite(prisma, session.userId, body.workspaceId);
    await setSessionCookie({ userId: session.userId, workspaceId: body.workspaceId });
    return ok({ member });
  }
);
