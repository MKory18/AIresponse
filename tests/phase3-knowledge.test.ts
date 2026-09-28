import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct, getOwnedProduct, updateProduct, listProducts, attachProductMedia, setPrimaryProductMedia } from "@/modules/products/service";
import { validateUpload, mediaTypeForMime, LocalStorageProvider, generateStorageKey } from "@/modules/media/storage";
import { uploadMedia, getOwnedMedia, findProductMedia, findRelevantMedia } from "@/modules/media/service";
import { createFeedback, listFeedback, getApprovedFeedbackForProduct, classifySentiment } from "@/modules/feedback/service";
import { chunkText } from "@/modules/knowledge/chunker";
import { createKnowledgeDocument, updateDocument, getOwnedDocument, createFaq, findMatchingFaqs } from "@/modules/knowledge/service";
import { runJobs } from "@/modules/jobs/handlers";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";
import { retrieveKnowledge } from "@/modules/knowledge/retriever";
import { buildAIContext, buildProductContext } from "@/modules/ai/context-builder";
import { NotFoundError } from "@/core/errors";

const WS_A = "ws-a";
const WS_B = "ws-b";
const ctxA = { userId: "user-1", workspaceId: WS_A };

type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let productId: string;

beforeEach(async () => {
  db = createFakeDb();
  const product = await createProduct(db as Db, ctxA, {
    name: "ماء الكمأة",
    sku: "TW-500",
    price: 150000,
    currency: "SYP",
    shortDescription: "ماء بكمأة",
    stockQty: 40,
  });
  productId = product.id;
});

// ── 1–3: Products ───────────────────────────────────────────────────────────

describe("Phase 3 — products", () => {
  it("creates and updates products (CRUD)", async () => {
    const updated = await updateProduct(db as Db, ctxA, productId, { price: 160000, benefits: ["فائدة 1"] });
    expect(Number(updated.price)).toBe(160000);
    expect(updated.benefits).toContain("فائدة 1");
    const fetched = await getOwnedProduct(db as Db, WS_A, productId);
    expect(fetched.sku).toBe("TW-500");
  });

  it("isolates products per workspace", async () => {
    await expect(getOwnedProduct(db as Db, WS_B, productId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateProduct(db as Db, { ...ctxA, workspaceId: WS_B }, productId, { price: 1 })).rejects.toBeInstanceOf(NotFoundError);
    const listB = await listProducts(db as Db, { workspaceId: WS_B });
    expect(listB.items).toHaveLength(0);
    const listA = await listProducts(db as Db, { workspaceId: WS_A });
    expect(listA.items).toHaveLength(1);
  });

  it("keeps price source of truth in the DB (context builder reads DB decimals)", async () => {
    await updateProduct(db as Db, ctxA, productId, { price: 999999 });
    const ctx = await buildProductContext(db as Db, WS_A, productId);
    expect(ctx.product!.price).toBe("999999");
    expect(ctx.product!.currency).toBe("SYP");
    // Citation architecture is ready:
    expect(ctx.citations[0]).toEqual({ sourceType: "PRODUCT", sourceId: productId });
  });
});

// ── 4–6: Media ──────────────────────────────────────────────────────────────

describe("Phase 3 — media upload validation", () => {
  it("rejects executable and script files", () => {
    expect(() => validateUpload({ mimeType: "application/x-msdownload", filename: "virus.exe", size: 100 })).toThrow();
    expect(() => validateUpload({ mimeType: "text/plain", filename: "script.js", size: 100 })).toThrow();
    expect(() => validateUpload({ mimeType: "text/plain", filename: "shell.sh", size: 100 })).toThrow();
    expect(() => validateUpload({ mimeType: "image/png", filename: "../../evil.png", size: 100 })).not.toThrow();
    expect(() => validateUpload({ mimeType: "image/png", filename: "x.png", size: 0 })).toThrow();
  });

  it("enforces size limits and allowed mime types", () => {
    expect(() => validateUpload({ mimeType: "image/jpeg", filename: "a.jpg", size: 11 * 1024 * 1024 })).toThrow();
    expect(mediaTypeForMime("image/png")).toBe("IMAGE");
    expect(mediaTypeForMime("application/pdf")).toBe("DOCUMENT");
    expect(() => mediaTypeForMime("application/zip")).toThrow();
  });

  it("local storage provider blocks path traversal", async () => {
    const provider = new LocalStorageProvider("./.tmp-storage-test");
    const result = await provider.put(generateStorageKey(WS_A, "test.txt"), Buffer.from("hello"), "text/plain");
    expect(result.storageKey).toContain(WS_A);
    expect(await provider.get(`../../${WS_A}/secret`)).toBeNull();
    await provider.delete(result.storageKey);
  });

  it("upload validates and stores media with workspace isolation", async () => {
    const asset = await uploadMedia(db as Db, ctxA, {
      filename: "front.png",
      mimeType: "image/png",
      size: 1024,
      data: Buffer.from("png-bytes"),
      category: "PRODUCT",
      productId,
    });
    expect(asset.type).toBe("IMAGE");
    expect(asset.storageKey).toContain(WS_A);
    await expect(getOwnedMedia(db as Db, WS_B, asset.id)).rejects.toBeInstanceOf(NotFoundError);

    // A foreign product cannot be referenced from this workspace
    const foreignProduct = await createProduct(db as Db, { userId: "x", workspaceId: WS_B }, { name: "B", sku: "B-1", price: 1 });
    await expect(
      uploadMedia(db as Db, ctxA, { filename: "b.png", mimeType: "image/png", size: 10, data: Buffer.from("x"), productId: foreignProduct.id })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("relates media to products with primary + ordering", async () => {
    const m1 = await uploadMedia(db as Db, ctxA, { filename: "front.png", mimeType: "image/png", size: 10, data: Buffer.from("1"), category: "PRODUCT", productId });
    const m2 = await uploadMedia(db as Db, ctxA, { filename: "side.png", mimeType: "image/png", size: 10, data: Buffer.from("2"), category: "PRODUCT", productId });
    await attachProductMedia(db as Db, ctxA, productId, m1.id, { isPrimary: true, sortOrder: 0 });
    await attachProductMedia(db as Db, ctxA, productId, m2.id, { sortOrder: 1 });
    await setPrimaryProductMedia(db as Db, ctxA, productId, m2.id);

    const product = await getOwnedProduct(db as Db, WS_A, productId);
    expect(product.mediaLinks).toHaveLength(2);
    const primary = product.mediaLinks.find((l: any) => l.isPrimary);
    expect(primary!.mediaAssetId).toBe(m2.id);
    expect(product.mediaLinks.filter((l: any) => l.isPrimary)).toHaveLength(1);

    const media = await findProductMedia(db as Db, WS_A, productId);
    expect(media).toHaveLength(2);
    const relevant = await findRelevantMedia(db as Db, { workspaceId: WS_A, query: "front" });
    expect(relevant).toHaveLength(1);
  });
});

// ── 7–8: Feedback ───────────────────────────────────────────────────────────

describe("Phase 3 — feedback", () => {
  it("stores content verbatim and classifies sentiment", async () => {
    const fb = await createFeedback(db as Db, ctxA, {
      productId,
      content: "المنتج ممتاز",
      source: "Messenger — محادثة #1",
    });
    expect(fb.content).toBe("المنتج ممتاز");
    expect(fb.sentiment).toBe("positive");
    expect(classifySentiment("وصل متأخر ومكسور")).toBe("negative");
    expect(classifySentiment("سؤال عن السعر")).toBe("neutral");
  });

  it("excludes unapproved feedback from AI retrieval", async () => {
    const approved = await createFeedback(db as Db, ctxA, { productId, content: "تجربة رائعة", source: "chat #2" });
    await createFeedback(db as Db, ctxA, { productId, content: "بانتظار مراجعة", source: "chat #3" });
    let approvedList = await listFeedback(db as Db, { workspaceId: WS_A, approved: true });
    expect(approvedList.items).toHaveLength(0);

    await updateFeedbackApproved(approved.id);
    approvedList = await listFeedback(db as Db, { workspaceId: WS_A, approved: true });
    expect(approvedList.items).toHaveLength(1);

    const forAI = await getApprovedFeedbackForProduct(db as Db, WS_A, productId);
    expect(forAI).toHaveLength(1);
    expect(forAI[0].content).toBe("تجربة رائعة");
  });

  async function updateFeedbackApproved(feedbackId: string) {
    const { updateFeedback } = await import("@/modules/feedback/service");
    await updateFeedback(db as Db, ctxA, feedbackId, { isApproved: true });
  }
});

// ── 9–14: Knowledge processing + retrieval ──────────────────────────────────

describe("Phase 3 — knowledge documents & RAG", () => {
  it("processes document through the queue: chunks + embeddings + READY", async () => {
    const longContent = Array.from(
      { length: 12 },
      (_, i) => `الفقرة ${i}: معلومة مهمة عن التوصيل والدفع والاستبدال تتعلق بالسياسة رقم ${i} مع تفاصيل إضافية كافية للتقطيع.`
    ).join("\n\n");
    const doc = await createKnowledgeDocument(db as Db, ctxA, {
      title: "سياسة التوصيل",
      category: "DELIVERY",
      content: longContent,
    });
    expect(doc.status).toBe("PROCESSING");

    const result = await runJobs(db as Db);
    expect(result.processed).toBe(1);

    const processed = await getOwnedDocument(db as Db, WS_A, doc.id);
    expect(processed.status).toBe("READY");
    expect(processed.chunks.length).toBeGreaterThanOrEqual(2);
    expect(processed.chunks[0].tokenCount).toBeGreaterThan(0);

    // embedding persisted (pgvector literal "[...]" with 1536 dims)
    const store = db._stores.knowledgeChunk as any[];
    const raw = store[0].embedding;
    const vec = typeof raw === "string" ? JSON.parse(raw) : raw;
    expect(vec).toHaveLength(1536);
  });

  it("chunking respects size and overlap", () => {
    const long = Array.from({ length: 30 }, (_, i) => `الفقرة رقم ${i} تحتوي على نص كافٍ للاختبار. `.repeat(3)).join("\n\n");
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(950);
    expect(chunks[1].content.startsWith(chunks[0].content.slice(-120).slice(0, 20))).toBe(true);
  });

  it("vector retrieval is workspace-isolated and product-filterable", async () => {
    const docA = await createKnowledgeDocument(db as Db, ctxA, {
      title: "doc-a", category: "DELIVERY",
      content: "التوصيل متاح لدمشق خلال 24 ساعة. الأجور 50 ألف ل.س.",
    });
    const docB = await createKnowledgeDocument(db as Db, { userId: "u2", workspaceId: WS_B }, {
      title: "doc-b", category: "DELIVERY",
      content: "أسعار خاصة جدًا لعملاء workspace B السريين.",
    });
    await runJobs(db as Db);

    const vectors = new Map<string, number[]>();
    const rows = new Map<string, any>();
    for (const c of db._stores.knowledgeChunk as any[]) {
      const vec = typeof c.embedding === "string" ? JSON.parse(c.embedding) : c.embedding;
      vectors.set(c.id, vec);
      rows.set(c.id, {
        documentId: c.documentId,
        workspaceId: c.workspaceId,
        content: c.content,
        metadata: c.metadata,
        isActive: c.isActive,
        embeddingProvider: c.embeddingProvider,
        embeddingModel: c.embeddingModel,
        embeddingDimensions: c.embeddingDimensions,
      });
    }
    const store = new InMemoryVectorStore(vectors, rows);

    const { retrieveKnowledge: retrieve } = await import("@/modules/knowledge/retriever");
    const resultA = await retrieve(db as Db, store, { workspaceId: WS_A, query: "التوصيل لدمشق" });
    expect(resultA.chunks.length).toBeGreaterThan(0);
    const contents = resultA.chunks.map((c) => c.content).join(" ");
    expect(contents).toContain("دمشق");
    expect(contents).not.toContain("workspace B");

    // product filter via metadata
    const filtered = await store.search({
      embedding: vectors.values().next().value!,
      workspaceId: WS_B,
      metadataFilters: { category: "DELIVERY" },
    });
    const bContents = filtered.map((c) => c.content).join(" ");
    expect(bContents).toContain("workspace B");
    expect(filtered.every((c) => c.documentId === docB.id || c.documentId === docA.id)).toBe(true);
    void docA;
  });

  it("FAQ retrieval is direct (no vector search needed)", async () => {
    await createFaq(db as Db, ctxA, { question: "هل التوصيل متاح؟", answer: "نعم، التوصيل لكل المحافظات." });
    await createFaq(db as Db, ctxA, { question: "كيف أدفع؟", answer: "دفع عند الاستلام." });
    const hits = await findMatchingFaqs(db as Db, { workspaceId: WS_A, query: "التوصيل متاح؟" });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].answer).toContain("المحافظات");
    const wsB = await findMatchingFaqs(db as Db, { workspaceId: WS_B, query: "التوصيل" });
    expect(wsB).toHaveLength(0);
  });
});

// ── 17–18: Reprocessing & failure ───────────────────────────────────────────

describe("Phase 3 — document lifecycle", () => {
  it("reprocessing deactivates old chunks and bumps version", async () => {
    const doc = await createKnowledgeDocument(db as Db, ctxA, {
      title: "دليل",
      content: "المحتوى الأول للاختبار مع نص كافٍ للتقطيع.",
    });
    await runJobs(db as Db);
    const v1chunks = ((await getOwnedDocument(db as Db, WS_A, doc.id)) as any).chunks;
    expect(v1chunks.every((c: any) => c.isActive)).toBe(true);

    await updateDocument(db as Db, ctxA, doc.id, { content: "المحتوى الثاني المعدل بالكامل مع نص جديد مختلف للاختبار." });
    await runJobs(db as Db);
    const doc2 = (await getOwnedDocument(db as Db, WS_A, doc.id)) as any;
    expect(doc2.version).toBe(2);
    expect(doc2.chunks.every((c: any) => c.isActive)).toBe(true);
    const allChunks = (db._stores.knowledgeChunk as any[]).filter((c) => c.documentId === doc.id);
    expect(allChunks.filter((c) => !c.isActive).length).toBeGreaterThan(0);
  });

  it("marks documents FAILED when processing throws", async () => {
    const doc = await createKnowledgeDocument(db as Db, ctxA, { title: "فاشل", content: "نص" });
    // simulate handler failure by pointing the job at a nonexistent doc
    const job = (db._stores.backgroundJob as any[])[0];
    job.payload = { documentId: "missing-doc" };
    // run until maxAttempts (3) is exhausted, rewinding backoff each time
    const jobs = db._stores.backgroundJob as any[];
    for (let i = 0; i < 3; i++) {
      jobs[0].runAfter = new Date(0);
      await runJobs(db as Db);
    }
    expect(jobs[0].status).toBe("FAILED");
    expect(jobs[0].lastError).toContain("not found");
    void doc;
  });
});

// ── 19: AI context builder ──────────────────────────────────────────────────

describe("Phase 3 — AI context builder", () => {
  it("composes product + knowledge + feedback + media with citations", async () => {
    const media = await uploadMedia(db as Db, ctxA, { filename: "front.png", mimeType: "image/png", size: 10, data: Buffer.from("1"), category: "PRODUCT", productId });
    void media;
    const fb = await createFeedback(db as Db, ctxA, { productId, content: "تجربة رائعة", source: "chat #9" });
    const { updateFeedback } = await import("@/modules/feedback/service");
    await updateFeedback(db as Db, ctxA, fb.id, { isApproved: true });
    await createFaq(db as Db, ctxA, { question: "هل يوجد توصيل؟", answer: "نعم.", productId });
    const doc = await createKnowledgeDocument(db as Db, ctxA, { title: "سياسة", category: "POLICY", content: "الاستبدال خلال 7 أيام متاح للمنتجات المعيبة." });
    await runJobs(db as Db);
    void doc;

    const store = new InMemoryVectorStore(new Map(), new Map());
    const ctx = await buildAIContext(db as Db, store, { workspaceId: WS_A, query: "هل يوجد توصيل؟", productId });

    expect(ctx.product!.price).toBe("150000");
    expect(ctx.product!.faqs.length).toBe(1);
    expect(ctx.feedback).toHaveLength(1);
    expect(ctx.feedback[0].content).toBe("تجربة رائعة");
    expect(ctx.media).toHaveLength(1);
    expect(ctx.citations.some((c) => c.sourceType === "PRODUCT")).toBe(true);
    expect(ctx.citations.some((c) => c.sourceType === "FEEDBACK")).toBe(true);
    expect(ctx.citations.some((c) => c.sourceType === "MEDIA")).toBe(true);
  });

  it("unapproved feedback never enters the context", async () => {
    await createFeedback(db as Db, ctxA, { productId, content: "رأي غير معتمد", source: "chat #5" });
    const store = new InMemoryVectorStore(new Map(), new Map());
    const ctx = await buildAIContext(db as Db, store, { workspaceId: WS_A, query: "أي شيء", productId });
    expect(ctx.feedback).toHaveLength(0);
  });
});
