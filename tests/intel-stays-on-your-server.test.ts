/**
 * استخراج بيانات الزبون ما بيطلع لموديل خارجي.
 *
 * ⚠️ `getExtractionProvider` بيمشي على OpenRouter دايمًا، مهما كانت إعدادات
 * الذكاء بالمساحة. ومهمة الاستخراج شغلتها تطلّع **الاسم والرقم والعنوان** من
 * رسالة الزبون — يعني الرسالة كلها كانت تنبعت لطرف تالت، وهاد كسر لقاعدة
 * «ولا بيانات زبون لموديل خارجي». ومع مفتاح واقف صار كل استخراج يفشل
 * (`PROVIDER_400` — ١١٢ مرة على السيرفر الشغّال).
 * 🔧 `getWorkspaceExtractionProvider` بيقرأ إعدادات المساحة زي مسار الرد.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SERVICE = readFileSync(join(ROOT, "src/modules/intelligence/service.ts"), "utf8");
const PROVIDER = readFileSync(join(ROOT, "src/modules/intelligence/provider.ts"), "utf8");

describe("مسار الاستخراج", () => {
  it("ما بينادي مزوّد OpenRouter الثابت", () => {
    expect(SERVICE).not.toMatch(/\bgetExtractionProvider\s*\(/);
  });

  it("بينادي مزوّد المساحة", () => {
    expect(SERVICE).toMatch(/getWorkspaceExtractionProvider\s*\(/);
  });

  it("المختبر الداخلي بيضل يقدر يمرّر مزوّده", () => {
    expect(SERVICE).toMatch(/params\.options\s*\?\?/);
  });
});

describe("مزوّد المساحة", () => {
  it("بيقرأ إعدادات الذكاء تبع المساحة", () => {
    expect(PROVIDER).toMatch(/aISettings[\s\S]{0,20}findUnique/);
  });

  it("بلا إعدادات بيرجع لمزوّد البيئة بدل ما يوقف الاستخراج", () => {
    const fn = PROVIDER.slice(PROVIDER.indexOf("export async function getWorkspaceExtractionProvider"));
    expect(fn).toMatch(/if \(!settings\) return getExtractionProvider\(\)/);
  });

  it("بياخد المزوّد والموديل من نفس موجّه الردود", () => {
    expect(PROVIDER).toMatch(/getWorkspaceProvider\(/);
    expect(PROVIDER).toMatch(/resolveModel\(settings, "EXTRACTION"\)/);
  });

  it("ما بيثبّت OpenRouter بمزوّد المساحة", () => {
    const fn = PROVIDER.slice(PROVIDER.indexOf("export async function getWorkspaceExtractionProvider"));
    expect(fn).not.toContain("openrouter");
    expect(fn).not.toContain("OPENROUTER_API_KEY");
  });

  it("الدالة القديمة محذّر منها بالتعليق", () => {
    expect(PROVIDER).toMatch(/ما تستعملها لرسائل زبون/);
  });
});
