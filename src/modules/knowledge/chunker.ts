export interface Chunk {
  content: string;
  chunkIndex: number;
  tokenCount: number;
  metadata: Record<string, unknown>;
}

const MAX_CHUNK_CHARS = 800;
const OVERLAP_CHARS = 120;

/** Rough token estimate (~1.3 tokens per word for mixed AR/EN text). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

/**
 * Deterministic chunking: split on blank lines (paragraphs), merge small
 * paragraphs up to MAX_CHUNK_CHARS, hard-split oversized paragraphs, with
 * character overlap between consecutive chunks.
 */
export function chunkText(
  text: string,
  metadata: Record<string, unknown> = {}
): Chunk[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= MAX_CHUNK_CHARS) {
      pieces.push(paragraph);
      continue;
    }
    // Hard-split long paragraph on sentence boundaries.
    const sentences = paragraph.split(/(?<=[.!?؟۔])\s+/);
    let current = "";
    for (const sentence of sentences) {
      if ((current + " " + sentence).trim().length > MAX_CHUNK_CHARS && current) {
        pieces.push(current.trim());
        current = sentence;
      } else {
        current = (current + " " + sentence).trim();
      }
    }
    if (current) pieces.push(current.trim());
  }

  // Merge adjacent small pieces.
  const merged: string[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.length + piece.length + 1 <= MAX_CHUNK_CHARS) {
      merged[merged.length - 1] = `${last}\n${piece}`;
    } else {
      merged.push(piece);
    }
  }

  // Add overlap to all but the first chunk.
  const chunks: Chunk[] = merged.map((content, i) => {
    const withOverlap =
      i > 0 ? `${merged[i - 1].slice(-OVERLAP_CHARS)}\n${content}` : content;
    return {
      content: withOverlap.trim(),
      chunkIndex: i,
      tokenCount: estimateTokens(withOverlap),
      metadata,
    };
  });

  return chunks;
}
