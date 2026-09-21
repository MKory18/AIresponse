import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { knowledgeCreateSchema } from "@/modules/products/schemas";
import { createKnowledgeDocument, listDocuments } from "@/modules/knowledge/service";

const knowledgeListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.enum(["PRODUCT", "FAQ", "POLICY", "DELIVERY", "PAYMENT", "COMPANY", "DOCUMENT", "CUSTOM"]).optional(),
  status: z.enum(["UPLOADING", "PROCESSING", "READY", "FAILED", "ARCHIVED"]).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const GET = createHandler(
  { query: knowledgeListQuerySchema, permission: "knowledge.read" },
  async ({ auth, query }) => {
    const result = await listDocuments(prisma, {
      workspaceId: auth!.workspaceId,
      status: query.status,
      category: query.category,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
    return ok(result);
  }
);

export const POST = createHandler(
  { body: knowledgeCreateSchema, permission: "knowledge.write" },
  async ({ auth, body }) => {
    const doc = await createKnowledgeDocument(prisma, auth!, body);
    return ok(doc, 202);
  }
);
