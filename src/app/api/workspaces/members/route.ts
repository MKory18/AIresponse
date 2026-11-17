import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { NotFoundError } from "@/core/errors";
import { listMembers, inviteMember, createMember, assignableRolesFor } from "@/modules/members/service";
import { isMemberInviteAllowed } from "@/core/signup-gate";
import { getActorRole } from "@/modules/rbac/owner-guard";

/**
 * مسارَان على نفس الباب:
 * - بدون كلمة مرور: دعوة مستخدم مسجل مسبقًا (الدعوة العادية).
 * - مع كلمة المرور + الاسم: إنشاء حساب جديد مباشرة + عضوية نشطة
 *   (الإدارة تفتح الحساب لفريقها بلا انتظار تسجيل — لا SMTP في النظام).
 */
const postSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(255),
    role: z.string().min(1).max(32),
    permissions: z.array(z.string().max(64)).max(40).optional(),
    name: z.string().trim().min(2).max(100).optional(),
    password: z.string().min(8).max(128).optional(),
  })
  .refine(
    (d) => (d.password === undefined && d.name === undefined) || (d.password !== undefined && d.name !== undefined),
    { message: "name يشترطه إنشاء حساب جديد بكلمة مرور" }
  );

/** Team roster (users.manage). */
export const GET = createHandler({ permission: "users.manage" }, async ({ auth }) => {
  const actorRole = await getActorRole(prisma as never, { userId: auth!.userId, workspaceId: auth!.workspaceId });
  return ok({
    members: await listMembers(prisma, auth!.workspaceId),
    // 4.2: المنتقي بيعرض بس الأدوار اللي الفاعل بيقدر يعطيها، و«دعوة حساب مسجل» مخفية إذا مطفية.
    assignableRoles: assignableRolesFor(actorRole),
    invitesEnabled: isMemberInviteAllowed(),
  });
});

/** Invite an existing user — OR create a new account directly (users.manage). */
export const POST = createHandler(
  { body: postSchema, permission: "users.manage", rateLimit: { limit: 20, windowMs: 60_000 } },
  async ({ auth, body, req }) => {
    const ctx = { userId: auth!.userId, workspaceId: auth!.workspaceId, can: (p: string) => auth!.can(p as never), ip: req.headers.get("x-forwarded-for") ?? undefined };
    if (body.password !== undefined) {
      const member = await createMember(prisma, ctx, {
        name: body.name!,
        email: body.email,
        password: body.password,
        role: body.role,
        permissions: body.permissions,
      });
      return ok({ member }, 201);
    }
    // S-01: رد واحد عام بكل الحالات.
    try {
      await inviteMember(prisma, ctx, body);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
    return ok({ invited: true }, 201);
  }
);
