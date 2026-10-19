import { getEnv } from "@/core/env";
import { AIError } from "@/core/errors";
import { normalizeOpenAiEmbeddingsEndpoint } from "@/modules/ai/provider";

/**
 * Embedding provider abstraction. Each provider must declare its exact
 * model identity and output dimensions. The database schema uses vector(1536)
 * — providers MUST match this dimension. Dimension mismatch is a configuration
 * error, not something to silently truncate or pad.
 */
export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

const SCHEMA_DIMENSIONS = 1536;

/**
 * قرار مالك صريح (OCR-2026-10-16 #4): الترميز الخارجي يعني مرور نصوص فيها
 * كلام زبائن نحو api.openai.com. الافتراضي مرفوض (إغلاق كامل) — فتحه لا
 * يكون إلا بيئة صريحة AI_ALLOW_EXTERNAL_EMBEDDINGS=1 من مالك المنصة.
 */
export function externalEmbeddingAllowed(): boolean {
  return ["1", "true", "yes"].includes((process.env.AI_ALLOW_EXTERNAL_EMBEDDINGS ?? "").toLowerCase());
}/** Deterministic local provider for tests/dev — no network, stable output. */
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
        `HashEmbeddingProvider dimensions (${this.dimensions}) must match schema vector dimensions (${SCHEMA_DIMENSIONS}). ` +
        `Configure EMBEDDING_DIMENSIONS=${SCHEMA_DIMENSIONS} or use a provider with matching output dimensions.`
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

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "openai";
  readonly model: string;
  readonly dimensions: number;
  /** بوابة مخصصة للاندماجات (OPENAI_BASE_URL)؛ بلاها = OpenAI الرسمي. */
  private readonly baseUrl: string;

  constructor(model = "text-embedding-3-small", dimensions = 1536, customBaseUrl?: string) {
    this.model = model;
    this.dimensions = dimensions;
    if (customBaseUrl) {
      const endpoint = normalizeOpenAiEmbeddingsEndpoint(customBaseUrl);
      if (!endpoint) {
        throw new AIError(
          `OPENAI_BASE_URL "${customBaseUrl.slice(0, 32)}" is not a valid http(s) endpoint for embeddings`
        );
      }
      this.baseUrl = endpoint;
    } else {
      this.baseUrl = "https://api.openai.com/v1/embeddings";
    }
  }

  async embed(text: string): Promise<number[]> {
    if (this.dimensions !== SCHEMA_DIMENSIONS) {
      throw new AIError(
        `OpenAIEmbeddingProvider model "${this.model}" produces ${this.dimensions} dimensions ` +
        `but schema expects ${SCHEMA_DIMENSIONS}. ` +
        `Use a model with matching dimensions (e.g., text-embedding-3-small for 1536) ` +
        `or migrate the database schema to the new dimension.`
      );
    }
    if (!externalEmbeddingAllowed()) {
      throw new AIError(
        "EXTERNAL_EMBEDDING_DISABLED: مرور نصوص زبائن إلى api.openai.com مرفوض افتراضيًا — " +
          "فعّله صراحة بـ AI_ALLOW_EXTERNAL_EMBEDDINGS=1 بعد قرار الخصوصية."
      );
    }
    const env = getEnv();
    if (!env.OPENAI_API_KEY) throw new AIError("OPENAI_API_KEY is not configured");
    // P1 privacy: RAG queries carry raw customer turns and KB chunks may
    // carry contact details — strip phone/email shapes before the external
    // call. Applied here (single choke point) so index-time and query-time
    // vectors stay consistent with each other.
    const { scrubForEmbedding } = await import("@/modules/ai/privacy-gate");
    const safeInput = scrubForEmbedding(text);
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: this.model, input: safeInput }),
    });
    if (!res.ok) {
      throw new AIError(`Embedding request failed with status ${res.status}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    const embedding = json.data[0].embedding;
    if (embedding.length !== SCHEMA_DIMENSIONS) {
      throw new AIError(
        `OpenAI embedding returned ${embedding.length} dimensions but schema expects ${SCHEMA_DIMENSIONS}. ` +
        `Model "${this.model}" may have changed output dimensions.`
      );
    }
    return embedding;
  }
}

export function getEmbeddingProvider(): EmbeddingProvider {
  const env = getEnv();
  const dims = env.EMBEDDING_DIMENSIONS ? parseInt(env.EMBEDDING_DIMENSIONS, 10) : SCHEMA_DIMENSIONS;
  if (env.AI_PROVIDER === "openai" && env.OPENAI_API_KEY) {
    return new OpenAIEmbeddingProvider(
      env.EMBEDDING_MODEL ?? "text-embedding-3-small",
      dims,
      env.OPENAI_BASE_URL
    );
  }
  return new HashEmbeddingProvider(dims);
}

export function getCurrentEmbeddingIdentity(): { provider: string; model: string; dimensions: number } {
  const provider = getEmbeddingProvider();
  return { provider: provider.provider, model: provider.model, dimensions: provider.dimensions };
}
