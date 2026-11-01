import type { NavGroupView } from "@/lib/nav-model";

/**
 * قفز سريع للصفحات من صندوق البحث الي فوق: بتكتب «طلبات» أو «زبون» أو «باسورد» وبيطلعلك
 * الصفحة الصح — بدل ما تدوّر بالقائمة. بيشتغل على **المجموعات المسموحة للعضو بس**
 * (`visibleGroups`)، فما بيدلّك على صفحة ممنوعة عليك.
 *
 * ⚠️ قبل: الصندوق كان بيبحث بالمحادثات بس، وإذا كتبت اسم صفحة ما كان يصير شي.
 * 🔧 هلأ: اقتراحات صفحات (بالعربي الفصيح والعامي: «زباين» · «اوردر» · «بضاعة»)، والبحث
 * بالمحادثات بيضل زي ما هو (Enter بلا اختيار).
 */

/** تطبيع عربي: بلا تشكيل ولا تطويل، وألف/ياء/تاء مربوطة موحّدة، ولاتيني صغير. */
export function normalizeQuery(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * كلمات بديلة لكل صفحة (فصحى وعامي وإنجليزي) — تنكتب بحرية وتتطبّع وقت البحث.
 * ⚠️ كل صفحة بـ`NAV_GROUPS` لازم تظهر هون (`tests/nav-search.test.ts`) وإلا بتصير
 * ما بتنلاقى.
 */
export const PAGE_KEYWORDS: Record<string, string> = {
  "/dashboard": "الرئيسية لوحة التحكم احصائيات ملخص home dashboard",
  "/conversations": "الوارد رسائل شات محادثة محادثات inbox",
  "/handoffs": "تحويل تحويلات موظف تدخل بشري",
  "/customers": "عميل عملاء زبون زباين زبائن",
  "/intelligence": "مختبر التجميع جمع معلومات",
  "/orders": "طلب طلبات اوردر اوردرات شحن توصيل",
  "/products": "منتج منتجات بضاعة سلعة مخزون سعر اسعار",
  "/catalogs": "كتالوج كتالوجات صفحات",
  "/campaigns": "حملة حملات تسويق اعلان ترويج",
  "/personas": "شخصية الوكيل نبرة اسلوب لهجة",
  "/knowledge": "معرفة اسئلة شائعة مستندات faq",
  "/media": "وسائط صور فيديو ملفات",
  "/feedback": "اراء شهادات تقييم تقييمات",
  "/settings/ai": "تشغيل ضبط الذكاء مزود نموذج رد الي اوتوماتيك استوديو حالة",
  "/ai/playground": "تجربة ملعب اختبار جرب الوكيل",
  "/automation": "اتمتة قواعد تلقائي قاعدة سير عمل خطوات workflow",
  "/follow-ups": "متابعة متابعات تذكير مجدول",
  "/analytics": "تقارير تحليلات احصائيات مبيعات ارقام استهلاك تكلفة اداء المنتجات اكثر مبيعا",
  "/channels": "قناة قنوات ربط فيسبوك واتساب انستغرام تيليجرام",
  "/settings/team": "فريق موظفين اعضاء صلاحيات دعوة اعدادات مساحة العمل",
  "/settings/account": "حسابي حساب بريد كلمة المرور باسورد ثيم مظهر داكن فاتح",
};

export interface PageHit {
  href: string;
  label: string;
  groupLabel: string;
}

/** نقاط تطابق كلمة وحدة مع حقل: بداية ← احتواء ← لا شي. */
function fieldScore(field: string, token: string, startBonus: number): number {
  if (field.startsWith(token)) return startBonus;
  if (field.includes(token)) return Math.round(startBonus * 0.6);
  return 0;
}

/**
 * الصفحات المطابقة للاستعلام (كل كلمة لازم تطابق حقل: اسم الصفحة · اسم المجموعة · كلمات
 * بديلة)، مرتّبة بالأقوى ثم بترتيب القائمة. استعلام فاضي ← لا شي.
 */
export function searchPages(query: string, groups: readonly NavGroupView[], limit = 6): PageHit[] {
  const tokens = normalizeQuery(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const hits: (PageHit & { score: number; order: number })[] = [];
  let order = 0;
  for (const g of groups) {
    const groupNorm = normalizeQuery(g.label);
    for (const p of g.pages) {
      const labelNorm = normalizeQuery(p.label);
      const keyNorm = normalizeQuery(PAGE_KEYWORDS[p.href] ?? "");
      let total = 0;
      let all = true;
      for (const tok of tokens) {
        const s = Math.max(
          fieldScore(labelNorm, tok, 100),
          // كلمة بديلة بتبدأ بالاستعلام: نقاطها أقل من اسم الصفحة بس أعلى من الاحتواء.
          Math.max(...keyNorm.split(" ").map((w) => fieldScore(w, tok, 70)), 0),
          fieldScore(groupNorm, tok, 30)
        );
        if (s === 0) all = false;
        total += s;
      }
      if (all) hits.push({ href: p.href, label: p.label, groupLabel: g.label, score: total, order: order });
      order++;
    }
  }
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return hits.slice(0, limit).map(({ href, label, groupLabel }) => ({ href, label, groupLabel }));
}
