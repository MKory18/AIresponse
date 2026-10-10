import { NextResponse } from "next/server";
import { createHandler, ok } from "@/core/api/handler";
import { AuthenticationError } from "@/core/errors";
import { prisma } from "@/core/db/prisma";
import { loginSchema } from "@/modules/auth/schemas";
import { verifyPassword } from "@/modules/auth/password";
import { setSessionCookie } from "@/modules/auth/session";

export const POST = createHandler(
  { body: loginSchema, public: true, rateLimit: { limit: 10, windowMs: 60_000 }, rateLimitStrict: true },
  async ({ body }) => {
    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: {
        memberships: {
          where: { status: "ACTIVE" },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
    });
    if (!user) throw new AuthenticationError("Invalid email or password");

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) throw new AuthenticationError("Invalid email or password");

    const workspaceId = user.memberships[0]?.workspaceId ?? null;
    await setSessionCookie({ userId: user.id, workspaceId });
    return ok({
      user: { id: user.id, email: user.email, name: user.name },
      workspaceId,
    });
  }
);
