import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { AuthenticationError } from "@/core/errors";
import { readSession } from "@/modules/auth/session";
import { listWorkspacesForUser } from "@/modules/workspaces/service";
import { getAuthContext } from "@/modules/auth/context";
import { PERMISSIONS } from "@/modules/rbac/permissions";
import { updateOwnProfile } from "@/modules/auth/profile";
import { z } from "zod";

export const GET = createHandler({ public: true }, async () => {
  const session = await readSession();
  if (!session) throw new AuthenticationError();

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, name: true, isSuperAdmin: true, mustChangePassword: true },
  });
  if (!user) throw new AuthenticationError("Session user no longer exists");

  const workspaces = await listWorkspacesForUser(user.id);
  const activeWorkspace = workspaces.find((w) => w.id === session.workspaceId) ?? null;

  // 2.2: الدور والصلاحيات الفعلية (دور + إضافات) — الواجهة بتخفي اللي ما بيقدر عليه؛ الخادم هو الحكم.
  let role: string | null = null;
  let permissions: string[] = [];
  try {
    const auth = await getAuthContext();
    role = auth.role;
    permissions = PERMISSIONS.filter((p) => auth.can(p));
  } catch {
    // بلا عضوية فعّالة بالمساحة الحالية: لا دور ولا صلاحيات.
  }
  return ok({ user, activeWorkspace, workspaces, role, permissions, isSuperAdmin: user.isSuperAdmin });
});

const profileSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  email: z.string().trim().toLowerCase().max(255).optional(),
  // تغيير البريد أو كلمة المرور يطلب تأكيد كلمة المرور الحالية (الاسم لا).
  currentPassword: z.string().max(128).optional(),
  newPassword: z.string().min(8).max(128).optional(),
});

/** PATCH /api/auth/me — التعديل الذاتي لـ«حسابي» (اسم / بريد / كلمة المرور). */
export const PATCH = createHandler({ body: profileSchema }, async ({ body, auth }) => {
  const user = await updateOwnProfile(
    prisma,
    { userId: auth!.userId, workspaceId: auth!.workspaceId },
    body
  );
  return ok({ user });
});
