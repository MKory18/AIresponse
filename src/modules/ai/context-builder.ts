import type { KnowledgeCategory } from "@prisma/client";
import { NotFoundError } from "@/core/errors";
import type { Db } from "@/modules/customers/service";
import { retrieveKnowledge, type VectorStore } from "@/modules/knowledge/retriever";
import { getApprovedFeedbackForProduct } from "@/modules/feedback/service";
import { findProductMedia, findRelevantMedia } from "@/modules/media/service";

/**
 * Knowledge source priority (higher source wins on conflict; enforced by only
 * feeding the model the highest-priority data for facts like price/stock):
 *
 *   1. Orders / Customer DB      (Phase 5 wires orders into buildAIContext)
 *   2. Products / Pricing / Inventory  — buildProductContext
 *   3. Approved business policies      — buildKnowledgeContext (POLICY)
 *   4. Approved knowledge documents    — buildKnowledgeContext (others)
 *   5. Approved feedback               — buildFeedbackContext
 *
 * Retrieval is capped: never the whole catalog per message.
 */

export interface Citation {
  sourceType: "PRODUCT" | "FAQ" | "FEEDBACK" | "DOCUMENT" | "MEDIA";
  sourceId: string;
}

export interface AIContext {
  product?: {
    id: string;
    name: string;
    sku: string;
    price: string;
    currency: string;
    compareAtPrice: string | null;
    stockStatus: string;
    shortDescription: string | null;
    description: string | null;
    benefits: string[];
    usage: string | null;
    warnings: string | null;
    ingredients: string | null;
    objections: string[];
    salesNotes: string | null;
    faqs: { id: string; question: string; answer: string }[];
  };
  knowledge: { faqs: { id: string; question: string; answer: string }[]; documents: { id: string; content: string; score: number }[] };
  feedback: { id: string; content: string; rating: number | null; source: string | null; mediaUrl: string | null }[];
  media: { id: string; url: string; type: string; title: string | null; category: string }[];
  citations: Citation[];
}

// ── Individual builders (Phase 4 composes these via buildAIContext) ─────────

/** PRIORITY 2: structured product data is the single source of truth for price. */
export async function buildProductContext(db: Db, workspaceId: string, productId: string) {
  const product = await db.product.findUnique({
    where: { id: productId },
    include: { faqs: { where: { isActive: true }, take: 5 } },
  });
  if (!product || product.workspaceId !== workspaceId) throw new NotFoundError("Product");

  return {
    product: {
      id: product.id,
      name: product.name,
      sku: product.sku,
      // Price comes from DB decimals — never from AI or knowledge text.
      price: product.price.toString(),
      currency: product.currency,
      compareAtPrice: product.compareAtPrice ? product.compareAtPrice.toString() : null,
      stockStatus: product.stockStatus,
      shortDescription: product.shortDescription,
      description: product.description,
      benefits: product.benefits,
      usage: product.usage,
      warnings: product.warnings,
      ingredients: product.ingredients,
      objections: product.objections,
      salesNotes: product.salesNotes,
      faqs: product.faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
    } as AIContext["product"],
    citations: [
      { sourceType: "PRODUCT", sourceId: product.id } as Citation,
      ...product.faqs.map((f) => ({ sourceType: "FAQ", sourceId: f.id }) as Citation),
    ],
  };
}

/** PRIORITIES 3–4: approved policies + knowledge documents via hybrid retrieval. */
export async function buildKnowledgeContext(
  db: Db,
  vectorStore: VectorStore,
  params: { workspaceId: string; query: string; productId?: string; category?: KnowledgeCategory; limit?: number }
) {
  const result = await retrieveKnowledge(db, vectorStore, params);
  return {
    knowledge: {
      faqs: result.faqs,
      documents: result.chunks.map((c) => ({ id: c.chunkId, content: c.content, score: c.score })),
    } as AIContext["knowledge"],
    citations: [
      ...result.faqs.map((f) => ({ sourceType: "FAQ", sourceId: f.id }) as Citation),
      ...result.chunks.map((c) => ({ sourceType: "DOCUMENT", sourceId: c.chunkId }) as Citation),
    ],
  };
}

/** PRIORITY 5: ONLY approved, non-archived feedback; quoted verbatim. */
export async function buildFeedbackContext(
  db: Db,
  workspaceId: string,
  productId: string,
  limit = 3
) {
  const feedbacks = await getApprovedFeedbackForProduct(db, workspaceId, productId, limit);
  const mediaIds = feedbacks.map((f) => f.mediaId).filter((id): id is string => Boolean(id));
  const mediaAssets = mediaIds.length
    ? await db.mediaAsset.findMany({ where: { id: { in: mediaIds }, workspaceId }, select: { id: true, url: true } })
    : [];
  const mediaById = new Map(mediaAssets.map((m) => [m.id, m.url]));
  return {
    feedback: feedbacks.map((f) => ({
      id: f.id,
      content: f.content ?? "",
      rating: f.rating,
      source: f.source,
      mediaUrl: f.mediaId ? mediaById.get(f.mediaId) ?? null : null,
    })) as AIContext["feedback"],
    citations: feedbacks.map((f) => ({ sourceType: "FEEDBACK", sourceId: f.id }) as Citation),
  };
}

export async function buildMediaContext(
  db: Db,
  params: { workspaceId: string; productId?: string; query?: string; limit?: number }
) {
  const assets = params.productId
    ? await findProductMedia(db, params.workspaceId, params.productId, params.limit ?? 3)
    : await findRelevantMedia(db, {
        workspaceId: params.workspaceId,
        query: params.query,
        limit: params.limit ?? 3,
      });
  return {
    media: assets.map((a) => ({ id: a.id, url: a.url, type: a.type, title: a.title, category: a.category })) as AIContext["media"],
    citations: assets.map((a) => ({ sourceType: "MEDIA", sourceId: a.id }) as Citation),
  };
}

// ── Composition entry point for Phase 4 ─────────────────────────────────────

export async function buildAIContext(
  db: Db,
  vectorStore: VectorStore,
  params: {
    workspaceId: string;
    query: string;
    productId?: string;
    knowledgeLimit?: number;
  }
): Promise<AIContext> {
  const [productCtx, knowledgeCtx, feedbackCtx, mediaCtx] = await Promise.all([
    params.productId
      ? buildProductContext(db, params.workspaceId, params.productId)
      : Promise.resolve({ product: undefined, citations: [] as Citation[] }),
    buildKnowledgeContext(db, vectorStore, {
      workspaceId: params.workspaceId,
      query: params.query,
      productId: params.productId,
      limit: params.knowledgeLimit ?? 4,
    }),
    params.productId
      ? buildFeedbackContext(db, params.workspaceId, params.productId)
      : Promise.resolve({ feedback: [], citations: [] as Citation[] }),
    buildMediaContext(db, {
      workspaceId: params.workspaceId,
      productId: params.productId,
      query: params.query,
      limit: 3,
    }),
  ]);

  return {
    product: productCtx.product,
    knowledge: knowledgeCtx.knowledge,
    feedback: feedbackCtx.feedback,
    media: mediaCtx.media,
    citations: [...productCtx.citations, ...knowledgeCtx.citations, ...feedbackCtx.citations, ...mediaCtx.citations],
  };
}
