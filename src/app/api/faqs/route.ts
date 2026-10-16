import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { faqCreateSchema } from "@/modules/products/schemas";
import { createFaq } from "@/modules/knowledge/service";

export const POST = createHandler(
  { body: faqCreateSchema, permission: "knowledge.write" },
  async ({ auth, body }) => {
    const faq = await createFaq(prisma, auth!, body);
    return ok(faq, 201);
  }
);
