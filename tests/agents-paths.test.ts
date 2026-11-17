import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

describe("AGENTS.md يذكر بس مسارات موجودة بالكود (الحزمة 0.2)", () => {
  it("scripts/check-agents-paths.mjs بينجح", () => {
    const out = execFileSync(process.execPath, ["scripts/check-agents-paths.mjs"], { encoding: "utf8" });
    expect(out).toMatch(/paths OK/);
  });
});
