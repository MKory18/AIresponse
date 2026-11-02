import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_AR, providerLabel, publicDetail } from "@/lib/provider-labels";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("أسماء المزوّدين المعروضة", () => {
  it("المزوّدون المعتمدون لهم أسماء عرض", () => {
    for (const id of ["openrouter", "custom", "internal", "mock"]) {
      expect(providerLabel(id), id).toBeTruthy();
    }
    expect(providerLabel(null)).toBe("—");
  });

  it("المزوّدون المحذوفون ما إلهم اسم ولا خيار بالواجهة", () => {
    for (const id of ["hermes", "hermes-bridge", "openai"]) {
      expect(PROVIDER_AR[id], id).toBeUndefined();
    }
    const page = read("src/app/(dashboard)/settings/ai/page.tsx");
    const m = /const PROVIDER_OPTIONS = \[([^\]]*)\]/.exec(page);
    expect(m).not.toBeNull();
    const opts = [...m![1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]!);
    expect(opts.sort()).toEqual(["custom", "internal", "mock", "openrouter"].sort());
  });

  it("تفاصيل الفحص تمر كما هي بلا كلمات محذوفة", () => {
    expect(publicDetail("API_KEY_MISSING")).toBe("API_KEY_MISSING");
  });

  it("الإعدادات وبطاقة الحالة يستعملون الخريطة المشتركة", () => {
    for (const file of ["src/app/(dashboard)/settings/ai/ai-status-card.tsx", "src/app/(dashboard)/settings/ai/page.tsx"]) {
      const src = read(file);
      expect(src, file).toContain('from "@/lib/provider-labels"');
      expect(src, file).not.toMatch(/const PROVIDER_AR\b/);
    }
  });
});
