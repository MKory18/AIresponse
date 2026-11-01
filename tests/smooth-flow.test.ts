import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * «الخطوة بتودّي للتانية» — ولا زر بيوصّل لطريق مسدود.
 *
 * كل حالة هون كانت نهاية مسدودة فعلية (مفحوصة بالمتصفح والكود):
 * ⚠️ معاينة الشخصية بتنادي مسار متقاعد (٤١٠) فبتفشل دايمًا · «فتح المحادثة» بالتحويلات
 * بيفتح الوارد العام مش المحادثة · بطاقات العملاء بالجوال ما بتنضغط · طلبات العميل
 * بالمحادثة نص مش رابط · صفحة الطلب ما فيها طريق للمحادثة وتسمياتها إنجليزي · الحملات
 * ما فيها ولا طريقة لإنشاء شريحة فما بتقدر تعمل ولا حملة · «الفريق» بقائمة الحساب
 * بتظهر لكل عضو وبتعطيه ٤٠٣.
 * 🔧 كل وحدة صار إلها طريق للخطوة الجاية — والاختبار بيمنع رجوعها.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const page = (p: string) => read(`src/app/(dashboard)/${p}`);
/** الكود بلا تعليقات — حتى ما يعدّي اختبار على كلمة بتعليق. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

describe("الشخصية ← التجربة", () => {
  it("ولا نداء للمسار المتقاعد /api/ai/playground (بيرجّع ٤١٠ دايمًا)", () => {
    expect(code(page("personas/page.tsx"))).not.toMatch(/fetch\(\s*["'`]\/api\/ai\/playground["'`]/);
  });

  it("كل شخصية فيها «جرّبها» بتفتح التجربة عليها", () => {
    expect(page("personas/page.tsx")).toContain("/ai/playground?persona=");
  });

  it("التجربة بتقرأ الشخصية من الرابط", () => {
    expect(code(page("ai/playground/page.tsx"))).toMatch(/get\(\s*["']persona["']\s*\)/);
  });
});

describe("التحويلات والعملاء ← المحادثة نفسها", () => {
  it("«فتح المحادثة» بيحمل معرّف المحادثة", () => {
    const src = code(page("handoffs/page.tsx"));
    expect(src).toContain("/conversations?id=");
    expect(src).not.toMatch(/href=\{`\/conversations`\}/);
  });

  it("الوارد بيفتح المحادثة من ?id=", () => {
    expect(code(read("src/components/inbox/inbox.tsx"))).toMatch(/get\(\s*["']id["']\s*\)/);
  });

  it("بطاقة العميل بالجوال رابط كمان (مش بس الجدول)", () => {
    const src = code(page("customers/page.tsx"));
    const mobile = src.slice(src.indexOf("md:hidden"));
    expect(mobile).toContain("<Link");
  });

  it("طلبات العميل بلوحة المحادثة روابط للطلب", () => {
    expect(code(read("src/components/inbox/customer-panel.tsx"))).toContain("href={`/orders/${o.id}`}");
  });
});

describe("صفحة الطلب", () => {
  it("بلا تسميات إنجليزي بالمجموع", () => {
    const src = code(page("orders/[id]/page.tsx"));
    for (const w of [">Subtotal<", ">Discount<", ">Delivery<", ">Total<"]) expect(src).not.toContain(w);
  });

  it("فيها طريق للمحادثة ورجوع للطلبات", () => {
    const src = code(page("orders/[id]/page.tsx"));
    expect(src).toContain("/conversations?id=");
    expect(src).toMatch(/href="\/orders"/);
  });
});

describe("الحملات: شريحة ← حملة", () => {
  it("في زر إنشاء شريحة بيبعت لـ POST /api/segments", () => {
    const dialog = read("src/app/(dashboard)/campaigns/segment-dialog.tsx");
    expect(dialog).toContain('fetch("/api/segments"');
    expect(dialog).toContain('method: "POST"');
    expect(page("campaigns/page.tsx")).toContain("SegmentDialog");
  });

  it("ولا نص بيحوّل على «واجهة الشرائح» الي مش موجودة", () => {
    expect(page("campaigns/page.tsx")).not.toContain("عبر واجهة الشرائح");
  });
});

describe("قائمة الحساب", () => {
  it("«الفريق» بتظهر بس لمين بيقدر يفتحها", () => {
    const shell = code(read("src/components/app-shell.tsx"));
    expect(shell).toMatch(/canTeam\s*&&/);
  });
});

describe("خيارات الشريحة الجاهزة", () => {
  it("كل خيار شرط صالح بمخطط الخادم — وأي توليفة مسموحة بتنحفظ", async () => {
    const { SEGMENT_PRESETS } = await import("@/app/(dashboard)/campaigns/segment-dialog");
    const { segmentCreateSchema } = await import("@/modules/campaigns/segment-schemas");
    for (const p of SEGMENT_PRESETS) {
      const r = segmentCreateSchema.safeParse({ name: p.label, definition: { version: 1, match: "ALL", conditions: [p.condition] } });
      expect(r.success, p.key).toBe(true);
    }
    const all = SEGMENT_PRESETS.map((p) => p.condition);
    expect(segmentCreateSchema.safeParse({ name: "كل", definition: { version: 1, match: "ALL", conditions: all } }).success).toBe(true);
  });
});
