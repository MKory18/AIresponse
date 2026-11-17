import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { isSignupAllowed, isWorkspaceCreateAllowed } from "@/core/signup-gate";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as workspacesPOST } from "@/app/api/workspaces/route";

/**
 * S-06 — بوابة التسجيل (التفاصيل: docs/HANDOVER-2026-10-27.md §4.1).
 * بالإنتاج: التسجيل وإنشاء مساحة جديدة مسكّرين افتراضيًا؛ الفريق من «الفريق ← إنشاء حساب».
 */

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb } = await import("./helpers/inmemory-db");
  return { prisma: createFakeDb() };
});
vi.mock("@/core/api/rate-limit", () => ({
  rateLimitDb: async () => undefined,
  rateLimitMemory: () => undefined,
  clearRateLimitMemory: () => undefined,
}));
vi.mock("@/modules/auth/context", () => ({
  getAuthContext: async () => ({
    userId: "u-1",
    workspaceId: "ws-1",
    role: "OWNER",
    memberPermissions: [],
    can: () => true,
    require: () => undefined,
  }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

const KEYS = ["NODE_ENV", "ALLOW_SIGNUP", "ALLOW_WORKSPACE_CREATE", "ALLOW_DEMO_SEED"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) if (k !== "NODE_ENV") delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = saved[k]!;
  }
});
const setEnv = (k: string, v: string) => ((process.env as Record<string, string>)[k] = v);

const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("isSignupAllowed / isWorkspaceCreateAllowed", () => {
  it("بالإنتاج مسكّرين افتراضيًا", () => {
    setEnv("NODE_ENV", "production");
    expect(isSignupAllowed()).toBe(false);
    expect(isWorkspaceCreateAllowed()).toBe(false);
  });
  it("بالتطوير والاختبار مفتوحين افتراضيًا (ما بينكسر شغل المطوّر)", () => {
    setEnv("NODE_ENV", "development");
    expect(isSignupAllowed()).toBe(true);
    expect(isWorkspaceCreateAllowed()).toBe(true);
  });
  it("المتغيّر الصريح بيغلب بالاتجاهين", () => {
    setEnv("NODE_ENV", "production");
    setEnv("ALLOW_SIGNUP", "true");
    setEnv("ALLOW_WORKSPACE_CREATE", "1");
    expect(isSignupAllowed()).toBe(true);
    expect(isWorkspaceCreateAllowed()).toBe(true);
    setEnv("NODE_ENV", "development");
    setEnv("ALLOW_SIGNUP", "false");
    setEnv("ALLOW_WORKSPACE_CREATE", "0");
    expect(isSignupAllowed()).toBe(false);
    expect(isWorkspaceCreateAllowed()).toBe(false);
  });
  it("قيمة مش مفهومة = مسكّر (فشل مغلق)", () => {
    setEnv("NODE_ENV", "development");
    setEnv("ALLOW_SIGNUP", "maybe");
    expect(isSignupAllowed()).toBe(false);
  });
});

describe("POST /api/auth/register", () => {
  const body = { email: "new@x.test", password: "Passw0rd!x", name: "جديد", workspaceName: "متجر" };

  it("مسكّر بالإنتاج → 403 SIGNUP_DISABLED ولا حساب انخلق", async () => {
    setEnv("NODE_ENV", "production");
    const res = await registerPOST(post("/api/auth/register", body), { params: {} } as never);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("SIGNUP_DISABLED");
    const { prisma } = await import("@/core/db/prisma");
    expect(await (prisma as any).user.findUnique({ where: { email: body.email } })).toBeNull();
  });

  it("الرفض قبل قراءة الجسم: جسم فاضي بيرجّع 403 مش 422", async () => {
    setEnv("NODE_ENV", "production");
    const res = await registerPOST(post("/api/auth/register", {}), { params: {} } as never);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/workspaces", () => {
  it("إنشاء مساحة جديدة مسكّر بالإنتاج → 403 WORKSPACE_CREATE_DISABLED", async () => {
    setEnv("NODE_ENV", "production");
    const res = await workspacesPOST(post("/api/workspaces", { name: "مساحة ثانية" }), { params: {} } as never);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("WORKSPACE_CREATE_DISABLED");
  });
});

describe("الواجهة", () => {
  it("صفحة /register بتستدعي notFound لما التسجيل مسكّر", () => {
    const src = readFileSync("src/app/(auth)/register/page.tsx", "utf8");
    expect(src).toMatch(/isSignupAllowed\(\)/);
    expect(src).toMatch(/notFound\(\)/);
  });
  it("رابط «إنشاء حساب» بصفحة الدخول بيختفي لما مسكّر", () => {
    const src = readFileSync("src/components/auth-form.tsx", "utf8");
    expect(src).toMatch(/signupEnabled/);
    const page = readFileSync("src/app/(auth)/login/page.tsx", "utf8");
    expect(page).toMatch(/isSignupAllowed\(\)/);
  });
});

describe("prisma/seed.ts", () => {
  it("بيرفض الإنتاج بلا ALLOW_DEMO_SEED=1", () => {
    const src = readFileSync("prisma/seed.ts", "utf8");
    expect(src).toMatch(/ALLOW_DEMO_SEED/);
    expect(src).toMatch(/NODE_ENV/);
    expect(src.indexOf("ALLOW_DEMO_SEED")).toBeLessThan(src.indexOf("async function main"));
  });
});
