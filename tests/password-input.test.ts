import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PasswordInput, passwordToggle, type PasswordInputProps } from "@/components/ui/password-input";

/**
 * زر العين على كل حقل سري: المنطق (النوع + نص الزر) والشكل الأولي، وحارس إنه ما حدا
 * يرجّع `type="password"` خام بأي مكان. التبديل بالضغطة نفسه بيتفحص بالمتصفح —
 * هون بيئة node بلا DOM.
 */

const render = (props: PasswordInputProps = {}) =>
  renderToStaticMarkup(createElement(PasswordInput, { name: "password", ...props }));

describe("passwordToggle", () => {
  it("مخفي ← النوع password والزر بيقول «إظهار»", () => {
    expect(passwordToggle(false)).toEqual({ type: "password", label: "إظهار كلمة المرور" });
  });

  it("ظاهر ← النوع text والزر بيقول «إخفاء»", () => {
    expect(passwordToggle(true)).toEqual({ type: "text", label: "إخفاء كلمة المرور" });
  });

  it("المفاتيح والتوكنات: «القيمة» مش «كلمة المرور»", () => {
    expect(passwordToggle(false, "secret").label).toBe("إظهار القيمة");
    expect(passwordToggle(true, "secret").label).toBe("إخفاء القيمة");
  });
});

describe("PasswordInput", () => {
  it("بيبدأ مخفي، وزره type=button (ما بيرسل الفورم) باسم واضح", () => {
    const out = render();
    expect(out).toContain('type="password"');
    expect(out).toMatch(/<button[^>]*type="button"/);
    expect(out).toContain('aria-label="إظهار كلمة المرور"');
    expect(out).toContain('title="إظهار كلمة المرور"');
  });

  it("الحقل قبل الزر بالـDOM: الـlabel بيربط الحقل مش الزر", () => {
    const out = render();
    expect(out.indexOf("<input")).toBeGreaterThan(-1);
    expect(out.indexOf("<input")).toBeLessThan(out.indexOf("<button"));
  });

  it("kind=secret بيغيّر نص الزر", () => {
    expect(render({ kind: "secret" })).toContain('aria-label="إظهار القيمة"');
  });

  it("الخصائص بتمرّ للحقل (اسم · مطلوب · الإكمال التلقائي · الحد الأدنى · الشكل)", () => {
    const out = render({ required: true, autoComplete: "new-password", minLength: 8, placeholder: "كلمة المرور", className: "h-10 num" });
    expect(out).toContain('name="password"');
    expect(out).toContain('required=""');
    expect(out).toContain('autoComplete="new-password"');
    expect(out).toContain('minLength="8"');
    expect(out).toContain('placeholder="كلمة المرور"');
    expect(out).toContain("h-10");
    expect(out).toContain("num");
  });

  it("مكان العين: بنهاية الحقل (end) وبحشو للنص، وإيدج ما بيرسم عينه", () => {
    const out = render();
    expect(out).toContain("pe-10");
    expect(out).toContain("end-1");
    expect(out).toContain("-ms-reveal");
  });

  it("`dir` بيروح للحقل وللغلاف (العين تتبع اتجاه الحقل)", () => {
    expect(render({ dir: "ltr" }).match(/dir="ltr"/g)).toHaveLength(2);
    expect(render()).not.toContain("dir=");
  });

  it("المستدعي ما بيقدر يفرض type=text (الزر هو المتحكّم)", () => {
    const out = renderToStaticMarkup(createElement(PasswordInput, { type: "text" } as unknown as PasswordInputProps));
    expect(out).toContain('type="password"');
  });
});

describe("كل حقل سري بالموقع بزر عين", () => {
  const OWN = ["components", "ui", "password-input.tsx"].join(sep);
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /[.]tsx?$/.test(n) ? [p] : [];
    });

  it('ما حدا بيكتب type="password" خام غير المكوّن نفسه', () => {
    const offenders = files(join(process.cwd(), "src"))
      .filter((f) => !f.endsWith(OWN))
      .filter((f) => /type\s*[=:]\s*[{]?\s*["']password["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(process.cwd(), f).split(sep).join("/"));
    expect(offenders, `استعمل PasswordInput بدل type=password: ${offenders.join(" · ")}`).toEqual([]);
  });

  it("الكاشف بيمسك الأشكال الخام (حتى ما يصير الحارس فاضي)", () => {
    const bad = /type\s*[=:]\s*[{]?\s*["']password["']/;
    expect(bad.test('<Input name="x" type="password" />')).toBe(true);
    expect(bad.test("<input type={'password'} />")).toBe(true);
    expect(bad.test('createField({ type: "password" })')).toBe(true);
    expect(bad.test('<PasswordInput name="x" />')).toBe(false);
    expect(bad.test('<Input type="text" name="password" />')).toBe(false);
  });
});
