/**
 * 3.5ب — «المعلومات» بأربعة أقسام: القسم بالرابط ولكل قسم صلاحيته، ومساري /media و/feedback بيضلوا شغّالين،
 * وما في نموذج إضافة مفتوح دايمًا (المستند والسؤال بحوار).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolveSection } from "@/app/(dashboard)/knowledge/v2/knowledge-view";

const D = "src/app/(dashboard)";
const read = (p: string) => readFileSync(`${D}/${p}`, "utf8");

describe("resolveSection", () => {
  it("بيحترم ?tab= المسموح، وغير صالح أو غير مسموح = أول قسم مسموح", () => {
    expect(resolveSection("media", ["faq", "docs", "media", "feedback"])).toBe("media");
    expect(resolveSection("media", ["faq", "docs"])).toBe("faq");
    expect(resolveSection("nope", ["docs", "media"])).toBe("docs");
    expect(resolveSection(null, ["feedback"])).toBe("feedback");
  });
  it("بلا ولا صلاحية = null (ما بيعرض شي)", () => {
    expect(resolveSection("faq", [])).toBeNull();
  });
});

describe("الأقسام والمسارات", () => {
  it("المسارات القديمة شغّالة (الصفحات موجودة) والأجسام مشتركة", () => {
    for (const p of ["knowledge/page.tsx", "media/page.tsx", "feedback/page.tsx"]) expect(existsSync(`${D}/${p}`), p).toBe(true);
    expect(read("media/page.tsx")).toContain("MediaBody");
    expect(read("feedback/page.tsx")).toContain("FeedbackBody");
    const view = read("knowledge/v2/knowledge-view.tsx");
    expect(view).toMatch(/KnowledgeBody section="faq"/);
    expect(view).toMatch(/KnowledgeBody section="docs"/);
    expect(view).toContain("MediaBody");
    expect(view).toContain("FeedbackBody");
  });
  it("كل قسم بصلاحيته: المعلومات · الوسائط · الآراء", () => {
    const view = read("knowledge/v2/knowledge-view.tsx");
    expect(view).toContain('permission: "knowledge.read"');
    expect(view).toContain('permission: "media.read"');
    expect(view).toContain('permission: "feedback.read"');
  });
  it("المستند والسؤال الشائع بحوار (مش نموذج مفتوح دايمًا)", () => {
    const body = read("knowledge/knowledge-body.tsx");
    expect(body).toMatch(/<Dialog open=\{addDocOpen\}/);
    expect(body).toMatch(/<Dialog open=\{addFaqOpen\}/);
    expect(body).toMatch(/section === "docs"/);
    expect(body).toMatch(/section === "faq"/);
  });
});
