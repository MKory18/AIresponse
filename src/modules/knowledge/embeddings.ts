import { AIError } from "@/core/errors";

/**
 * Embedding provider for knowledge retrieval.
 *
 * OpenRouter is the only external AI provider and does not expose embeddings,
 * so vectors are produced locally and deterministically (no customer text
 * leaves the process). The schema expects 1536 dimensions.
 */
export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

const SCHEMA_DIMENSIONS = 1536;

/** Deterministic local provider — no network, stable output. */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "hash";
  readonly model: string;
  readonly dimensions: number;

  constructor(dimensions = SCHEMA_DIMENSIONS) {
    this.dimensions = dimensions;
    this.model = `hash-${dimensions}`;
  }

  async embed(text: string): Promise<number[]> {
    if (this.dimensions !== SCHEMA_DIMENSIONS) {
      throw new AIError(
        `HashEmbeddingProvider dimensions (${this.dimensions}) must match schema vector dimensions (${SCHEMA_DIMENSIONS}).`
      );
    }
    const dim = this.dimensions;
    const vec = new Array<number>(dim).fill(0);
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      let h = 2166136261;
      for (let i = 0; i < token.length; i++) {
        h ^= token.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      vec[Math.abs(h) % dim] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

export function getEmbeddingProvider(): EmbeddingProvider {
  const dims = process.env.EMBEDDING_DIMENSIONS
    ? parseInt(process.env.EMBEDDING_DIMENSIONS, 10)
    : SCHEMA_DIMENSIONS;
  return new HashEmbeddingProvider(dims);
}

export function getCurrentEmbeddingIdentity(): { provider: string; model: string; dimensions: number } {
  const provider = getEmbeddingProvider();
  return { provider: provider.provider, model: provider.model, dimensions: provider.dimensions };
}
