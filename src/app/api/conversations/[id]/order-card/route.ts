import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getOrderCard } from "@/modules/orders/reader/card";

type Params = { id: string };

/**
 * «بطاقة الطلب» لمحادثة (الحزمة 1.8): القراءة + الطلب + السجل بقيم كاملة للموظف،
 * مع صلاحيات الأزرار من الخادم (الواجهة بتخفي بس — الخادم هو اللي بيقرر بكل مسار).
 */
export const GET = createHandler({ permission: "orders.read" }, async ({ auth, params }) => {
  const { id } = params as Params;
  const card = await getOrderCard(prisma as never, { workspaceId: auth!.workspaceId, conversationId: id });
  return ok({
    ...card,
    can: {
      seal: auth!.can("orders.seal"),
      write: auth!.can("orders.write"),
      cancel: auth!.can("orders.cancel"),
      amend: auth!.can("orders.amend"),
      reply: auth!.can("conversations.reply"),
    },
  });
});
