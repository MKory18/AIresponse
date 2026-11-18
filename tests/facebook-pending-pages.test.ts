/**
 * قائمة اختيار الصفحة بعد موافقة فيسبوك.
 *
 * ⚠️ الخادم لقى الصفحة وعمل رمز الاختيار، بس الواجهة كانت تفكّ حمولة الرمز بالمتصفح
 * وتدوّر على `pages` — وحمولته صارت مشفّرة (`p`، S-03) — فبتشوف قائمة فاضية وبتعرض
 * «فيسبوك ما رجّع ولا صفحة» وهي موجودة (صار فعلًا مع صفحة فيتا فارما).
 * 🔧 الأسماء بتجي من `POST /api/channels/facebook/pending-pages` (الخادم بيتحقق من الرمز)،
 * و`id` و`name` بس — ولا توكن صفحة بيطلع.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPagesSelectionToken, verifyPagesSelectionToken } from "@/modules/channels/facebook/oauth";

const ROOT = process.cwd();
const VIEW = readFileSync(join(ROOT, "src/app/(dashboard)/channels/v2/channels-view.tsx"), "utf8");
const ROUTE = readFileSync(join(ROOT, "src/app/api/channels/facebook/pending-pages/route.ts"), "utf8");

describe("رمز اختيار الصفحة مشفّر — الواجهة ما بتقراه لحالها", () => {
  it("الحمولة الحقيقية بلا `pages` مكشوفة (وهاد سبب القائمة الفاضية)", async () => {
    const token = await createPagesSelectionToken("ws-1", "u-1", [
      { id: "111", name: "فيتا فارما", accessToken: "PAGE_TOKEN_SECRET" },
    ]);
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    expect(payload.pages).toBeUndefined();
    expect(typeof payload.p).toBe("string");
    // ولا توكن الصفحة ولا اسمها بيظهرو بالنص الواضح.
    expect(token).not.toContain("PAGE_TOKEN_SECRET");
    // الخادم بيفكّه صح — وهاد اللي بيرجّعه المسار الجديد.
    const sel = await verifyPagesSelectionToken(token);
    expect(sel.pages.map((p) => ({ id: p.id, name: p.name }))).toEqual([{ id: "111", name: "فيتا فارما" }]);
  });
});

describe("الواجهة بتجيب القائمة من الخادم", () => {
  it("channels-view بتنادي pending-pages مش بتفك الرمز بالمتصفح", () => {
    expect(VIEW).toContain("/api/channels/facebook/pending-pages");
    expect(VIEW).not.toMatch(/parsePendingPages|atob\(/);
  });

  it("المسار بيرجّع id و name بس، وبيتحقق من المساحة والمستخدم", () => {
    expect(ROUTE).toMatch(/verifyPagesSelectionToken/);
    expect(ROUTE).toMatch(/workspaceId !== auth!\.workspaceId/);
    expect(ROUTE).toMatch(/userId !== auth!\.userId/);
    expect(ROUTE).toMatch(/\{ id: p\.id, name: p\.name \}/);
    expect(ROUTE).not.toMatch(/accessToken/);
  });
});
