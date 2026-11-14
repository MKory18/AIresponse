/**
 * مطابقة أسماء المنتجات بالعربي — الزبون بيكتب على سجيته.
 *
 * ⚠️ البحث كان بيدوّر على النص حرفيًا (`contains`)، فالزبون اللي بيكتب
 * «ماء الكماة» ما بيلاقي منتج اسمه «ماء الكمأ» — والرد بيطلع بلا سعر:
 * «ما عندي معلومة مؤكدة» مع إن السعر مسجّل. وأسوأ: الزبون عادة بيختصر
 * («كماة» · «الليزر» · «مكوا») وما بيكتب الاسم الكامل أبدًا.
 * 🔧 ثلاث طبقات بالترتيب: تطبيع الإملاء ← احتواء ← مطابقة بالكلمات مع
 * قبول البداية الناقصة وخطأ حرف واحد.
 *
 * ⚠️ الاسم الملتبس بيرجع بلا نتيجة عن قصد: «ماء» لحالها بتطابق «ماء الكمأ»
 * و«ماء الذهب»، وجواب بمنتج غلط (وسعر غلط) أسوأ من «شو قصدك بالضبط؟».
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

/** أقل طول لكلمة تنفع تدلّ لحالها — «ال» و«من» ما بيدلّوا على منتج. */
const MIN_TOKEN = 3;
/** كلمة طويلة بتطابق منتج واحد بس = دليل كافي مهما كان باقي الاسم طويل. */
const DISTINCTIVE_TOKEN = 4;
/** نسبة تغطية اسم المنتج اللازمة لما ما في كلمة مميِّزة. */
const MIN_COVERAGE = 0.4;

/** كلمات الاسم بعد التطبيع، بلا «ال» التعريف وبلا رموز. */
function tokensOf(text: string): string[] {
  return normalizeProductName(text)
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .split(" ")
    .map((w) => (w.length > 2 && w.startsWith("ال") ? w.slice(2) : w))
    .filter((w) => w.length >= 2);
}

/** خطأ حرف واحد (إضافة · نقص · تبديل) — غلطة كيبورد عادية. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let i = 0;
  let j = 0;
  let slack = 1;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (slack === 0) return false;
    slack -= 1;
    if (short.length === long.length) i += 1;
    j += 1;
  }
  return true;
}

/** هل كلمة الزبون بتدلّ على كلمة من اسم المنتج؟ */
function tokenHit(productToken: string, queryToken: string): boolean {
  if (productToken === queryToken) return true;
  const shorter = Math.min(productToken.length, queryToken.length);
  if (shorter >= MIN_TOKEN && (productToken.startsWith(queryToken) || queryToken.startsWith(productToken))) {
    return true;
  }
  return productToken.length >= DISTINCTIVE_TOKEN && withinOneEdit(productToken, queryToken);
}

interface Scored {
  candidate: NameCandidate;
  coverage: number;
  matchedChars: number;
  matched: string[];
}

function scoreProduct(productName: string, queryTokens: string[]): Scored | null {
  const productTokens = tokensOf(productName);
  if (productTokens.length === 0) return null;
  const total = productTokens.reduce((n, t) => n + t.length, 0);
  const matched = productTokens.filter((t) => queryTokens.some((q) => tokenHit(t, q)));
  if (matched.length === 0) return null;
  const matchedChars = matched.reduce((n, t) => n + t.length, 0);
  return { candidate: { id: "", name: productName }, coverage: matchedChars / total, matchedChars, matched };
}

/**
 * بيلاقي المنتج من كلام الزبون.
 *
 * الترتيب: مطابقة تامة ← اسم المنتج محتوى بكلام الزبون (الأطول بيفوز) ←
 * كلام الزبون محتوى باسم المنتج (إذا واحد بس) ← مطابقة بالكلمات.
 */
export function matchProductByName(query: string, products: NameCandidate[]): NameCandidate | null {
  const q = normalizeProductName(query);
  if (q.length < 2) return null;

  const normalized = products
    .map((p) => ({ p, n: normalizeProductName(p.name) }))
    .filter((x) => x.n.length > 0);
  if (normalized.length === 0) return null;

  const exact = normalized.find((x) => x.n === q);
  if (exact) return exact.p;

  const insideQuery = normalized.filter((x) => q.includes(x.n));
  if (insideQuery.length > 0) {
    return insideQuery.reduce((best, x) => (x.n.length > best.n.length ? x : best)).p;
  }

  const queryInside = normalized.filter((x) => x.n.includes(q));
  if (queryInside.length === 1) return queryInside[0].p;

  // ── مطابقة بالكلمات: «كماة» تلاقي «ماء الكمأ»، و«الليزر» تلاقي الاسم الطويل ──
  const queryTokens = tokensOf(query);
  if (queryTokens.length === 0) return null;

  const scored = normalized
    .map((x) => {
      const s = scoreProduct(x.p.name, queryTokens);
      return s ? { ...s, candidate: x.p } : null;
    })
    .filter((s): s is Scored => s !== null);
  if (scored.length === 0) return null;

  // كلمة طويلة ما بتطابق غير منتج واحد = دليل كافي لحاله.
  const tokenOwners = new Map<string, number>();
  for (const s of scored) {
    for (const t of s.matched) {
      if (t.length >= DISTINCTIVE_TOKEN) tokenOwners.set(t, (tokenOwners.get(t) ?? 0) + 1);
    }
  }
  const eligible = scored.filter(
    (s) =>
      s.coverage >= MIN_COVERAGE ||
      s.matched.some((t) => t.length >= DISTINCTIVE_TOKEN && tokenOwners.get(t) === 1)
  );
  if (eligible.length === 0) return null;

  const ranked = [...eligible].sort(
    (a, b) => b.coverage - a.coverage || b.matchedChars - a.matchedChars
  );
  // تعادل تام = ملتبس: ما منخمّن منتج وسعر.
  if (
    ranked.length > 1 &&
    ranked[0].coverage === ranked[1].coverage &&
    ranked[0].matchedChars === ranked[1].matchedChars
  ) {
    return null;
  }
  return ranked[0].candidate;
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
