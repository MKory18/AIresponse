import { describe, expect, it } from "vitest";
import { LABELS, label, formatNumber, formatDate } from "@/lib/i18n";

/**
 * P11 — لغة موحدة: كل مفردات الواجهات (حالات/مشغلات/عمليات) لها تسمية عربية —
 * لا نصوص تقنية خام تظهر للمستخدم النهائي.
 */
describe("P11-1 Arabic labels cover raw enums rendered in UI", () => {
  it("workflow/automation triggers have Arabic labels", () => {
    const triggers = [
      "MESSAGE_RECEIVED", "CONVERSATION_CREATED", "CONVERSATION_STATUS_CHANGED",
      "CONVERSATION_ASSIGNED", "HANDOFF_CREATED", "CUSTOMER_TAGGED", "CUSTOMER_CREATED",
      "ORDER_CREATED", "ORDER_CONFIRMED", "ORDER_CANCELLED", "ORDER_STATUS_CHANGED_FROM_OMS",
      "ORDER_DELIVERED",
    ];
    for (const tr of triggers) expect(LABELS[tr], `missing label for ${tr}`).toBeTruthy();
  });

  it("condition operators have Arabic labels", () => {
    const ops = ["EQ", "NEQ", "GT", "GTE", "LT", "LTE", "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "EXISTS", "NOT_EXISTS"];
    for (const op of ops) expect(LABELS[op], `missing label for ${op}`).toBeTruthy();
  });

  it("statuses (workflow, AI state, executions) have Arabic labels", () => {
    for (const s of ["DRAFT", "PUBLISHED", "PAUSED", "AI_ACTIVE", "AI_PAUSED", "HUMAN_ACTIVE", "COMPLETED", "WOULD_RUN", "WOULD_WAIT", "WOULD_SKIP"]) {
      expect(LABELS[s], `missing label for ${s}`).toBeTruthy();
    }
  });

  it("label() falls back to the raw value only when unmapped", () => {
    expect(label("DRAFT")).toBe("مسودة");
    expect(label("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(label(null)).toBe("—");
  });
});

describe("P11-2 number/date formatting (RTL-safe)", () => {
  it("formatNumber uses Arabic locale grouping", () => {
    expect(formatNumber(12345)).toBe((12345).toLocaleString("ar", { maximumFractionDigits: 2 }));
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber("not-a-number")).toBe("not-a-number"); // لا يتحول NaN
  });

  it("formatDate handles null and valid dates", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("2026-10-10T00:00:00Z")).not.toBe("—");
  });
});
