/**
 * تطبيق ميتا من نوع Business بيربط الصفحات بـ«إعداد» (configuration) مش بـ`scope`.
 *
 * ⚠️ بعد تبديل تطبيق ميتا لتطبيق نوعه Business، شاشة الموافقة كانت تفتح وترجّع
 * المالك بلا ولا صفحة: ميتا بهالنوع بتتجاهل `scope` وبتعطي الأصول (الصفحات) من
 * إعداد محفوظ بلوحة التطبيق. بتوثيق ميتا: «config_id has replaced scope».
 * فالربط كان بيكمل «بنجاح» وقائمة الصفحات ترجع فاضية — بلا ولا سبب.
 * 🔧 لما `META_LOGIN_CONFIG_ID` موجود منبعت `config_id` بدل `scope`؛ وإذا مش
 * موجود منضل على `scope` حرفيًا زي قبل — تطبيق الـConsumer القديم ما بينكسر
 * (ميتا نفسها بتحذّر: الـLogin العادي ما بيدعم `config_id`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resetEnvCache } from "@/core/env";
import { buildAuthorizeUrl } from "@/modules/channels/facebook/oauth";
import { describeConnectError } from "@/modules/channels/facebook/connect-errors";

const REDIRECT = "https://staging.example.com/api/channels/facebook/callback";
const REQUIRED_SCOPES = ["pages_show_list", "pages_messaging", "pages_manage_metadata", "pages_read_engagement"];

function paramsOf(url: string): URLSearchParams {
  return new URLSearchParams(url.split("?")[1]);
}

describe("رابط الموافقة بيتبع نوع التطبيق", () => {
  const before = process.env.META_LOGIN_CONFIG_ID;

  beforeEach(() => {
    delete process.env.META_LOGIN_CONFIG_ID;
    resetEnvCache();
  });

  afterEach(() => {
    if (before === undefined) delete process.env.META_LOGIN_CONFIG_ID;
    else process.env.META_LOGIN_CONFIG_ID = before;
    resetEnvCache();
  });

  it("بلا إعداد: `scope` زي ما كان — التطبيق القديم ما بينكسر", () => {
    const p = paramsOf(buildAuthorizeUrl("state-token", REDIRECT));
    expect(p.get("config_id")).toBeNull();
    const scopes = p.get("scope")!.split(",");
    for (const s of REQUIRED_SCOPES) expect(scopes).toContain(s);
  });

  it("مع إعداد: `config_id` بينبعت و`scope` بينشال", () => {
    process.env.META_LOGIN_CONFIG_ID = "1234567890";
    resetEnvCache();
    const p = paramsOf(buildAuthorizeUrl("state-token", REDIRECT));
    expect(p.get("config_id")).toBe("1234567890");
    // ميتا بتوصي ما تبعت `scope` مع `config_id` — الصلاحيات جوّا الإعداد.
    expect(p.get("scope")).toBeNull();
  });

  it("باقي الحقول ما بتتغيّر مع الإعداد", () => {
    process.env.META_LOGIN_CONFIG_ID = "1234567890";
    resetEnvCache();
    const url = buildAuthorizeUrl("state-token", REDIRECT);
    expect(url).toMatch(/^https:\/\/www\.facebook\.com\/v\d+\.\d+\/dialog\/oauth\?/);
    const p = paramsOf(url);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("state")).toBe("state-token");
    expect(p.get("redirect_uri")).toBe(REDIRECT);
  });

  it("إعداد فاضي أو فراغات = ما في إعداد", () => {
    for (const value of ["", "   "]) {
      process.env.META_LOGIN_CONFIG_ID = value;
      resetEnvCache();
      const p = paramsOf(buildAuthorizeUrl("state-token", REDIRECT));
      expect(p.get("config_id")).toBeNull();
      expect(p.get("scope")).not.toBeNull();
    }
  });

  it("الإعداد معلَن بمخطط البيئة", () => {
    const envSrc = readFileSync(join(process.cwd(), "src/core/env.ts"), "utf8");
    expect(envSrc).toMatch(/META_LOGIN_CONFIG_ID/);
  });
});

describe("«ولا صفحة» بتذكر إعداد تطبيق Business", () => {
  it("التصحيح بيأشّر على الإعداد مش بس على الأدمن ووضع التطوير", () => {
    const note = describeConnectError("no_pages");
    // ⚠️ أشهر سبب بعد تبديل التطبيق: نوع Business بلا إعداد محفوظ.
    expect(note.fix).toMatch(/Business/);
    expect(note.fix).toMatch(/META_LOGIN_CONFIG_ID/);
    // واللي كان موجود بيضل: الأدمن ووضع التطوير.
    expect(note.fix).toContain("Admin");
    expect(note.fix).toMatch(/التطوير/);
  });
});
