/**
 * مسار الرجوع بيفرّق بين «انتهت المهلة» و«المفاتيح غلط».
 *
 * ⚠️ `verifyOAuthState` كانت جوّا نفس الـ`try` تبع تبديل الرمز، فأي رمز حالة
 * منتهي (المهلة ١٠ دقائق — وشاشات ميتا بتاخد أكتر) كان يرجع بنفس رمز
 * `exchange`، والواجهة تقول للمالك «رقم التطبيق أو سره... ما بيطابقوا» وتبعته
 * يفتّش بـ`META_APP_SECRET` و`Valid OAuth Redirect URIs` — وهو ولا إشي فيهم غلط،
 * بس تأخّر على شاشة فيسبوك. سبب غلط بيوديه بالاتجاه الغلط.
 * 🔧 فحص رمز الحالة صار لحاله برمز `expired` وتصحيحه الخاص، وتبديل الرمز
 * بيضل `exchange`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/channels/facebook/callback/route";
import { describeConnectError } from "@/modules/channels/facebook/connect-errors";

const ROUTE = readFileSync(join(process.cwd(), "src/app/api/channels/facebook/callback/route.ts"), "utf8");

function callback(params: Record<string, string>): NextRequest {
  const qs = new URLSearchParams(params).toString();
  return new NextRequest(`http://localhost/api/channels/facebook/callback?${qs}`);
}

async function reasonOf(params: Record<string, string>): Promise<string | null> {
  const res = await GET(callback(params));
  const location = res.headers.get("location") ?? "";
  return new URL(location, "http://localhost").searchParams.get("fb_error");
}

describe("رمز الرجوع بيقول الخطوة اللي وقفت", () => {
  it("رمز حالة مش صالح = انتهت المهلة، مش خلل مفاتيح", async () => {
    // ⚠️ هاد بالضبط اللي كان يطلع «ميتا رفضت إكمال الربط — رقم التطبيق أو سره».
    expect(await reasonOf({ code: "any-code", state: "not-a-real-state" })).toBe("expired");
  });

  it("رمز حالة موقّع بمفتاح تاني كمان = انتهت المهلة", async () => {
    const foreign = "eyJhbGciOiJIUzI1NiJ9.eyJ3b3Jrc3BhY2VJZCI6IndzIiwidXNlcklkIjoidSIsImtpbmQiOiJmYl9vYXV0aCJ9.bm90LWEtcmVhbC1zaWduYXR1cmU";
    expect(await reasonOf({ code: "any-code", state: foreign })).toBe("expired");
  });

  it("رجوع بلا رمز أو برفض بيضل callback", async () => {
    expect(await reasonOf({ state: "s" })).toBe("callback");
    expect(await reasonOf({ code: "c" })).toBe("callback");
    expect(await reasonOf({ error: "access_denied", code: "c", state: "s" })).toBe("callback");
  });

  it("فحص الحالة خارج الـtry تبع تبديل الرمز", () => {
    // الترتيب هو الضمانة: لو رجع جوّاه، كل خطأ بيصير `exchange` تاني.
    const stateCheck = ROUTE.indexOf("verifyOAuthState");
    const exchangeCall = ROUTE.indexOf("exchangeCodeForLongLivedToken");
    expect(stateCheck).toBeGreaterThan(-1);
    expect(stateCheck).toBeLessThan(exchangeCall);
    expect(ROUTE).toMatch(/fb_error=expired/);
  });
});

describe("شرح «انتهت المهلة» بيوقف المالك بالمكان الصح", () => {
  it("سبب وتصحيح خاصين فيه", () => {
    const note = describeConnectError("expired");
    expect(note.risk).toMatch(/مهلة|انتهت/);
    expect(note.fix.length).toBeGreaterThan(20);
  });

  it("ما بيبعت المالك يفتّش بالمفاتيح", () => {
    // ⚠️ هون كانت الكلفة: ساعة تفتيش بإعدادات ميتا وما في إشي غلط فيها.
    const note = describeConnectError("expired");
    expect(note.fix).not.toMatch(/META_APP_SECRET|META_APP_ID|Redirect URIs/);
  });

  it("كل رمز لسا إله سبب مختلف عن غيره", () => {
    const codes = ["no_pages", "exchange", "callback", "selection", "expired"];
    const risks = new Set(codes.map((c) => describeConnectError(c).risk));
    expect(risks.size).toBe(codes.length);
  });

  it("تبديل الرمز لسا بيأشّر على المفاتيح", () => {
    expect(describeConnectError("exchange").fix).toContain("META_APP_ID");
  });
});
