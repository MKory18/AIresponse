/**
 * عرض حالة ربط الـOMS: الخطأ القديم ما بيظهر بعد نجاح أحدث منه.
 *
 * ⚠️ «آخر خطأ: probe: OMS_AUTH_FAILED» (14 نوفمبر) ضل ظاهر والاتصال ناجح بنفس يوم الفحص، فالمالك ظن
 * إنه التوكن مرفوض وطلب توكن جديد وهو سليم. 🔧 الخطأ بيظهر بس لما يكون هو الأحدث.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentOmsError } from "@/lib/oms-health";

const ERR = "probe: OMS_AUTH_FAILED";

describe("currentOmsError", () => {
  it("حالة الحادثة: خطأ 14 نوفمبر ونجاح بعده = ما في خطأ", () => {
    expect(currentOmsError({ lastError: ERR, lastErrorAt: "2026-11-14T10:36:26.830Z", lastOkAt: "2026-11-18T20:44:02.610Z" })).toBeNull();
  });

  it("خطأ أحدث من آخر نجاح = بيظهر", () => {
    expect(currentOmsError({ lastError: ERR, lastErrorAt: "2026-11-18T21:00:00Z", lastOkAt: "2026-11-18T20:00:00Z" })).toBe(ERR);
  });

  it("خطأ ولا نجاح أبدًا = بيظهر", () => {
    expect(currentOmsError({ lastError: ERR, lastErrorAt: "2026-11-18T21:00:00Z", lastOkAt: null })).toBe(ERR);
  });

  it("خطأ بلا تاريخ = بيظهر (ما بنخبّي شي ما بنعرف إنه قديم)", () => {
    expect(currentOmsError({ lastError: ERR, lastErrorAt: null, lastOkAt: "2026-11-18T20:00:00Z" })).toBe(ERR);
  });

  it("بلا خطأ = null", () => {
    expect(currentOmsError({ lastError: null, lastErrorAt: null, lastOkAt: null })).toBeNull();
  });

  it("نجاح بنفس لحظة الخطأ = تعافى", () => {
    const t = "2026-11-18T20:00:00Z";
    expect(currentOmsError({ lastError: ERR, lastErrorAt: t, lastOkAt: t })).toBeNull();
  });
});

describe("الواجهة بتستعمله", () => {
  it("oms-section بتمرّر الخطأ من currentOmsError مش من lastError مباشرة", () => {
    const src = readFileSync(join(process.cwd(), "src/components/integrations/oms-section.tsx"), "utf8");
    expect(src).toContain("currentOmsError");
    expect(src).not.toMatch(/view\??\.lastError \?/);
  });
});
