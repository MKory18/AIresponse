import { describe, expect, it, vi } from "vitest";
import { workspaceHasEnabledAutomations } from "@/modules/automation/active-check";
import { resolveWorkerProcesses } from "@/modules/jobs/service";

describe("مهام الأتمتة الفاضية", () => {
  it("مساحة بلا أتمتة مفعّلة ما بتنضاف إلها مهام", async () => {
    const count = vi.fn().mockResolvedValue(0);
    expect(await workspaceHasEnabledAutomations({ automation: { count } }, "ws-none")).toBe(false);
    expect(count).toHaveBeenCalledWith({ where: { workspaceId: "ws-none", isEnabled: true } });
  });

  it("مساحة فيها أتمتة مفعّلة بتضل تنضاف إلها مهام", async () => {
    const count = vi.fn().mockResolvedValue(2);
    expect(await workspaceHasEnabledAutomations({ automation: { count } }, "ws-some")).toBe(true);
  });

  it("النتيجة محفوظة مؤقتًا حتى ما تنضغط القاعدة", async () => {
    const count = vi.fn().mockResolvedValue(0);
    const db = { automation: { count } };
    await workspaceHasEnabledAutomations(db, "ws-cached");
    await workspaceHasEnabledAutomations(db, "ws-cached");
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("إذا فشل الفحص ما منضيّع المهمة", async () => {
    const count = vi.fn().mockRejectedValue(new Error("db down"));
    expect(await workspaceHasEnabledAutomations({ automation: { count } }, "ws-error")).toBe(true);
    expect(await workspaceHasEnabledAutomations({}, "ws-no-model")).toBe(true);
  });
});

describe("عدد عمليات العامل داخل الحاوية", () => {
  it("الافتراضي عملية وحدة، والقيم محصورة بين 1 و16", () => {
    expect(resolveWorkerProcesses(undefined)).toBe(1);
    expect(resolveWorkerProcesses("4")).toBe(4);
    expect(resolveWorkerProcesses("0")).toBe(1);
    expect(resolveWorkerProcesses("99")).toBe(16);
    expect(resolveWorkerProcesses("abc")).toBe(1);
  });
});
