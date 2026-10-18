import { AppError } from "@/core/errors";
import type { Db } from "@/modules/customers/service";

/**
 * حرّاس «المالك فقط» — قاعدة واحدة مكرّرة الاستعمال.
 *
 * الرتبة تُقرأ طازجة من القاعدة في كل نداء (لا اعتماد على ما بالجلسة)، وصف
 * العضوية الناقص أو الإيقاف = بلا رتبة = رفض. الكود الافتراضي
 * `OWNER_ROLE_REQUIRED` مطابق لما تفرضه إدارة الفريق أصلًا؛ المواضع اللي
 * بدها كود أوضح (زي حذف الطلبات) بتمرّر كودها بنفس الحارس.
 */

/** رتبة الفاعل الفعلية بمساحة العمل (طازجة من القاعدة) — أو null. */
export async function getActorRole(
  db: Db,
  ctx: { userId: string; workspaceId: string }
): Promise<string | null> {
  const row = (await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: ctx.workspaceId, userId: ctx.userId } },
  })) as { role: string; status?: string } | null;
  if (!row) return null;
  // عضوية موقوفة = مالك غير فاعل: ما بتدير صفوف المالك ولا عمليات المالك.
  if (row.status !== undefined && row.status !== "ACTIVE") return null;
  return row.role ?? null;
}

export interface OwnerGuardOptions {
  code?: string;
  message?: string;
}

/** يرفض كل رتبة غير OWNER بكود ثابت (افتراضيًا OWNER_ROLE_REQUIRED). */
export async function requireWorkspaceOwner(
  db: Db,
  ctx: { userId: string; workspaceId: string },
  opts: OwnerGuardOptions = {}
): Promise<void> {
  const role = await getActorRole(db, ctx);
  if (role !== "OWNER") {
    throw new AppError(
      opts.message ?? "Only a workspace OWNER can perform this action",
      403,
      opts.code ?? "OWNER_ROLE_REQUIRED"
    );
  }
}
