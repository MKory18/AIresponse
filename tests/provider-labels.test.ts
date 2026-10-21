import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_LABEL, PROVIDER_AR, providerLabel, publicDetail, publicText } from "@/lib/provider-labels";

/**
 * قرار المالك: **ولا «Hermes» بأي نص مرئي بالموقع**.
 *
 * ⚠️ قبل: استوديو الذكاء كان عنده خريطة ناقصة (بلا hermes) فكان بيعرض الـid الخام، وبعد
 * «اختبار الاتصال» بيعرض `HERMES_BASE_URL_OR_API_KEY_MISSING` خام.
 * 🔧 هلأ خريطة مشتركة وتنظيف لأي نص بيوصل للمستخدم.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("أسماء المزوّدين المعروضة (ولا «Hermes» بالواجهة)", () => {
  const IDS = ["hermes", "custom", "openai", "openrouter", "internal", "mock", "hermes-bridge", "HERMES"];

  it("كل id بيطلع باسم عرض بلا كلمة hermes", () => {
    for (const id of IDS) expect(providerLabel(id), id).not.toMatch(/hermes/i);
    expect(providerLabel("hermes")).toContain(AGENT_LABEL);
    expect(providerLabel(null)).toBe("—");
  });

  it("تفاصيل فحص الاتصال: الكود المعروف بيتترجم، وأي نص تاني فيه hermes بيتنظّف", () => {
    const known = publicDetail("HERMES_BASE_URL_OR_API_KEY_MISSING");
    expect(known).not.toMatch(/hermes/i);
    expect(known).toMatch(/[؀-ۿ]/);
    expect(publicDetail("SSRF_REJECTED_hermes_private_ip")).not.toMatch(/hermes/i);
    expect(publicDetail("API_KEY_MISSING")).toBe("API_KEY_MISSING");
    expect(publicText("x HERMES y")).toBe(`x ${AGENT_LABEL} y`);
  });

  it("الصفحتين (الاستوديو والإعدادات) بتستعملوا الخريطة المشتركة — ما في خريطة محلية بتتعارض", () => {
    for (const file of ["src/app/(dashboard)/ai/studio/page.tsx", "src/app/(dashboard)/settings/ai/page.tsx"]) {
      const src = read(file);
      expect(src, file).toContain('from "@/lib/provider-labels"');
      expect(src, file).not.toMatch(/const PROVIDER_AR\b/);
    }
  });

  it("الاستوديو بيعرض تفصيل الفحص بعد التنظيف مش خام", () => {
    const studio = read("src/app/(dashboard)/ai/studio/page.tsx");
    expect(studio).toContain("publicDetail(r.detail)");
    expect(studio).not.toMatch(/\{r\.detail\}/);
  });

  it("كل خيارات المزوّد بالإعدادات إلها اسم عرض", () => {
    const m = /const PROVIDER_OPTIONS = \[([^\]]*)\]/.exec(read("src/app/(dashboard)/settings/ai/page.tsx"));
    const opts = [...m![1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]!);
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(PROVIDER_AR[o], o).toBeTruthy();
  });
});
