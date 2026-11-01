/**
 * P16 — الترميز (embedding) ما بينادى عبثًا لما المخزن فاضي.
 *
 * كل اختبار هنا على قاعدة بالذاكرة ومزوّد ترميز وهمي — يثبت السلوك لا الزمن
 * الإنتاجي. الأسئلة الجاهزة (FAQ) بتضل ترجع زي ما هي بكل الحالات.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { retrieveKnowledge } from "@/modules/knowledge/retriever";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";

const embedSpy = vi.hoisted(() =>
  vi.fn(async (_text: string) => [0.1, 0.2, 0.3])
);

vi.mock("@/modules/knowledge/embeddings", () => ({
  getEmbeddingProvider: () => ({
    provider: "mock",
    model: "mock-embed",
    dimensions: 3,
    embed: embedSpy,
  }),
  getCurrentEmbeddingIdentity: () => ({ provider: "mock", model: "mock-embed", dimensions: 3 }),
}));

type Db = Prisma.TransactionClient;

const WS = "ws-p16-kb";

beforeEach(() => {
  embedSpy.mockClear();
});

describe("P16 — تخطي الترميز لما ما في أي متجه بالمخزن", () => {
  it("مخزن فاضي (size=0): لا نداء ترميز ولا بحث متجهات، والأسئلة الجاهزة ترجع", async () => {
    const db = createFakeDb();
    await db.faq.create({
      data: { workspaceId: WS, question: "شو التوصيل؟", answer: "التوصيل 24 ساعة", isActive: true },
    } as never);
    const store = new InMemoryVectorStore(new Map(), new Map());
    expect(store.size).toBe(0);
    const searchSpy = vi.spyOn(store, "search");

    const out = await retrieveKnowledge(db as unknown as Db, store, {
      workspaceId: WS,
      query: "كم وقت التوصيل؟",
    });

    expect(embedSpy).not.toHaveBeenCalled();
    expect(searchSpy).not.toHaveBeenCalled();
    expect(out.chunks).toEqual([]);
    expect(out.faqs).toHaveLength(1);
  });

  it("مخزن فيه متجهات (size>0): الترميز والبحث بيصيروا عادي", async () => {
    const db = createFakeDb();
    const store = {
      size: 2,
      search: vi.fn(async () => [
        { chunkId: "c1", documentId: "d1", content: "محتوى", score: 0.9 },
      ]),
    };

    const out = await retrieveKnowledge(db as unknown as Db, store, {
      workspaceId: WS,
      query: "شو مواصفات المنتج؟",
    });

    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(store.search).toHaveBeenCalledTimes(1);
    expect(out.chunks).toHaveLength(1);
  });

  it("مخزن ما بيعرف حجمه (size غير معرّف): لازم يبحث — ما منفترض إنه فاضي", async () => {
    const db = createFakeDb();
    const store = { search: vi.fn(async () => []) };

    await retrieveKnowledge(db as unknown as Db, store, {
      workspaceId: WS,
      query: "شو مواصفات المنتج؟",
    });

    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(store.search).toHaveBeenCalledTimes(1);
  });
});
