import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { faqCreateSchema, faqUpdateSchema } from "@/modules/products/schemas";
import { createFaq, updateFaq } from "@/modules/knowledge/service";

type Params = { id: string };

export const POST = createHandler(
  { body: faqCreateSchema, permission: "knowledge.write" },
  async ({ auth, body }) => {
    const faq = await createFaq(prisma, auth!, body);
    return ok(faq, 201);
  }
);

export const PATCH = createHandler(
  { body: faqUpdateSchema, permission: "knowledge.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const updated = await updateFaq(prisma, auth!, id, body);
    return ok(updated);
  }
);
