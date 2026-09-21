import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { faqUpdateSchema } from "@/modules/products/schemas";
import { updateFaq } from "@/modules/knowledge/service";

type Params = { id: string };

export const PATCH = createHandler(
  { body: faqUpdateSchema, permission: "knowledge.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const updated = await updateFaq(prisma, auth!, id, body);
    return ok(updated);
  }
);
