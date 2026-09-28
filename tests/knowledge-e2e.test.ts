import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import {
  createKnowledgeDocument,
  getOwnedDocument,
  deleteKnowledgeDocument,
  reindexDocument,
  searchKnowledge,
} from "@/modules/knowledge/service";
import { extractText } from "@/modules/knowledge/extract";
import { HashEmbeddingProvider } from "@/modules/knowledge/embeddings";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";
import { runJobs } from "@/modules/jobs/handlers";
import { NotFoundError } from "@/core/errors";

const WS_A = "ws-kn-a";
const WS_B = "ws-kn-b";
const ctxA = { userId: "user-1", workspaceId: WS_A };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  db = createFakeDb();
});

describe("KNOWLEDGE e2e — documents & ingestion", () => {
  it("10+11. create → PROCESSING + job → runJobs → READY", async () => {
    const doc = (await createKnowledgeDocument(db as Db, ctxA, {
      title: "سياسة الإرجاع",
      content: "يمكن إرجاع المنتج خلال 7 أيام من الاستلام. الإرجاع مجاني داخل المدينة.",
      category: "POLICY",
    })) as unknown as { id: string; status: string };
    expect(doc.status).toBe("PROCESSING");
    expect((db._stores.backgroundJob as unknown[])).toHaveLength(1);
    await runJobs(db as Db);
    const stored = (db._stores.knowledgeDocument as Array<{ id: string; status: string }>).find((d) => d.id === doc.id)!;
    expect(stored.status).toBe("READY");
  });

  it("12+13. chunks with content/index + 1536-dim embeddings", async () => {
    const doc = (await createKnowledgeDocument(db as Db, ctxA, {
      title: "أسعار",
      content: "سعر ماء الكمأة 150000 ليرة. التوصيل خلال 24 ساعة لجميع المحافظات.",
    })) as unknown as { id: string };
    await runJobs(db as Db);
    const chunks = (db._stores.knowledgeChunk as Array<{ documentId: string; content: string; chunkIndex: number; embedding: string; isActive: boolean }>)
      .filter((c) => c.documentId === doc.id && c.isActive);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].content.length).toBeGreaterThan(0);
    const vec = JSON.parse(chunks[0].embedding) as number[];
    expect(vec).toHaveLength(1536);
  });

  it("16a. reindex resets FAILED → PROCESSING and re-enqueues", async () => {
    const doc = (await createKnowledgeDocument(db as Db, ctxA, { title: "t", content: "نص كاف للمعالجة هنا" })) as unknown as { id: string };
    await (db as { knowledgeDocument: { update: (a: unknown) => Promise<unknown> } }).knowledgeDocument.update({
      where: { id: doc.id }, data: { status: "FAILED", error: "boom" },
    });
    const jobsBefore = (db._stores.backgroundJob as unknown[]).length;
    const updated = (await reindexDocument(db as Db, ctxA, doc.id)) as unknown as { status: string; error: null };
    expect(updated.status).toBe("PROCESSING");
    expect(updated.error).toBeNull();
    expect((db._stores.backgroundJob as unknown[]).length).toBeGreaterThan(jobsBefore);
  });

  it("16b. delete removes document + chunks", async () => {
    const doc = (await createKnowledgeDocument(db as Db, ctxA, { title: "t", content: "نص كاف للمعالجة هنا" })) as unknown as { id: string };
    await runJobs(db as Db);
    await deleteKnowledgeDocument(db as Db, ctxA, doc.id);
    expect((db._stores.knowledgeDocument as Array<{ id: string }>).find((d) => d.id === doc.id)).toBeUndefined();
    expect((db._stores.knowledgeChunk as Array<{ documentId: string }>).filter((c) => c.documentId === doc.id)).toHaveLength(0);
  });

  it("15+16c. workspace isolation + embeddings never shipped to clients", async () => {
    const doc = (await createKnowledgeDocument(db as Db, ctxA, { title: "t", content: "نص كاف للمعالجة والفهرسة هنا" })) as unknown as { id: string };
    await runJobs(db as Db);
    await expect(getOwnedDocument(db as Db, WS_B, doc.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteKnowledgeDocument(db as Db, { ...ctxA, workspaceId: WS_B }, doc.id)).rejects.toBeInstanceOf(NotFoundError);
    const fetched = (await getOwnedDocument(db as Db, WS_A, doc.id)) as unknown as { chunks: Array<Record<string, unknown>> };
    expect(fetched.chunks.length).toBeGreaterThan(0);
    for (const c of fetched.chunks) expect("embedding" in c).toBe(false);
  });
});

describe("KNOWLEDGE e2e — file extraction", () => {
  it("extracts txt/md/json/csv and rejects binaries", async () => {
    expect(await extractText("text/plain", "n.txt", Buffer.from("مرحبا بالعالم"))).toContain("مرحبا");
    expect(await extractText("text/markdown", "n.md", Buffer.from("# عنوان"))).toContain("عنوان");
    expect(await extractText("application/json", "n.json", Buffer.from('{"a":1}'))).toContain('"a"');
    await expect(extractText("application/zip", "n.zip", Buffer.from("x"))).rejects.toThrow();
  });
});

describe("KNOWLEDGE e2e — semantic search", () => {
  async function seedDoc(title: string, content: string) {
    const doc = (await createKnowledgeDocument(db as Db, ctxA, { title, content })) as unknown as { id: string };
    await runJobs(db as Db);
    return doc.id;
  }

  function memoryStore() {
    const vectors = new Map<string, number[]>();
    const rows = new Map<string, { documentId: string; workspaceId: string; content: string; metadata: Record<string, unknown>; isActive: boolean }>();
    const embedder = new HashEmbeddingProvider(1536);
    return { vectors, rows, embedder };
  }

  async function indexInto(store: { vectors: Map<string, number[]>; rows: Map<string, { documentId: string; workspaceId: string; content: string; metadata: Record<string, unknown>; isActive: boolean }>; embedder: HashEmbeddingProvider }) {
    for (const c of db._stores.knowledgeChunk as Array<{ id: string; documentId: string; content: string; workspaceId: string; isActive: boolean }>) {
      if (!c.isActive) continue;
      store.vectors.set(c.id, await store.embedder.embed(c.content));
      store.rows.set(c.id, { documentId: c.documentId, workspaceId: c.workspaceId, content: c.content, metadata: {}, isActive: true });
    }
    return new InMemoryVectorStore(store.vectors, store.rows);
  }

  it("14. semantic search returns scored hits with source titles + previews", async () => {
    await seedDoc("الأسعار", "سعر ماء الكمأة 150000 ليرة سورية. الدفع عند الاستلام.");
    await seedDoc("التوصيل", "التوصيل خلال 24 إلى 48 ساعة لجميع المحافظات.");
    const mem = memoryStore();
    const store = await indexInto(mem);
    const hits = await searchKnowledge(
      db as Db,
      { workspaceId: WS_A, query: "بكم ماء الكمأة؟", limit: 5 },
      { vectorStore: store, embedder: mem.embedder }
    );
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0];
    expect(typeof top.score).toBe("number");
    expect(top.documentTitle).toBeTruthy();
    expect(top.preview.length).toBeGreaterThan(0);
    expect(top.preview.length).toBeLessThanOrEqual(300);
    // Sorted best-first.
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
  });

  it("15b. search is workspace-isolated", async () => {
    await seedDoc("سري", "محتوى خاص بالمساحة أ لا يجب أن يظهر elsewhere");
    const mem = memoryStore();
    const store = await indexInto(mem);
    const hitsB = await searchKnowledge(
      db as Db,
      { workspaceId: WS_B, query: "محتوى خاص", limit: 5 },
      { vectorStore: store, embedder: mem.embedder }
    );
    expect(hitsB).toHaveLength(0);
  });
});
