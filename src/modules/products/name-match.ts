/**
 * مطابقة أسماء المنتجات بالعربي.
 *
 * ⚠️ البحث كان بيدوّر على النص حرفيًا (`contains`)، فالزبون اللي بيكتب
 * «ماء الكماة» ما بيلاقي منتج اسمه «ماء الكمأ» — والنتيجة إن الرد بيطلع
 * بلا سعر: «ما عندي معلومة مؤكدة» مع إن السعر مسجّل.
 * 🔧 التطبيع بيوحّد الهمزات والتاء المربوطة والألف المقصورة والتشكيل،
 * وبعدها المطابقة بتقبل الاحتواء بالاتجاهين — بس بشرط ما تكون ملتبسة.
 *
 * نفس التطبيع المستعمل بمزامنة منتجات الـ OMS — دالة وحدة للاتنين.
 */

/** توحيد الإملاء العربي قبل أي مقارنة. */
export function normalizeProductName(text: string): string {
  return text
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** نفس المنتج بالاسم؟ (مطابقة تامة بعد التطبيع) */
export function sameProductName(a: string, b: string): boolean {
  const left = normalizeProductName(a);
  return left.length > 0 && left === normalizeProductName(b);
}

export interface NameCandidate {
  id: string;
  name: string;
}

/**
 * بيلاقي المنتج من كلام الزبون بعد التطبيع.
 *
 * الترتيب: مطابقة تامة ← اسم المنتج محتوى بكلام الزبون (الأطول بيفوز) ←
 * كلام الزبون محتوى باسم المنتج، وهاي بس إذا منتج واحد بيطابق: «ماء» لحالها
 * بتلاقي «ماء الكمأ» و«ماء الذهب»، وجواب بمنتج غلط أسوأ من «ما لقيت».
 */
export function matchProductByName(query: string, products: NameCandidate[]): NameCandidate | null {
  const q = normalizeProductName(query);
  if (q.length < 2) return null;

  const normalized = products
    .map((p) => ({ p, n: normalizeProductName(p.name) }))
    .filter((x) => x.n.length > 0);

  const exact = normalized.find((x) => x.n === q);
  if (exact) return exact.p;

  const insideQuery = normalized.filter((x) => q.includes(x.n));
  if (insideQuery.length > 0) {
    return insideQuery.reduce((best, x) => (x.n.length > best.n.length ? x : best)).p;
  }

  const queryInside = normalized.filter((x) => x.n.includes(q));
  if (queryInside.length === 1) return queryInside[0].p;

  return null;
}

/** أول منتج بيطابق أي واحد من المرشّحين (بترتيبهم). */
export function matchProductByAnyName(
  queries: string[],
  products: NameCandidate[]
): NameCandidate | null {
  for (const q of queries) {
    const hit = matchProductByName(q, products);
    if (hit) return hit;
  }
  return null;
}
