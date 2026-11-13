/**
 * عنوان مزوّد مكسور ما بيقفل عليك الإعدادات.
 *
 * ⚠️ كان: الواجهة بتبعت `customBaseUrl` مع كل حفظ، والمسار بيفحصه مهما كان
 * المزوّد المختار. فلما عنوان المزوّد المخصص يوقف (DNS مثلًا) بيرجع 422 —
 * وما بتقدر تبدّل لمزوّد شغّال، لأن الهروب نفسه بينرفض بسبب العنوان المكسور.
 * 🔧 هلأ: الفحص بس للمزوّدين اللي بيستعملوا العنوان (custom · hermes)،
 * والعنوان المخزّن بينفحص لحظة ما تبدّل لواحد منهم — فما في عنوان بينشغّل
 * بلا فحص.
 */
import { describe, expect, it } from "vitest";

/** نفس قرار المسار، معزول عن الشبكة وقاعدة البيانات. */
function urlNeedingCheck(params: {
  provider?: string;
  currentProvider?: string;
  bodyUrl?: string | null;
  storedUrl?: string | null;
}): string | null {
  const effective = params.provider ?? params.currentProvider ?? "mock";
  const uses = effective === "hermes" || effective === "custom";
  if (!uses) return null;
  return params.bodyUrl !== undefined ? params.bodyUrl : (params.storedUrl ?? null);
}

describe("تبديل المزوّد وقت عنوانه مكسور", () => {
  it("التبديل لمزوّد ما بيستعمل العنوان ما بيفحص العنوان", () => {
    expect(
      urlNeedingCheck({
        provider: "internal",
        currentProvider: "custom",
        bodyUrl: "https://glm.broken.example/v1",
        storedUrl: "https://glm.broken.example/v1",
      })
    ).toBeNull();
  });

  it("الضلّ على «مخصص» بيفحص العنوان المبعوت", () => {
    expect(
      urlNeedingCheck({ provider: "custom", bodyUrl: "https://api.example.com/v1" })
    ).toBe("https://api.example.com/v1");
  });

  it("التبديل لـ«مخصص» بلا عنوان جديد بيفحص العنوان المخزّن", () => {
    // الثغرة المقابلة: تخزين عنوان داخلي تحت مزوّد ما بيستعمله، وبعدين
    // تشغيله بتبديل بلا عنوان. هون بينفحص.
    expect(
      urlNeedingCheck({ provider: "custom", currentProvider: "openai", storedUrl: "http://169.254.169.254/v1" })
    ).toBe("http://169.254.169.254/v1");
  });

  it("«الوكيل الذكي» بيفحص زي «مخصص»", () => {
    expect(urlNeedingCheck({ provider: "hermes", storedUrl: "http://localhost:20128/v1" })).toBe(
      "http://localhost:20128/v1"
    );
  });

  it("مسح العنوان (null) مع مزوّد بيستعمله ما بينفحص", () => {
    expect(urlNeedingCheck({ provider: "custom", bodyUrl: null })).toBeNull();
  });

  it("مزوّد ما بيستعمل العنوان وما في عنوان مخزّن", () => {
    expect(urlNeedingCheck({ provider: "openrouter" })).toBeNull();
  });
});
