import { getEnv } from "@/core/env";
import { AIError } from "@/core/errors";

/**
 * Embedding provider abstraction. The stored vector dimension in Postgres is
 * vector(1536) — providers returning a different dimension are projected to
 * 1536 (truncated or zero-padded) so the schema stays stable across providers.
 * Configure EMBEDDING_DIMENSIONS to match your real provider.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

function projectTo1536(vec: number[]): number[] {
  const TARGET = 1536;
  if (vec.length === TARGET) return vec;
  if (vec.length > TARGET) return vec.slice(0, TARGET);
  return [...vec, ...new Array(TARGET - vec.length).fill(0)];
}

/** Deterministic local provider for tests/dev — no network, stable output. */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hash";
  readonly dimensions: number;

  constructor(dimensions = 1536) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
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
    return projectTo1536(vec.map((v) => v / norm));
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions: number;
  private readonly model: string;

  constructor(model = "text-embedding-3-small", dimensions = 1536) {
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const env = getEnv();
    if (!env.OPENAI_API_KEY) throw new AIError("OPENAI_API_KEY is not configured");
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      throw new AIError(`Embedding request failed with status ${res.status}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return projectTo1536(json.data[0].embedding);
  }
}

export function getEmbeddingProvider(): EmbeddingProvider {
  const env = getEnv();
  const dims = env.EMBEDDING_DIMENSIONS ? parseInt(env.EMBEDDING_DIMENSIONS, 10) : 1536;
  if (env.AI_PROVIDER === "openai" && env.OPENAI_API_KEY) {
    return new OpenAIEmbeddingProvider(env.EMBEDDING_MODEL || undefined, dims);
  }
  return new HashEmbeddingProvider(dims);
}
