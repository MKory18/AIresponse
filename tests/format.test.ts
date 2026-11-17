import { describe, expect, it } from "vitest";
import {
  EMPTY,
  formatCountdown,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRelative,
  formatTime,
} from "@/lib/format";

/** 2.1 — التنسيق الموحّد: أرقام لاتينية · مبالغ برمز العملة · توقيت المساحة · ما بيرمي. */
describe("formatNumber", () => {
  it("أرقام لاتينية بفواصل آلاف", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber("42")).toBe("42");
    expect(formatNumber(1.236)).toBe("1.24");
    expect(formatNumber(1.236, 0)).toBe("1");
  });
  it("فاضي/تالف = «—»", () => {
    for (const v of [null, undefined, "", "abc", NaN, Infinity]) expect(formatNumber(v)).toBe(EMPTY);
  });
  it("ولا رقم هندي عربي", () => {
    expect(formatNumber(1234567890)).toMatch(/^[0-9,]+$/);
  });
});

describe("formatMoney", () => {
  it("المبلغ مع رمز العملة دايمًا", () => {
    expect(formatMoney(12.5, "JOD")).toBe("12.5 د.أ");
    expect(formatMoney(150000, "SYP")).toBe("150,000 ل.س");
    expect(formatMoney(9.99, "USD")).toBe("$9.99");
  });
  it("الدينار بـ3 كسور وغيره بـ2", () => {
    expect(formatMoney(1.2345, "JOD")).toBe("1.235 د.أ");
    expect(formatMoney(1.2345, "SAR")).toBe("1.23 ر.س");
  });
  it("عملة مجهولة بتظهر برمزها، وبلا عملة المبلغ لحاله، وقيمة تالفة «—»", () => {
    expect(formatMoney(5, "XYZ")).toBe("5 XYZ");
    expect(formatMoney(5, null)).toBe("5");
    expect(formatMoney("x", "JOD")).toBe(EMPTY);
  });
  it("حروف العملة صغيرة تنقبل", () => {
    expect(formatMoney(3, "jod")).toBe("3 د.أ");
  });
});

describe("التاريخ والوقت بتوقيت المساحة", () => {
  const iso = "2026-11-17T22:30:00Z"; // عمّان UTC+3 = 18 نوفمبر 01:30
  it("اليوم والساعة حسب المنطقة الزمنية", () => {
    expect(formatTime(iso, "Asia/Amman")).toBe("01:30");
    expect(formatTime(iso, "UTC")).toBe("22:30");
  });
  it("مش 24:00 بمنتصف الليل (h23)", () => {
    expect(formatTime("2026-11-17T21:00:00Z", "Asia/Amman")).toBe("00:00");
  });
  it("التاريخ بأرقام لاتينية", () => {
    expect(formatDateTime(iso, "UTC")).toMatch(/17/);
    expect(formatDateTime(iso, "UTC")).not.toMatch(/[٠-٩]/);
  });
  it("السنة بتظهر إذا مو السنة الحالية", () => {
    const now = new Date("2026-11-17T10:00:00Z");
    expect(formatDate("2026-03-05T10:00:00Z", "UTC", now)).not.toMatch(/2026/);
    expect(formatDate("2025-03-05T10:00:00Z", "UTC", now)).toMatch(/2025/);
  });
  it("منطقة زمنية مجهولة ما بتكسر", () => {
    expect(formatTime(iso, "Not/AZone")).toMatch(/^\d\d:\d\d$/);
  });
  it("فاضي/تالف = «—»", () => {
    expect(formatDateTime(null)).toBe(EMPTY);
    expect(formatDate("not a date")).toBe(EMPTY);
    expect(formatTime(undefined)).toBe(EMPTY);
    expect(formatRelative("")).toBe(EMPTY);
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it("الآن · دقائق · ساعات · أيام", () => {
    expect(formatRelative(ago(10_000), now)).toBe("الآن");
    expect(formatRelative(ago(5 * 60_000), now)).toBe("قبل 5 د");
    expect(formatRelative(ago(3 * 3_600_000), now)).toBe("قبل 3 س");
    expect(formatRelative(ago(2 * 86_400_000), now)).toBe("قبل 2 يوم");
  });
  it("بعد شهر التاريخ، والمستقبل تاريخ كامل", () => {
    expect(formatRelative(ago(45 * 86_400_000), now, "UTC")).toMatch(/\d/);
    expect(formatRelative(new Date(now.getTime() + 3_600_000), now, "UTC")).not.toMatch(/قبل/);
  });
});

describe("formatCountdown", () => {
  it("MM:SS و H:MM:SS ولا ينزل تحت صفر", () => {
    expect(formatCountdown(8 * 60_000 + 12_000)).toBe("08:12");
    expect(formatCountdown(3_725_000)).toBe("1:02:05");
    expect(formatCountdown(-5000)).toBe("00:00");
    expect(formatCountdown(NaN)).toBe("00:00");
  });
});
