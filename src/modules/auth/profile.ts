import { AppError, NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import { hashPassword, verifyPassword } from "./password";
import type { ActorContext, Db } from "@/modules/customers/service";

/**
 * «حسابي» — التعديل الذاتي لهوية الحساب (P3, self-only):
 * - الاسم يتبدل بلا كلمة مرور (غير حساس وغير هوية دخول).
 * - البريد وكلمة المرور حساسان: يطلبان تأكيد كلمة المرور الحالية.
 * - القيمة المعمّاة فقط تُكتب، والتدقيق يسجل أسماء الحقول المبدّلة دون أي
 *   قيمة كلمة مرور أو بريد جديد (نصّ البريد تابع لحساب المستخدم نفسه).
 */
export interface OwnProfileUpdate {
  name?: string;
  email?: string;
  currentPassword?: string;
  newPassword?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function updateOwnProfile(
  db: Db,
  ctx: ActorContext,
  input: OwnProfileUpdate
) {
  const wantsAnything = input.name !== undefined || input.email !== undefined || input.newPassword !== undefined;
  if (!wantsAnything) {
    throw new AppError("No fields to update", 422, "EMPTY_UPDATE");
  }
  const wantsSensitive = input.email !== undefined || input.newPassword !== undefined;

  const user = (await db.user.findUnique({ where: { id: ctx.userId } })) as {
    id: string;
    email: string;
    name: string;
    passwordHash: string;
  } | null;
  if (!user) throw new NotFoundError("User");

  const data: { name?: string; email?: string; passwordHash?: string } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 100) {
      throw new AppError("Name must be 2-100 characters", 422, "INVALID_NAME");
    }
    data.name = name;
  }

  if (wantsSensitive) {
    if (!input.currentPassword) {
      throw new AppError("كلمة المرور الحالية مطلوبة لتغيير البريد أو كلمة المرور", 422, "CURRENT_PASSWORD_REQUIRED");
    }
    const verified = await verifyPassword(input.currentPassword, user.passwordHash);
    if (!verified) {
      throw new AppError("كلمة المرور الحالية غير صحيحة", 422, "INVALID_CURRENT_PASSWORD");
    }
  }

  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 255) {
      throw new AppError("Invalid email address", 422, "INVALID_EMAIL");
    }
    if (email !== user.email) {
      const clash = (await db.user.findUnique({ where: { email } })) as { id: string } | null;
      if (clash && clash.id !== ctx.userId) {
        throw new AppError("هذا البريد مستخدم بحساب آخر", 409, "EMAIL_TAKEN");
      }
      data.email = email;
    }
  }

  if (input.newPassword !== undefined) {
    if (input.newPassword.length < 8 || input.newPassword.length > 128) {
      throw new AppError("Password must be 8-128 characters", 422, "INVALID_PASSWORD");
    }
    data.passwordHash = await hashPassword(input.newPassword);
  }

  const changed = Object.keys(data) as string[];
  if (changed.length === 0) {
    throw new AppError("No fields to update", 422, "EMPTY_UPDATE");
  }

  const updated = (await db.user.update({ where: { id: ctx.userId }, data })) as {
    id: string;
    email: string;
    name: string;
  };
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "profile.updated",
    entityType: "User",
    entityId: ctx.userId,
    metadata: { changes: changed },
  });
  // Safe view — never the hash.
  return { id: updated.id, email: updated.email, name: updated.name };
}
