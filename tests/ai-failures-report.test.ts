import { describe, expect, it } from "vitest";
import { sanitizeError, summarizeFailures } from "@/modules/ai/failures-report";

describe("تقرير نداءات الذكاء الفاشلة", () => {
  const rows = [
    { purpose: "EXTRACTION", provider: "hermes", success: false, error: "timeout after 15000ms", latencyMs: 15000 },
    { purpose: "EXTRACTION", provider: "hermes", success: false, error: "timeout after 15000ms", latencyMs: 15100 },
    { purpose: "RESPONSE", provider: "hermes", success: false, error: "HTTP 502", latencyMs: 800 },
    { purpose: "RESPONSE", provider: "hermes", success: true, latencyMs: 900 },
  ];

  it("بيجمّع حسب الغرض والمزوّد والخطأ ويرتّب بالأكتر", () => {
    const s = summarizeFailures(rows);
    expect(s.total).toBe(4);
    expect(s.failed).toBe(3);
    expect(s.failureRate).toBe(75);
    expect(s.groups[0]).toMatchObject({ purpose: "EXTRACTION", count: 2, avgLatencyMs: 15050 });
    expect(s.groups[1]).toMatchObject({ purpose: "RESPONSE", count: 1 });
  });

  it("قائمة فاضية = صفر بلا قسمة على صفر", () => {
    expect(summarizeFailures([])).toEqual({ total: 0, failed: 0, failureRate: 0, groups: [] });
  });

  it("نص الخطأ بيتقصّ وأي رقم طويل (هاتف) بيتعتّم", () => {
    expect(sanitizeError("failed for 0791234567 now")).toBe("failed for # now");
    expect(sanitizeError("x".repeat(300)).length).toBe(100);
    expect(sanitizeError(null)).toBe("(بلا نص خطأ)");
  });
});
