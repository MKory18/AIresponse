import { NextRequest, NextResponse } from "next/server";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { ConflictError } from "@/core/errors";
import { hashPassword } from "@/modules/auth/password";
import { registerSchema } from "@/modules/auth/schemas";
import { setSessionCookie } from "@/modules/auth/session";
import { createWorkspaceForUser } from "@/modules/workspaces/service";
import { childLogger } from "@/core/logger";

const log = childLogger("auth.register");

export const POST = createHandler(
  { body: registerSchema, public: true, rateLimit: { limit: 5, windowMs: 60_000 }, rateLimitStrict: true },
  async ({ body }) => {
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw new ConflictError("An account with this email already exists");

    const passwordHash = await hashPassword(body.password);
    const user = await prisma.user.create({
      data: { email: body.email, name: body.name, passwordHash },
    });
    // OCR-2026-10-16: فشل ما بعد إنشاء المستخدم بلا مساحة = حساب أيتام
    // محكوم بلا كفالة داخليًا — تعويض سريع وامتناع. (الترقيم على الـ
    // البريد أعلاه مغطى بالفحص الأول، فمساران لا يتضمنهما حالة معارض.)
    try {
      const workspace = await createWorkspaceForUser(user.id, body.workspaceName);
      await setSessionCookie({ userId: user.id, workspaceId: workspace.id });
      return ok(
        { user: { id: user.id, email: user.email, name: user.name }, workspace: { id: workspace.id, name: workspace.name } },
        201
      );
    } catch (err) {
      try {
        await prisma.user.delete({ where: { id: user.id } });
      } catch (cleanupErr) {
        log.error({ cleanupErr }, "register_compensation_failed");
      }
      throw err;
    }
  }
);
