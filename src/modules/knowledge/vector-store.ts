import { getCurrentEmbeddingIdentity } from "./embeddings";

/**
 * VectorStore abstraction — keeps retrieval logic testable and lets the store
 * be swapped (pgvector today, other engines later). Workspace isolation is a
 * required filter of the interface, enforced INSIDE the query implementation.
 * Search ONLY returns chunks created with the currently configured
 * embedding provider/model/dimensions to prevent semantic drift.
 */
export interface VectorMatch {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
}

export interface VectorQuery {
  embedding: number[];
  workspaceId: string;
  limit?: number;
  documentId?: string;
  /** Extra equality filters stored in chunk metadata. */
  metadataFilters?: Record<string, string>;
}

export interface VectorStore {
  search(query: VectorQuery): Promise<VectorMatch[]>;
}

/** Current embedding identity used to filter compatible vectors. */
function getEmbeddingFilter(): { provider: string; model: string; dimensions: number } {
  return getCurrentEmbeddingIdentity();
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** In-memory store used in tests and as a fallback when pgvector is absent. */
export class InMemoryVectorStore implements VectorStore {
  constructor(
    private vectors: Map<string, number[]>,
    private rows: Map<string, Omit<VectorMatch, "chunkId" | "score"> & { workspaceId: string; metadata: Record<string, unknown>; isActive: boolean; embeddingProvider?: string; embeddingModel?: string; embeddingDimensions?: number }>
  ) {}

  async search(query: VectorQuery): Promise<VectorMatch[]> {
    const limit = query.limit ?? 5;
    const filter = getEmbeddingFilter();
    const results: VectorMatch[] = [];
    for (const [chunkId, vec] of this.vectors) {
      const row = this.rows.get(chunkId);
      if (!row || !row.isActive) continue;
      if (row.workspaceId !== query.workspaceId) continue;
      if (query.documentId && row.documentId !== query.documentId) continue;
      // Filter by embedding generation to prevent mixing incompatible vectors
      if (row.embeddingProvider !== filter.provider || row.embeddingModel !== filter.model || row.embeddingDimensions !== filter.dimensions) {
        continue;
      }
      if (query.metadataFilters) {
        const ok = Object.entries(query.metadataFilters).every(
          ([k, v]) => (row.metadata as Record<string, unknown>)[k] === v
        );
        if (!ok) continue;
      }
      results.push({
        chunkId,
        documentId: row.documentId,
        content: row.content,
        score: cosineSimilarity(query.embedding, vec),
      });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/** pgvector-backed store. The workspace filter lives inside the SQL query. */
export class PgVectorStore implements VectorStore {
  constructor(private readonly queryFn: (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>) {}

  async search(query: VectorQuery): Promise<VectorMatch[]> {
    const limit = query.limit ?? 5;
    const filter = getEmbeddingFilter();
    const vectorLiteral = `[${query.embedding.join(",")}]`;
    const params: unknown[] = [vectorLiteral, query.workspaceId, filter.provider, filter.model, filter.dimensions, limit];
    let sql = `
      SELECT c.id AS "chunkId", c."documentId" AS "documentId", c.content, c.metadata,
             1 - (c.embedding <=> $1::vector) AS score
      FROM "KnowledgeChunk" c
      WHERE c.workspaceId = $2
        AND c."isActive" = true
        AND c.embedding IS NOT NULL
        AND c."embeddingProvider" = $3
        AND c."embeddingModel" = $4
        AND c."embeddingDimensions" = $5`;
    if (query.documentId) {
      params.push(query.documentId);
      sql += ` AND c."documentId" = $${params.length}`;
    }
    sql += ` ORDER BY c.embedding <=> $1::vector LIMIT $6`;
    const rows = await this.queryFn(sql, params);
    return rows.map((r) => ({
      chunkId: String(r.chunkId),
      documentId: String(r.documentId),
      content: String(r.content),
      score: Number(r.score),
    }));
  }
}
