import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { AuthenticationError, AuthorizationError } from "@/core/errors";
import { readSession, setSessionCookie } from "@/modules/auth/session";
import { switchWorkspaceSchema } from "@/modules/auth/schemas";

/**
 * POST /api/auth/switch-workspace — تبديل المساحة لمن جلسته على مساحة ما عنده فيها عضوية فعّالة
 * (شاشة «حسابك مش مفعّل بهالمساحة»). `public` لأن `PATCH /api/workspaces` بيطلب عضوية فعّالة
 * بالمساحة الحالية — وهاد بالضبط اللي ناقص هون. الأمان: الجلسة مطلوبة + عضوية فعّالة بالهدف.
 */
export const POST = createHandler(
  { body: switchWorkspaceSchema, public: true, rateLimit: { limit: 20, windowMs: 60_000 } },
  async ({ body }) => {
    const session = await readSession();
    if (!session) throw new AuthenticationError();
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: body.workspaceId, userId: session.userId } },
      select: { status: true },
    });
    if (!membership || membership.status !== "ACTIVE") {
      throw new AuthorizationError("Not a member of this workspace");
    }
    await setSessionCookie({ userId: session.userId, workspaceId: body.workspaceId });
    return ok({ ok: true, activeWorkspaceId: body.workspaceId });
  }
);
