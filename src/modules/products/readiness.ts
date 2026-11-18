import type { Prisma } from "@prisma/client";

/**
 * «جاهز للوكيل؟» (3.4، 03 §5.4): المنتج الجاهز = عنده وصف (قصير أو كامل) وصورة وحدة على الأقل.
 * الوكيل بيجاوب من الوصف وبيبعت الصورة، فالمنتج الناقص بيرد عنه الوكيل «ما عندي تفاصيل» أو بلا صورة.
 */
export type Missing = "description" | "image";

export const MISSING_LABELS: Record<Missing, string> = { description: "وصف", image: "صورة" };

const blank = (v: string | null | undefined) => !v || v.trim().length === 0;

export function productReadiness(p: { description?: string | null; shortDescription?: string | null; mediaLinks?: readonly unknown[] | null }): {
  ready: boolean;
  missing: Missing[];
} {
  const missing: Missing[] = [];
  if (blank(p.description) && blank(p.shortDescription)) missing.push("description");
  if (!p.mediaLinks || p.mediaLinks.length === 0) missing.push("image");
  return { ready: missing.length === 0, missing };
}

/** نفس التعريف كفلتر قاعدة بيانات («ناقصة المحتوى»): بلا صورة، أو بلا أي وصف. */
export const INCOMPLETE_WHERE: Prisma.ProductWhereInput = {
  OR: [
    { mediaLinks: { none: {} } },
    { AND: [{ OR: [{ description: null }, { description: "" }] }, { OR: [{ shortDescription: null }, { shortDescription: "" }] }] },
  ],
};
