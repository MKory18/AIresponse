import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
const workerBlock = compose.slice(compose.indexOf("\n  worker:"), compose.indexOf("\nvolumes:"));
const postgresBlock = compose.slice(compose.indexOf("\n  postgres:"), compose.indexOf("\n  worker:"));

describe("سعة العمال بالإنتاج", () => {
  it("عدد عمليات العامل قابل للضبط وافتراضيه 4", () => {
    expect(workerBlock).toContain("WORKER_PROCESSES: ${WORKER_PROCESSES:-4}");
  });

  it("ما في scale بملف Compose لأن Coolify ما بيدعم النسخ", () => {
    expect(workerBlock).not.toMatch(/^\s+scale:/m);
  });

  it("كل عامل بيعالج 16 رد بنفس الوقت افتراضيًا", () => {
    expect(workerBlock).toContain("AI_JOB_CONCURRENCY: ${AI_JOB_CONCURRENCY:-16}");
  });

  it("سقف اتصالات القاعدة بيتحمّل العمال الزيادة", () => {
    expect(postgresBlock).toContain("max_connections=${POSTGRES_MAX_CONNECTIONS:-200}");
  });
});
