import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { resetConversationMemory } from "@/modules/customers/memory";

type Params = { id: string };

/**
 * POST /api/conversations/[id]/memory/reset
 * يحذف ما تعلّمه الذكاء من هذه المحادثة (ذاكرة المصدر + ملخّصها) — الرسائل
 * والطلبات تبقى. مدير فما فوق (صلاحية حذف المحادثة).
 */
export const POST = createHandler(
  { permission: "conversations.delete" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const result = await resetConversationMemory(prisma, auth!, id);
    return ok(result);
  }
);
