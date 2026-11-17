import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { FORBIDDEN, TERMS, findForbiddenTerms } from "@/lib/glossary";
import { API_ERROR_MESSAGES } from "@/lib/api-client";
import { newUiFiles } from "./helpers/new-ui-files";

/**
 * 2.1 — القاموس الموحّد. الكلمات الممنوعة بتنفحص على ملفات الواجهة **الجديدة** بس
 * (عدّة 2.1 + أي مجلد اسمه `v2`)؛ الواجهة القديمة بتتنظّف بحزمة 3.8.
 */
const ROOT = process.cwd();

describe("glossary", () => {
  it("الأسماء الرسمية موجودة ولا واحد منها بالقائمة الممنوعة", () => {
    for (const [key, text] of Object.entries(TERMS)) {
      expect(text.length, key).toBeGreaterThan(0);
      expect(findForbiddenTerms(text).map((f) => f.word), `TERMS.${key}`).toEqual([]);
    }
  });

  it("الكشف يعمل بحدود كلمة (العميل مسموح، الزبون ممنوع)", () => {
    expect(findForbiddenTerms("رد على الزبون").map((f) => f.word)).toContain("الزبون");
    expect(findForbiddenTerms("رد على العميل")).toEqual([]);
    expect(findForbiddenTerms("مسودة طلب").map((f) => f.word)).toContain("مسودة");
    expect(findForbiddenTerms("بطاقة الطلب قيد التجميع")).toEqual([]);
    expect(findForbiddenTerms("Hermes agent").length).toBeGreaterThan(0);
  });

  it("لكل ممنوع بديل مكتوب", () => {
    for (const f of FORBIDDEN) expect(f.use.length, f.word).toBeGreaterThan(0);
  });

  it("ولا كلمة ممنوعة بملفات الواجهة الجديدة", () => {
    const hits: string[] = [];
    for (const file of newUiFiles()) {
      if (!existsSync(file)) {
        hits.push(`ملف العدّة مفقود: ${relative(ROOT, file)}`);
        continue;
      }
      // التعليقات مستثناة (بتشرح ليش الكلمة ممنوعة)؛ النصوص بس.
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const f of findForbiddenTerms(code)) hits.push(`${relative(ROOT, file)}: «${f.word}» ← ${f.use}`);
    }
    expect(hits).toEqual([]);
  });

  it("رسائل الأخطاء بالقاموس نفسه (العميل مش الزبون)", () => {
    for (const [code, msg] of Object.entries(API_ERROR_MESSAGES)) expect(findForbiddenTerms(msg), code).toEqual([]);
  });
});
