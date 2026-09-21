import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";
import { getEmbeddingProvider } from "@/modules/knowledge/embeddings";

const runSchema = z.object({
  conversationId: z.string().cuid(),
  messageId: z.string().cuid().optional(),
  /** Playwright-style preview: simulate a customer message without sending. */
  simulateText: z.string().trim().min(1).max(2000).optional(),
});

/**
 * AI Test Console (dry-run). Runs the full orchestrator pipeline for a
 * conversation/message but NEVER sends anything to a channel or persists an
 * outbound message. Returns intent, plan, response, citations, and sources.
 */
export const POST = createHandler(
  { body: runSchema, permission: "ai.configure", rateLimit: { limit: 20, windowMs: 60_000 } },
  async ({ auth, body }) => {
    let messageId = body.messageId ?? null;
    if (!messageId && body.simulateText) {
      // Create a transient inbound message owned by the caller's workspace.
      const msg = await prisma.message.create({
        data: {
          conversationId: body.conversationId,
          workspaceId: auth!.workspaceId,
          senderType: "CUSTOMER",
          direction: "INBOUND",
          type: "TEXT",
          text: body.simulateText,
          provider: "playground",
          deliveryStatus: "DELIVERED",
        },
      });
      messageId = msg.id;
    }
    if (!messageId) {
      return Response.json({ error: "VALIDATION_ERROR", message: "messageId or simulateText required" }, { status: 422 });
    }

    // Dry-run vector store: fresh in-memory store built from this workspace's
    // active chunks so playground results mirror production retrieval without
    // depending on pgvector availability.
    // embedding is a native pgvector column (Unsupported in Prisma types) —
    // fetch it via raw SQL for the dry-run store.
    const chunkRows = await prisma.$queryRawUnsafe<
      { id: string; documentId: string; content: string; metadata: unknown; embedding: unknown }[]>(
        `SELECT id, "documentId", content, metadata, embedding::text AS embedding
         FROM "KnowledgeChunk"
         WHERE "workspaceId" = $1 AND "isActive" = true AND embedding IS NOT NULL
         LIMIT 500`,
        auth!.workspaceId
      );
    const vectors = new Map<string, number[]>();
    const rows = new Map<string, { documentId: string; workspaceId: string; content: string; metadata: Record<string, unknown>; isActive: boolean }>();
    for (const c of chunkRows) {
      if (typeof c.embedding !== "string") continue;
      vectors.set(c.id, JSON.parse(c.embedding));
      rows.set(c.id, {
        documentId: c.documentId,
        workspaceId: auth!.workspaceId,
        content: c.content,
        metadata: (c.metadata ?? {}) as Record<string, unknown>,
        isActive: true,
      });
    }
    const vectorStore = new InMemoryVectorStore(vectors, rows);
    void getEmbeddingProvider;

    const result = await processAIMessage(
      prisma,
      {
        workspaceId: auth!.workspaceId,
        conversationId: body.conversationId,
        messageId,
        dryRun: true,
      },
      { vectorStore }
    );

    return ok(result);
  }
);
