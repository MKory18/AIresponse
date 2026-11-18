/**
 * الصفحات القانونية العلنية (سياسة الخصوصية · الشروط · حذف البيانات).
 *
 * ⚠️ ميتا بتطلب رابط سياسة خصوصية علني ورابط تعليمات حذف قبل ما توافق على صلاحيات المراسلة، وما كان
 * للمنصة ولا واحد منهم. وأخطر من غيابهم: صفحة بتحكي شي مش حقيقي (مدة احتفاظ غلط · وعد حذف ما بينفّذ).
 * 🔧 الاختبار بيربط الأرقام المكتوبة بالصفحة بالقيم الفعلية بالكود، وبيتأكد إنه النسختين (عربي · إنجليزي)
 * ما اختلفوا، وإنه الصفحات علنية (خارج `(dashboard)`) وبتقرا بريد التواصل من البيئة وقت الطلب.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LegalPage } from "@/components/legal/legal-page";
import {
  DELETION,
  DELETION_DAYS,
  PRIVACY,
  TERMS,
  getContactEmail,
  type LegalPageContent,
} from "@/modules/legal/content";
import { DEFAULT_RETENTION_DAYS } from "@/modules/channels/webhook-retention";

const ROOT = process.cwd();
const PAGES = [
  { path: "privacy", content: PRIVACY },
  { path: "terms", content: TERMS },
  { path: "data-deletion", content: DELETION },
] as const;

describe("بريد التواصل من البيئة", () => {
  it("عنوان صالح بيرجع، والفراغات بتنشال", () => {
    expect(getContactEmail({ LEGAL_CONTACT_EMAIL: "  privacy@example.com " })).toBe("privacy@example.com");
  });

  it("ناقص أو غلط = null (ما بنخترع عنوان)", () => {
    expect(getContactEmail({})).toBeNull();
    expect(getContactEmail({ LEGAL_CONTACT_EMAIL: "   " })).toBeNull();
    expect(getContactEmail({ LEGAL_CONTACT_EMAIL: "not-an-email" })).toBeNull();
    expect(getContactEmail({ LEGAL_CONTACT_EMAIL: "a b@example.com" })).toBeNull();
  });
});

describe("النسختين عربي · إنجليزي بيتطابقوا بالهيكل", () => {
  for (const { path, content } of PAGES) {
    it(`${path}: نفس عدد الأقسام والبنود`, () => {
      expect(content.ar.sections).toHaveLength(content.en.sections.length);
      content.ar.sections.forEach((s, i) => {
        const e = content.en.sections[i];
        expect(s.items?.length ?? 0).toBe(e.items?.length ?? 0);
        expect(s.paragraphs?.length ?? 0).toBe(e.paragraphs?.length ?? 0);
      });
    });
  }
});

describe("الأرقام المكتوبة = القيم الفعلية", () => {
  const privacyText = JSON.stringify(PRIVACY);
  const deletionText = JSON.stringify(DELETION);

  it("مدة حمولة الأحداث الخام = ثابت التنظيف بالكود", () => {
    // ⚠️ لو تغيّر الافتراضي بالكود والصفحة بقيت 30، السياسة بتصير غلط.
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
    expect(privacyText).toContain("30 يومًا");
    expect(privacyText).toContain("30 days");
    expect(deletionText).toContain("30 يومًا");
    expect(deletionText).toContain("30 days");
  });

  it("مدة معالجة طلب الحذف مذكورة بالسياسة وبصفحة الحذف", () => {
    expect(DELETION_DAYS).toBe(30);
    expect(privacyText).toContain(`${DELETION_DAYS} يومًا`);
    expect(deletionText).toContain(`${DELETION_DAYS} يومًا`);
    expect(deletionText).toContain(`${DELETION_DAYS} days`);
  });

  it("السياسة بتحيل لصفحة الحذف، وبتذكر حماية بيانات الزبون قبل أي نموذج خارجي", () => {
    expect(privacyText).toContain("/data-deletion");
    expect(privacyText).toMatch(/رموز مؤقتة/);
    expect(privacyText).toMatch(/placeholders/);
  });

  it("ما في وعد ببيع بيانات أو إعلانات", () => {
    expect(privacyText).toMatch(/لا نبيع البيانات/);
    expect(privacyText).toMatch(/do not sell data/);
  });
});

describe("الصفحات علنية وبتتقرا وقت الطلب", () => {
  for (const { path } of PAGES) {
    const file = join(ROOT, "src/app/(public)", path, "page.tsx");

    it(`${path}: موجودة خارج (dashboard) فما في حارس تسجيل دخول`, () => {
      expect(existsSync(file)).toBe(true);
      expect(file).not.toContain("(dashboard)");
    });

    it(`${path}: force-dynamic وindex مفتوح`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).toMatch(/export const dynamic = "force-dynamic"/);
      // الجذر `noindex` — الصفحات القانونية لازم تتفتح.
      expect(src).toMatch(/index: true/);
    });
  }
});

describe("الرسم", () => {
  const render = (content: LegalPageContent, email?: string) => {
    const before = process.env.LEGAL_CONTACT_EMAIL;
    if (email === undefined) delete process.env.LEGAL_CONTACT_EMAIL;
    else process.env.LEGAL_CONTACT_EMAIL = email;
    try {
      return renderToStaticMarkup(createElement(LegalPage, { content }));
    } finally {
      if (before === undefined) delete process.env.LEGAL_CONTACT_EMAIL;
      else process.env.LEGAL_CONTACT_EMAIL = before;
    }
  };

  it("بريد مضبوط = رابط mailto بالنسختين", () => {
    const html = render(DELETION, "privacy@example.com");
    expect(html.match(/mailto:privacy@example\.com/g)).toHaveLength(2);
  });

  it("بريد ناقص = بتقول إنه ناقص (مش بتخترع عنوان)", () => {
    const html = render(DELETION);
    expect(html).not.toContain("mailto:");
    expect(html).toContain("غير مضبوط");
    expect(html).toContain("has not been configured");
  });

  it("عربي RTL وإنجليزي LTR بنفس الصفحة", () => {
    const html = render(PRIVACY, "privacy@example.com");
    expect(html).toContain('lang="ar" dir="rtl"');
    expect(html).toContain('lang="en" dir="ltr"');
    expect(html).toContain("سياسة الخصوصية");
    expect(html).toContain("Privacy Policy");
  });

  it("روابط التنقل للصفحات التلاتة", () => {
    const html = render(PRIVACY, "privacy@example.com");
    for (const p of ["/privacy", "/terms", "/data-deletion"]) expect(html).toContain(`href="${p}"`);
  });
});
