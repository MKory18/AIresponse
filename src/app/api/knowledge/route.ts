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
    // Active chunk counts per document (one grouped query, no N+1).
    const ids = result.items.map((d) => d.id);
    const counts =
      ids.length > 0
        ? await prisma.knowledgeChunk.groupBy({
            by: ["documentId"],
            where: { documentId: { in: ids }, isActive: true },
            _count: { documentId: true },
          })
        : [];
    const countById = new Map(
      counts.map((c) => [c.documentId, (c._count as { documentId?: number })?.documentId ?? 0])
    );
    return ok({
      ...result,
      items: result.items.map((d) => ({ ...d, chunkCount: countById.get(d.id) ?? 0 })),
    });
  }
);

export const POST = createHandler(
  { body: knowledgeCreateSchema, permission: "knowledge.write" },
  async ({ auth, body }) => {
    const doc = await createKnowledgeDocument(prisma, auth!, body);
    return ok(doc, 202);
  }
);
