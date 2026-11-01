import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as faqsGET } from "@/app/api/faqs/route";

/**
 * GET /api/faqs — قائمة الأسئلة الشائعة لصفحة «المعرفة».
 *
 * ⚠️ قبل: الصفحة بتطلب `GET /api/faqs?limit=200` بس المسار ما فيه غير POST ←
 * ٤٠٥ ← «فشل تحميل قاعدة المعرفة» دايمًا، وحتى المستندات ما بتظهر.
 * 🔧 GET بيرجّع أسئلة المساحة بس (`listFaqs` الموجودة) بصلاحية `knowledge.read`.
 */

const WS = "ws-faqs";
const OTHER = "ws-faqs-other";

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb } = await import("./helpers/inmemory-db");
  const db = createFakeDb();
  (globalThis as Record<string, unknown>).__faqsRouteDb = db;
  return { prisma: db };
});
vi.mock("@/modules/auth/context", async () => {
  const { AuthorizationError } = await import("@/core/errors");
  return {
    getAuthContext: async () => ({
      userId: "u-1",
      workspaceId: WS,
      role: "SALES_AGENT",
      memberPermissions: [],
      can: (p: string) => p === "knowledge.read",
      require: (p: string) => {
        if (p !== "knowledge.read") throw new AuthorizationError(`Missing permission: ${p}`);
      },
    }),
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

type FakeDb = ReturnType<typeof import("./helpers/inmemory-db").createFakeDb>;
const db = () => (globalThis as Record<string, unknown>).__faqsRouteDb as FakeDb;
const req = (url: string) => new NextRequest(`http://localhost${url}`);

beforeEach(() => {
  const stores = db()._stores as Record<string, unknown[]>;
  for (const k of Object.keys(stores)) stores[k].length = 0;
});

describe("GET /api/faqs", () => {
  it("بيرجّع أسئلة المساحة بس — مش أسئلة مساحة تانية", async () => {
    await db().faq.create({ data: { workspaceId: WS, question: "التوصيل؟", answer: "يومين" } } as never);
    await db().faq.create({ data: { workspaceId: OTHER, question: "سر؟", answer: "لا" } } as never);
    const res = await faqsGET(req("/api/faqs?limit=200"), { params: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { question: string }[] };
    expect(body.items.map((f) => f.question)).toEqual(["التوصيل؟"]);
  });

  it("المساحة الفاضية = قائمة فاضية (مش خطأ)", async () => {
    const res = await faqsGET(req("/api/faqs"), { params: {} });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });
});
