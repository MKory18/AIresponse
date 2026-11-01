import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { faqCreateSchema } from "@/modules/products/schemas";
import { createFaq, listFaqs } from "@/modules/knowledge/service";

/**
 * ⚠️ صفحة «المعرفة» بتطلب القائمة من هون، وكان المسار POST بس ← ٤٠٥ ← الصفحة
 * كلها «فشل التحميل». 🔧 GET بيرجّع أسئلة المساحة (`listFaqs` · حد أعلى ٢٠٠).
 */
export const GET = createHandler(
  {
    query: z.object({
      productId: z.string().optional(),
      q: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }).passthrough(),
    permission: "knowledge.read",
  },
  async ({ auth, query }) => {
    const items = await listFaqs(prisma, { workspaceId: auth!.workspaceId, ...query });
    return ok({ items });
  }
);

export const POST = createHandler(
  { body: faqCreateSchema, permission: "knowledge.write" },
  async ({ auth, body }) => {
    const faq = await createFaq(prisma, auth!, body);
    return ok(faq, 201);
  }
);
