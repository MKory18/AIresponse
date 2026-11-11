import type { Db } from "@/modules/customers/service";
import { normalizeMediaArabic } from "@/modules/media/request";
import { productSearchWords } from "@/modules/ai/product-match";

/**
 * P18 — حدود الكتالوج في الرد.
 *
 * الصفحة المربوطة بكتالوج مسموح لها بمنتجات هذا الكتالوج فقط. حتى لا «يتذكّر»
 * الذكاء منتجًا حُذف من الكتالوج (من محادثة سابقة أو معرفة عامة أو ذاكرة
 * زبون):
 *  - تُحقن حدود صريحة في تعليمات الرد: قائمة أسماء المنتجات المتاحة.
 *  - ويُشال ذكر المنتجات الخارجة عن الكتالوج من الذاكرة والملخص وسجل المحادثة
 *    قبل ما توصل للموديل. الفلترة عند بناء البرومبت فقط — المخزّن ما بيتغيّر.
 */
const MAX_NAMES = 150;
const MAX_NAME_CHARS = 5000;

export function buildCatalogBoundary(names: string[]): string {
  const available = names.map((name) => name.trim()).filter(Boolean);

  if (available.length === 0) {
    return [
      "حدود الكتالوج: لا توجد أي منتجات متاحة لهذه الصفحة حاليًا.",
      "لا تذكر أي منتج أو سعر أو توفر أو تفاصيل منتج إطلاقًا، واعتذر بلطف واقترح التواصل مع الفريق.",
    ].join(" ");
  }

  const listed: string[] = [];
  let chars = 0;
  for (const name of available) {
    if (listed.length >= MAX_NAMES || chars + name.length > MAX_NAME_CHARS) break;
    listed.push(name);
    chars += name.length;
  }

  // قائمة مقصوصة: ممنوع نعتبر الغايب عنها غير متوفر — ممكن يكون منتج شغّال.
  if (listed.length < available.length) {
    return [
      `حدود الكتالوج: من منتجات هذه الصفحة (القائمة جزئية وليست كاملة): ${listed.join("، ")}.`,
      "إذا سأل العميل عن منتج غير مذكور هنا: لا تجزم بشيء عنه، ولا تذكر سعره أو تفاصيله إلا إذا ظهر في (بيانات المنتج)، واطلب منه توضيح اسم المنتج.",
    ].join(" ");
  }

  return [
    `حدود الكتالوج: المنتجات المتاحة لهذه الصفحة فقط هي: ${listed.join("، ")}.`,
    "أي منتج آخر غير موجود في هذه القائمة غير متاح — حتى لو ذُكر في المحادثة أو المعرفة أو ذاكرة الزبون:",
    "لا تذكر سعره أو توفره أو تفاصيله، وقل إنه غير متوفر حاليًا.",
  ].join(" ");
}

// ── حارس التذكّر: المنتجات خارج كتالوج الصفحة ما بتوصل نص الموديل ───────────

const MIN_NAME_CHARS = 3;
const MAX_OUTSIDE_NAMES = 5000;
// بعد التطبيع (ة → ه): أسماء عامة ما بتحدد منتج بعينه.
const GENERIC_NAMES = new Set(["منتج", "منتجات", "عرض", "عروض", "هديه", "باقه", "طلب", "خدمه", "سعر", "قطعه", "حبه", "عبوه", "علبه", "product"]);

interface BlockedName {
  core: string;
  pattern: RegExp;
  /** أسماء منتجات مسموحة بتحتوي هالاسم: ذكرها مش ذكر للمنتج المحذوف. */
  shieldedBy: string[];
}

export interface RecallGuard {
  /** أسماء منتجات الصفحة النشطة (بترتيب ربطها بالكتالوج) — لنص حدود الكتالوج. */
  allowedNames: string[];
  blocked: BlockedName[];
}

function normalizeForRecall(text: string): string {
  return normalizeMediaArabic(text)
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGenericName(core: string): boolean {
  if (core.length < MIN_NAME_CHARS) return true;
  const words = core.split(" ");
  if (words.every((word) => GENERIC_NAMES.has(word))) return true;
  // كل كلماته كلمات عامة أو قصيرة («50 مل» · «عبوة»): ما بتحدد منتج.
  return productSearchWords(core).length === 0;
}

/** حارس من قوائم أسماء جاهزة (بلا قاعدة بيانات). */
export function createRecallGuard(params: { outsideNames: string[]; allowedNames: string[] }): RecallGuard {
  const allowedNormalized = [...new Set(params.allowedNames.map(normalizeForRecall).filter(Boolean))];
  const allowedSet = new Set(allowedNormalized);
  const seen = new Set<string>();
  const blocked: BlockedName[] = [];
  for (const raw of params.outsideNames) {
    const name = normalizeForRecall(raw);
    // نفس اسم منتج مسموح (منتجين بنفس الاسم): الذكر لهون سليم.
    if (!name || allowedSet.has(name)) continue;
    const core = name.replace(/^ال/, "");
    if (seen.has(core) || isGenericName(core)) continue;
    seen.add(core);
    blocked.push({
      core,
      // حدود كلمة + أدوات الوصل العربية: «بالعسل» بتطابق و«معسل» لأ.
      pattern: new RegExp(
        `(?<![\\p{L}\\p{N}])[وفبلك]{0,2}(?:ال)?${escapeForRegex(core)}(?![\\p{L}\\p{N}])`,
        "u"
      ),
      shieldedBy: allowedNormalized.filter((allowed) => allowed.includes(core)),
    });
  }
  return { allowedNames: params.allowedNames, blocked };
}

/**
 * يقرأ أسماء منتجات المساحة خارج المجموعة المسموحة. undefined = ما في
 * كتالوجات بالمساحة (السلوك القديم) → null ولا فلترة.
 */
export async function loadRecallGuard(
  db: Db,
  workspaceId: string,
  allowedProductIds: string[] | undefined
): Promise<RecallGuard | null> {
  if (allowedProductIds === undefined) return null;
  const [allowedRows, outsideRows] = await Promise.all([
    allowedProductIds.length > 0
      ? (db.product.findMany({
          where: { workspaceId, id: { in: allowedProductIds }, isActive: true, isArchived: false },
          select: { id: true, name: true },
        }) as Promise<{ id: string; name: string }[]>)
      : Promise.resolve([] as { id: string; name: string }[]),
    db.product.findMany({
      where: { workspaceId, id: { notIn: allowedProductIds } },
      orderBy: { updatedAt: "desc" },
      take: MAX_OUTSIDE_NAMES,
      select: { name: true },
    }) as Promise<{ name: string }[]>,
  ]);
  const position = new Map(allowedProductIds.map((id, index) => [id, index]));
  const ordered = [...allowedRows].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  return createRecallGuard({
    allowedNames: ordered.map((row) => row.name),
    outsideNames: outsideRows.map((row) => row.name),
  });
}

function mentionsBlocked(guard: RecallGuard, text: string): boolean {
  const normalized = normalizeForRecall(text);
  for (const name of guard.blocked) {
    if (!normalized.includes(name.core)) continue;
    let haystack = normalized;
    for (const allowed of name.shieldedBy) haystack = haystack.split(allowed).join(" ");
    if (name.pattern.test(haystack)) return true;
  }
  return false;
}

/**
 * يشيل الأسطر/الجمل اللي بتذكر منتج خارج الكتالوج، والباقي بيضل حرفيًا.
 * الناتج "" = ما ضل شي. بلا حارس = نفس النص.
 */
export function scrubRecalledText(guard: RecallGuard | null | undefined, text: string): string;
export function scrubRecalledText(guard: RecallGuard | null | undefined, text: string | null | undefined): string | null;
export function scrubRecalledText(guard: RecallGuard | null | undefined, text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  if (!guard || guard.blocked.length === 0 || !mentionsBlocked(guard, text)) return text;
  return text
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[.!؟?؛;…])\s+/)
        .filter((sentence) => !mentionsBlocked(guard, sentence))
        .join(" ")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
}

/** يشيل رسائل السجل كاملة إذا ذكرت منتج خارج الكتالوج — الرسالة الحالية بتضل. */
export function scrubRecalledHistory<T extends { id?: string; text: string | null }>(
  guard: RecallGuard | null | undefined,
  messages: T[],
  currentMessageId?: string
): T[] {
  if (!guard || guard.blocked.length === 0) return messages;
  return messages.filter((m) => m.id === currentMessageId || !m.text || !mentionsBlocked(guard, m.text));
}
