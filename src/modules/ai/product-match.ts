/** Common short words that say nothing about which product is meant. */
const STOP_WORDS = new Set([
  "بدي", "بدنا", "اريد", "أريد", "سعر", "شو", "كم", "قديش", "قداش", "هل", "عندكم", "عندك", "ممكن",
  "لو", "عن", "على", "من", "في", "مع", "هذا", "هاد", "هدا", "هاي", "هذه", "كيف", "وين", "ليش",
  "شكرا", "لسا", "كمان", "تمام", "طيب", "اسمي", "رقمي", "عنواني", "قطع", "قطعة", "حبة", "عبوة",
  "the", "and", "for", "you", "price", "how", "much", "please",
]);

function normalize(word: string): string {
  const lower = word.toLowerCase().trim();
  const withoutArticle = lower.replace(/^الـ?/, "");
  return withoutArticle.length >= 2 ? withoutArticle : lower;
}

function tokens(text: string): string[] {
  return text.split(/[\s،,.!؟?\-_/()]+/).filter(Boolean);
}

/** Words from a message that could be part of a product name (at most 12). */
export function productSearchWords(text: string): string[] {
  const out: string[] = [];
  for (const word of tokens(text)) {
    if (word.length >= 3 && !STOP_WORDS.has(normalize(word)) && !STOP_WORDS.has(word.toLowerCase())) out.push(word);
    if (out.length >= 12) break;
  }
  return out;
}

const EXACT_NAME_BONUS = 1000;

/**
 * Picks the product the words point to. Whole-word matches score double a
 * partial one, and partial matches need at least 4 letters. Returns null on a
 * tie: answering about the wrong product is worse than asking which one.
 */
export function pickBestProductMatch(words: string[], products: { id: string; name: string }[]): string | null {
  const wanted = [...new Set(words.flatMap(tokens).map(normalize))];
  if (wanted.length === 0) return null;
  const phrase = wanted.join(" ");

  const scored = products
    .map((product) => {
      const nameTokens = tokens(product.name).map(normalize);
      let score = nameTokens.join(" ") === phrase ? EXACT_NAME_BONUS : 0;
      for (const word of wanted) {
        if (nameTokens.includes(word)) score += word.length * 2;
        else if (word.length >= 4 && nameTokens.some((t) => t.includes(word))) score += word.length;
      }
      return { id: product.id, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].id;
}
