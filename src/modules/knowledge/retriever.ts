import type { Prisma, KnowledgeCategory } from "@prisma/client";
import { getEmbeddingProvider } from "./embeddings";
import type { VectorStore, VectorMatch } from "./vector-store";
import type { Db } from "@/modules/customers/service";
import { findMatchingFaqs } from "./service";

export interface RetrievedKnowledge {
  faqs: { id: string; question: string; answer: string; productId: string | null }[];
  chunks: VectorMatch[];
}

/**
 * Hybrid retrieval: structured FAQ lookup + vector search over documents.
 * Every query is workspace-scoped inside the store implementation.
 */
export async function retrieveKnowledge(
  db: Db,
  vectorStore: VectorStore,
  params: {
    workspaceId: string;
    query: string;
    productId?: string;
    category?: KnowledgeCategory;
    limit?: number;
  }
): Promise<RetrievedKnowledge> {
  const [faqs, chunks] = await Promise.all([
    findMatchingFaqs(db, {
      workspaceId: params.workspaceId,
      query: params.query,
      productId: params.productId,
      limit: 3,
    }),
    (async () => {
      const provider = getEmbeddingProvider();
      const embedding = await provider.embed(params.query);
      return vectorStore.search({
        embedding,
        workspaceId: params.workspaceId,
        limit: params.limit ?? 5,
        metadataFilters: params.category ? { category: params.category } : undefined,
      });
    })(),
  ]);

  return {
    faqs: faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer, productId: f.productId })),
    chunks,
  };
}

export type { VectorStore, VectorMatch };
