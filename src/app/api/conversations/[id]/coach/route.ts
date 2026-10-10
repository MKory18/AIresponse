import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { buildCoachSuggestions } from "@/modules/sales/coach";

type Params = { id: string };

/**
 * P8 — Sales Coach (للموظف فقط، لا يُرسل شيئًا تلقائيًا):
 * POST { productId?, discountPercent? } → اقتراحات + أسباب غياب العرض.
 * الإرسال الفعلي يبقى عبر مسار الرد الصريح الموجود (conversations.reply)
 * مع إعادة فحص الأسعار والصلاحيات لحظة التنفيذ.
 */
export const POST = createHandler(
  {
    body: z
      .object({
        productId: z.string().min(1).optional(),
        discountPercent: z.number().min(0).max(90).optional(),
      })
      .strict(),
    permission: "conversations.read",
  },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const result = await buildCoachSuggestions(prisma, auth!, {
      conversationId: id,
      productId: body.productId,
      discountPercent: body.discountPercent,
    });
    return ok(result);
  }
);
