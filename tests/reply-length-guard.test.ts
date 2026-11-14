/**
 * حد طول الرد: الفخ اللي وقّف الردود بمساحة حقيقية.
 *
 * ⚠️ الحقل كان مشروح «كل ١٠٠ ≈ ٧٠ كلمة» — صحيح بالإنجليزي، غلط بالعربي.
 * على هالشرح انحطّ الحد ١٠٠، والقياس الحقيقي طلع ١٠٠ وحدة = ٢٧ حرف عربي،
 * فكل رد بينقطع بنص الكلمة → الحارس يرفضه → ٣ محاولات مع تأجيل ٣٠/٦٠/١٢٠
 * ثانية → الزبون بياخد رد متأخر دقيقة ونص أو ما بياخد.
 * 🔧 الشاشة صارت تحذّر تحت حد آمن، وفحص الصحة صار يعدّ فشل اليوم بس.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const AI_PAGE = join(ROOT, "src/app/(dashboard)/settings/ai/page.tsx");
const HEALTH = join(ROOT, "src/app/api/health/route.ts");

describe("شاشة حد طول الرد", () => {
  const page = readFileSync(AI_PAGE, "utf8");

  it("الشرح ما بيقول «٧٠ كلمة» لكل ١٠٠ — هاد اللي ضلّل", () => {
    expect(page).not.toContain("كل ١٠٠ ≈ ٧٠ كلمة");
  });

  it("الشرح بيذكر العربي صريح", () => {
    expect(page).toMatch(/بالعربي كل ١٠٠/);
  });

  it("في تحذير تحت حد آمن مع تصحيحه", () => {
    expect(page).toContain("SAFE_ARABIC_MAX_TOKENS");
    expect(page).toMatch(/form\.maxTokens < SAFE_ARABIC_MAX_TOKENS/);
    expect(page).toContain("RiskNote");
    expect(page).toContain("FixNote");
  });

  it("الحد الآمن مش أقل من ٣٠٠", () => {
    const m = page.match(/const SAFE_ARABIC_MAX_TOKENS = (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(300);
  });
});

describe("فحص الصحة بيعدّ فشل اليوم", () => {
  const health = readFileSync(HEALTH, "utf8");

  it("عدّ الفشل محدود بنافذة زمنية", () => {
    expect(health).toContain("RECENT_FAILURE_WINDOW_MS");
    expect(health).toMatch(/status:\s*"FAILED",\s*finishedAt:\s*\{\s*gte:/);
  });

  it("الرقم التاريخي بيضل ظاهر بحقل لحاله", () => {
    expect(health).toContain("failedJobsAllTime");
  });

  it("النافذة ٢٤ ساعة", () => {
    expect(health).toMatch(/RECENT_FAILURE_WINDOW_MS = 24 \* 60 \* 60 \* 1000/);
  });
});
