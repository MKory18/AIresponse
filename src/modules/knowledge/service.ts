import type { Prisma, KnowledgeCategory } from "@prisma/client";
import { NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import { enqueueJob } from "@/modules/jobs/service";
import type { ActorContext, Db, Paginated } from "@/modules/customers/service";

// ── Documents ───────────────────────────────────────────────────────────────

export async function createKnowledgeDocument(
  db: Db,
  ctx: ActorContext,
  input: {
    title: string;
    content: string;
    category?: KnowledgeCategory;
    sourceType?: string;
    sourceUrl?: string | null;
  }
) {
  const doc = await db.knowledgeDocument.create({
    data: {
      workspaceId: ctx.workspaceId,
      title: input.title,
      content: input.content,
      category: input.category ?? "CUSTOM",
      sourceType: input.sourceType ?? "MANUAL",
      sourceUrl: input.sourceUrl ?? null,
      status: "PROCESSING",
    },
  });

  await enqueueJob(db, {
    workspaceId: ctx.workspaceId,
    type: "process_knowledge_document",
    payload: { documentId: doc.id },
  });

  await eventBus.publish(makeEvent("KnowledgeDocumentCreated", ctx.workspaceId, { documentId: doc.id }));
  return doc;
}

export async function getOwnedDocument(db: Db, workspaceId: string, documentId: string) {
  const doc = await db.knowledgeDocument.findUnique({
    where: { id: documentId },
    include: { chunks: { where: { isActive: true }, orderBy: { chunkIndex: "asc" } } },
  });
  if (!doc || doc.workspaceId !== workspaceId) throw new NotFoundError("Knowledge document");
  // Never ship raw embedding vectors to API clients — strip them in JS so
  // the guarantee holds on every backend (Prisma select or in-memory stub).
  const chunks = ((doc as { chunks?: Array<Record<string, unknown>> }).chunks ?? []).map((c) => {
    const { embedding: _embedding, ...rest } = c;
    void _embedding;
    return rest;
  });
  return { ...doc, chunks };
}

export async function listDocuments(
  db: Db,
  params: {
    workspaceId: string;
    status?: "UPLOADING" | "PROCESSING" | "READY" | "FAILED" | "ARCHIVED";
    category?: KnowledgeCategory;
    q?: string;
    cursor?: string;
    limit?: number;
  }
): Promise<Paginated<Prisma.KnowledgeDocumentGetPayload<Record<string, never>>>> {
  const limit = Math.min(params.limit ?? 25, 100);
  const where: Prisma.KnowledgeDocumentWhereInput = { workspaceId: params.workspaceId };
  if (params.status) where.status = params.status;
  if (params.category) where.category = params.category;
  if (params.q) where.title = { contains: params.q, mode: "insensitive" };

  const docs = await db.knowledgeDocument.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });
  const hasMore = docs.length > limit;
  const items = hasMore ? docs.slice(0, limit) : docs;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

/** Editing content bumps the version and re-processes; old chunks are deactivated. */
export async function updateDocument(
  db: Db,
  ctx: ActorContext,
  documentId: string,
  data: { title?: string; content?: string; category?: KnowledgeCategory; isActive?: boolean }
) {
  const doc = await getOwnedDocument(db, ctx.workspaceId, documentId);

  const contentChanged = data.content !== undefined && data.content !== doc.content;
  const updated = await db.knowledgeDocument.update({
    where: { id: documentId },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      ...(contentChanged
        ? {
            content: data.content!,
            version: { increment: 1 },
            status: "PROCESSING" as const,
            error: null,
          }
        : {}),
      ...(data.isActive === false ? { status: "ARCHIVED" as const } : {}),
    },
  });

  if (contentChanged) {
    await db.knowledgeChunk.updateMany({
      where: { documentId },
      data: { isActive: false },
    });
    await enqueueJob(db, {
      workspaceId: ctx.workspaceId,
      type: "process_knowledge_document",
      payload: { documentId },
    });
  } else if (data.isActive === true && doc.status === "FAILED") {
    // Retry a failed document: re-enqueue processing.
    await db.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: "PROCESSING", error: null },
    });
    await enqueueJob(db, {
      workspaceId: ctx.workspaceId,
      type: "process_knowledge_document",
      payload: { documentId },
    });
  }

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "knowledge_document.updated",
    entityType: "KnowledgeDocument",
    entityId: documentId,
    metadata: { reprocessed: contentChanged },
  });
  await eventBus.publish(makeEvent("KnowledgeDocumentUpdated", ctx.workspaceId, { documentId }));
  return updated;
}

export async function archiveDocument(db: Db, ctx: ActorContext, documentId: string) {
  await getOwnedDocument(db, ctx.workspaceId, documentId);
  await db.knowledgeChunk.updateMany({ where: { documentId }, data: { isActive: false } });
  const updated = await db.knowledgeDocument.update({
    where: { id: documentId },
    data: { status: "ARCHIVED", isActive: false },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "knowledge_document.archived",
    entityType: "KnowledgeDocument",
    entityId: documentId,
  });
  return updated;
}

/** Hard delete: removes the document and all its chunks (workspace-scoped). */
export async function deleteKnowledgeDocument(db: Db, ctx: ActorContext, documentId: string) {
  await getOwnedDocument(db, ctx.workspaceId, documentId);
  await db.knowledgeChunk.deleteMany({ where: { documentId } });
  await db.knowledgeDocument.delete({ where: { id: documentId } });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "knowledge_document.deleted",
    entityType: "KnowledgeDocument",
    entityId: documentId,
  });
  return { ok: true };
}

/** Explicit reindex: reset to PROCESSING and re-enqueue ingestion (idempotent). */
export async function reindexDocument(db: Db, ctx: ActorContext, documentId: string) {
  const doc = await getOwnedDocument(db, ctx.workspaceId, documentId);
  if ((doc as { status?: string }).status === "ARCHIVED") {
    const { AppError } = await import("@/core/errors");
    throw new AppError("Cannot reindex an archived document", 422, "VALIDATION_ERROR");
  }
  await db.knowledgeChunk.updateMany({ where: { documentId }, data: { isActive: false } });
  const updated = await db.knowledgeDocument.update({
    where: { id: documentId },
    data: { status: "PROCESSING", error: null, isActive: true },
  });
  await enqueueJob(db, {
    workspaceId: ctx.workspaceId,
    type: "process_knowledge_document",
    payload: { documentId },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "knowledge_document.reindexed",
    entityType: "KnowledgeDocument",
    entityId: documentId,
  });
  await eventBus.publish(makeEvent("KnowledgeDocumentUpdated", ctx.workspaceId, { documentId }));
  return updated;
}

// ── Semantic search (powers the in-UI "اختبر البحث" debugger) ───────────────

export interface KnowledgeSearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string | null;
  documentCategory: string | null;
  score: number;
  preview: string;
  content: string;
}

/**
 * Real vector search over active chunks (workspace-scoped inside the store).
 * The store/embedder are injectable so tests run offline (Hash + InMemory)
 * while production uses OpenAI embeddings + pgvector.
 */
export async function searchKnowledge(
  db: Db,
  params: { workspaceId: string; query: string; limit?: number; category?: KnowledgeCategory },
  deps?: {
    vectorStore?: import("./vector-store").VectorStore;
    embedder?: { embed: (text: string) => Promise<number[]> };
  }
): Promise<KnowledgeSearchHit[]> {
  const { getEmbeddingProvider } = await import("./embeddings");
  const { PgVectorStore } = await import("./vector-store");
  const raw = db as unknown as {
    $queryRawUnsafe: (sql: string, ...params: Array<unknown>) => Promise<Array<Record<string, unknown>>>;
  };
  const store =
    deps?.vectorStore ?? new PgVectorStore((sql, sqlParams) => raw.$queryRawUnsafe(sql, ...sqlParams));
  const embedder = deps?.embedder ?? getEmbeddingProvider();
  const embedding = await embedder.embed(params.query);
  const matches = await store.search({
    embedding,
    workspaceId: params.workspaceId,
    limit: Math.min(params.limit ?? 5, 20),
    metadataFilters: params.category ? { category: params.category } : undefined,
  });
  const docIds = [...new Set(matches.map((m) => m.documentId))];
  const docs =
    docIds.length > 0
      ? await db.knowledgeDocument.findMany({
          where: { workspaceId: params.workspaceId, id: { in: docIds } },
          select: { id: true, title: true, category: true },
        })
      : [];
  const byId = new Map(docs.map((d) => [d.id, d]));
  return matches.map((m) => ({
    chunkId: m.chunkId,
    documentId: m.documentId,
    documentTitle: (byId.get(m.documentId)?.title as string) ?? null,
    documentCategory: (byId.get(m.documentId)?.category as string) ?? null,
    score: m.score,
    preview: m.content.slice(0, 300),
    content: m.content,
  }));
}

// ── FAQs ────────────────────────────────────────────────────────────────────

export async function createFaq(
  db: Db,
  ctx: ActorContext,
  input: { question: string; answer: string; category?: string | null; productId?: string | null; tags?: string[] }
) {
  if (input.productId) {
    const product = await db.product.findUnique({ where: { id: input.productId }, select: { workspaceId: true } });
    if (!product || product.workspaceId !== ctx.workspaceId) throw new NotFoundError("Product");
  }
  const faq = await db.faq.create({
    data: { ...input, workspaceId: ctx.workspaceId },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "faq.created",
    entityType: "Faq",
    entityId: faq.id,
  });
  return faq;
}

export async function listFaqs(
  db: Db,
  params: { workspaceId: string; productId?: string; q?: string; limit?: number }
) {
  const where: Prisma.FaqWhereInput = { workspaceId: params.workspaceId };
  if (params.productId) where.productId = params.productId;
  if (params.q) {
    where.OR = [
      { question: { contains: params.q, mode: "insensitive" } },
      { answer: { contains: params.q, mode: "insensitive" } },
    ];
  }
  return db.faq.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(params.limit ?? 100, 200),
  });
}

export async function updateFaq(
  db: Db,
  ctx: ActorContext,
  faqId: string,
  data: { question?: string; answer?: string; category?: string | null; isActive?: boolean; tags?: string[] }
) {
  const faq = await db.faq.findUnique({ where: { id: faqId } });
  if (!faq || faq.workspaceId !== ctx.workspaceId) throw new NotFoundError("FAQ");
  return db.faq.update({ where: { id: faqId }, data });
}

/** FAQ retrieval: direct structured lookup — no vector search needed. */
export async function findMatchingFaqs(
  db: Db,
  params: { workspaceId: string; query: string; productId?: string; limit?: number }
) {
  const words = params.query.split(/\s+/).filter((w) => w.length > 2).slice(0, 6);
  if (words.length === 0) return [];
  const wordMatches = [
    ...words.map((w) => ({ question: { contains: w, mode: "insensitive" as const } })),
    ...words.map((w) => ({ answer: { contains: w, mode: "insensitive" as const } })),
  ];
  const where: Prisma.FaqWhereInput = {
    workspaceId: params.workspaceId,
    isActive: true,
    AND: [
      { OR: wordMatches },
      ...(params.productId ? [{ productId: params.productId }] : []),
    ],
  };
  return db.faq.findMany({ where, take: params.limit ?? 3 });
}
