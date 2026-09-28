import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { searchKnowledge } from "@/modules/knowledge/service";

const searchSchema = z.object({
  query: z.string().trim().min(2).max(500),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  category: z.enum(["PRODUCT", "FAQ", "POLICY", "DELIVERY", "PAYMENT", "COMPANY", "DOCUMENT", "CUSTOM"]).optional(),
});

/**
 * POST /api/knowledge/search — real semantic search debugger ("اختبر البحث").
 * Returns top chunks with similarity scores, source titles, and previews so
 * operators can verify RAG is factual instead of trusting a status badge.
 */
export const POST = createHandler(
  { body: searchSchema, permission: "knowledge.read", rateLimit: { limit: 30, windowMs: 60_000 } },
  async ({ auth, body }) => {
    const hits = await searchKnowledge(prisma, {
      workspaceId: auth!.workspaceId,
      query: body.query,
      limit: body.limit,
      category: body.category,
    });
    return ok({ items: hits });
  }
);
