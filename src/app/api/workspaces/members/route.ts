import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listMembers, inviteMember, createMember } from "@/modules/members/service";

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
export const GET = createHandler(
  { permission: "users.manage" },
  async ({ auth }) => ok({ members: await listMembers(prisma, auth!.workspaceId) })
);

/** Invite an existing user — OR create a new account directly (users.manage). */
export const POST = createHandler(
  { body: postSchema, permission: "users.manage" },
  async ({ auth, body, req }) => {
    const ctx = { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined };
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
    const member = await inviteMember(prisma, ctx, body);
    return ok({ member }, 201);
  }
);
