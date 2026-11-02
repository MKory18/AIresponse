import { describe, expect, it } from "vitest";
import { HashEmbeddingProvider } from "@/modules/knowledge/embeddings";

function cosine(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * P24 — honest quality check of the local lexical embedding.
 * It is NOT a semantic embedding; this test documents what it can/can't do.
 */
describe("HashEmbeddingProvider — Arabic lexical coverage", () => {
  const p = new HashEmbeddingProvider();

  it("same sentence is identical", async () => {
    const a = await p.embed("بدي ماء الكمأة الأصلي");
    const b = await p.embed("بدي ماء الكمأة الأصلي");
    expect(cosine(a, b)).toBeCloseTo(1, 6);
  });

  it("spelling variants (همزات/ة/ى/تشكيل) stay highly similar", async () => {
    const a = await p.embed("ماء الكمأة الأصلي");
    const b = await p.embed("ماء الكماة الاصلي");
    expect(cosine(a, b)).toBeGreaterThan(0.9);
  });

  it("word order changes are still similar (bag of words)", async () => {
    const a = await p.embed("سعر ماء الكمأة");
    const b = await p.embed("ماء الكمأة سعر");
    expect(cosine(a, b)).toBeGreaterThan(0.99);
  });

  it("synonyms are NOT semantic (documented limitation)", async () => {
    const a = await p.embed("عطر");
    const b = await p.embed("پرفان");
    expect(cosine(a, b)).toBeLessThan(0.5);
  });
});
