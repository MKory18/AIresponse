import { describe, expect, it } from "vitest";
import { PgVectorStore } from "@/modules/knowledge/vector-store";

/**
 * P1 regression: PgVectorStore.search emitted `c.workspaceId` unquoted, which
 * Postgres folds to `workspaceid` (42703) — the real-pgvector path was broken
 * while all unit tests used InMemoryVectorStore. Found by a live local smoke
 * test against real PostgreSQL. These tests pin the generated SQL.
 */
describe("P1 pgvector SQL quoting", () => {
  it("quotes camelCase identifiers (workspaceId survives Postgres folding)", async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const store = new PgVectorStore(async (sql, params) => {
      seen.push({ sql, params });
      return [];
    });
    await store.search({ embedding: [0.1, 0.2], workspaceId: "ws-1", limit: 3 });
    expect(seen).toHaveLength(1);
    const { sql, params } = seen[0];
    expect(sql).toContain('c."workspaceId"');
    expect(sql).not.toMatch(/c\.workspaceId/);
    expect(sql).toContain('c."isActive"');
    expect(sql).toContain('c."embeddingProvider"');
    // $1 vector, $2 workspace, $3..$5 identity filter, $6 limit.
    expect(params[1]).toBe("ws-1");
    expect(sql).toContain("LIMIT $6");
  });

  it("keeps LIMIT bound to $6 when documentId filter is appended as $7", async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const store = new PgVectorStore(async (sql, params) => {
      seen.push({ sql, params });
      return [];
    });
    await store.search({ embedding: [0.1], workspaceId: "ws-1", limit: 3, documentId: "doc-1" });
    const { sql, params } = seen[0];
    expect(sql).toContain('AND c."documentId" = $7');
    expect(sql).toContain("LIMIT $6");
    expect(params[5]).toBe(3);
    expect(params[6]).toBe("doc-1");
  });

  it("maps rows and coerces score (end-to-end shape, no DB)", async () => {
    const store = new PgVectorStore(async () => [
      { chunkId: "c1", documentId: "d1", content: "hello", score: "0.9" },
    ]);
    const out = await store.search({ embedding: [0.1], workspaceId: "ws-1" });
    expect(out).toEqual([{ chunkId: "c1", documentId: "d1", content: "hello", score: 0.9 }]);
  });
});
