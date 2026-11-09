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
    /** P18 — حدود كتالوج الصفحة: أسئلة المنتجات خارجها ما بترجع. */
    allowedProductIds?: string[] | null;
  }
): Promise<RetrievedKnowledge> {
  const [faqs, chunks] = await Promise.all([
    findMatchingFaqs(db, {
      workspaceId: params.workspaceId,
      query: params.query,
      productId: params.productId,
      allowedProductIds: params.allowedProductIds,
      limit: 3,
    }),
    (async () => {
      // PERF — empty store: embedding the query can never match anything, so
      // skip the provider call + search entirely. FAQ lookup above still runs;
      // structured answers keep working exactly as before.
      if (vectorStore.size === 0) return [];
      const provider = getEmbeddingProvider();
      // Documents tied to a product outside this page's catalog stay out; general
      // documents (no product) apply to every page.
      const excluded = params.allowedProductIds
        ? await db.knowledgeDocument.findMany({
            where: { workspaceId: params.workspaceId, productId: { not: null, notIn: params.allowedProductIds } },
            select: { id: true },
          })
        : [];
      const embedding = await provider.embed(params.query);
      return vectorStore.search({
        embedding,
        workspaceId: params.workspaceId,
        limit: params.limit ?? 5,
        metadataFilters: params.category ? { category: params.category } : undefined,
        excludeDocumentIds: excluded.map((d) => d.id),
      });
    })(),
  ]);

  return {
    faqs: faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer, productId: f.productId })),
    chunks,
  };
}

export type { VectorStore, VectorMatch };
