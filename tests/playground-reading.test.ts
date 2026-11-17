/**
 * 3.5د — «شو قرأ النظام» بصفحة التجربة: القارئ على محادثة التجربة بلا أي كتابة (ولا طلب ولا مسودة ولا عميل)،
 * ومعزول بمساحته، والفلتر المجاني بيمنع نداء الذكاء لمحادثة مش شبه طلب.
 * ⚠️ قاعدة بالذاكرة — سلوك لا PostgreSQL حقيقي.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import type { AIProvider, StructuredRequest } from "@/modules/ai/provider";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { orderReadingSchema } from "@/modules/orders/reader/schema";
import { readPlaygroundSession } from "@/modules/orders/reader/playground-reading";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;
const WS = "ws-pg-read";
const WS_B = "ws-pg-read-b";
let db: FakeDb;
let calls = 0;

function provider(): AIProvider {
  return {
    name: "fake",
    delivery: "local",
    async generateText() {
      throw new Error("no");
    },
    async generateStructured<T>(req: StructuredRequest<T>) {
      calls += 1;
      const out = orderReadingSchema.parse({
        intent: "ORDERING",
        relation: "NEW",
        items: [{ productRef: "ماء الكمأ", quantity: 2, evidence: ["m1"] }],
        customer: { name: null, phone: "0964123348", altPhone: null, city: "درعا", address: "شارع (أ)", evidence: { phone: ["m1"], address: ["m1"] } },
        agreement: { state: "EXPLICIT", evidence: ["m1"] },
        cancelRequested: false,
        notes: null,
        openQuestions: [],
        aiClaimedConfirmed: false,
        needsHuman: { value: false, reason: null },
        memories: [],
        confidence: 0.9,
      });
      const v = req.validate(out);
      if (!v.ok) throw new Error(`invalid: ${v.error}`);
      return { value: v.value, text: "{}", promptTokens: 1, completionTokens: 1, latencyMs: 1 };
    },
  };
}

async function session(ws: string, texts: string[]) {
  const s = (await db.playgroundSession.create({ data: { workspaceId: ws } } as never)) as { id: string };
  let t = Date.now() - 60_000;
  for (const [i, text] of texts.entries()) {
    t += 1000;
    await db.playgroundMessage.create({ data: { sessionId: s.id, workspaceId: ws, role: i % 2 === 0 ? "user" : "assistant", text, createdAt: new Date(t) } } as never);
  }
  return s.id;
}
const counts = () => ({
  orders: (db._stores.order as unknown[]).length,
  drafts: (db._stores.orderDraft as unknown[]).length,
  customers: (db._stores.customer as unknown[]).length,
  conversations: (db._stores.conversation as unknown[]).length,
});

beforeEach(async () => {
  db = createFakeDb() as FakeDb;
  calls = 0;
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
  await createProduct(db as never, { userId: "u1", workspaceId: WS }, { name: "ماء الكمأ", sku: "TW-500", price: 15, currency: "USD" });
});

describe("readPlaygroundSession", () => {
  it("محادثة شبه طلب ← بطاقة مقروءة، وبلا أي كتابة (طلب · مسودة · عميل · محادثة)", async () => {
    const id = await session(WS, ["بدي 2 ماء الكمأ 0964123348 درعا شارع (أ) أكيد ثبّتوا", "تمام، ثبّتنا الطلب"]);
    const before = counts();
    const r = await readPlaygroundSession(db as Db, { workspaceId: WS, sessionId: id }, { provider: provider() });
    expect(r.decision.read).toBe(true);
    expect(r.reading).toMatchObject({ stage: "COMPLETE" });
    expect(r.reading!.items.map((i) => [i.name, i.quantity])).toEqual([["ماء الكمأ", 2]]);
    expect(r.reading!.recipient.phone).toBe("0964123348");
    expect(calls).toBe(1);
    expect(counts()).toEqual(before);
  });

  it("محادثة مش شبه طلب ← الفلتر المجاني بيمنع نداء الذكاء (reading = null)", async () => {
    const id = await session(WS, ["مرحبا", "أهلا وسهلا"]);
    const r = await readPlaygroundSession(db as Db, { workspaceId: WS, sessionId: id }, { provider: provider() });
    expect(r).toEqual({ decision: { read: false, reason: "NOTHING_ORDER_LIKE" }, reading: null });
    expect(calls).toBe(0);
  });

  it("جلسة مساحة تانية أو مجهولة = 404 ولا نداء ذكاء", async () => {
    const other = await session(WS_B, ["بدي ماء الكمأ"]);
    await expect(readPlaygroundSession(db as Db, { workspaceId: WS, sessionId: other }, { provider: provider() })).rejects.toMatchObject({ statusCode: 404 });
    await expect(readPlaygroundSession(db as Db, { workspaceId: WS, sessionId: "nope" }, { provider: provider() })).rejects.toMatchObject({ statusCode: 404 });
    expect(calls).toBe(0);
  });
});

describe("المسار والواجهة", () => {
  it("المسار POST بصلاحية ai.configure وبحد طلبات، والزر موجود بالتجربة", () => {
    const route = readFileSync("src/app/api/ai/playground/sessions/[id]/reading/route.ts", "utf8");
    expect(route).toContain('permission: "ai.configure"');
    expect(route).toMatch(/rateLimit: \{ limit: 10/);
    expect(readFileSync("src/app/(dashboard)/ai/playground/page.tsx", "utf8")).toContain("<ReadingCard");
    expect(readFileSync("src/app/(dashboard)/ai/playground/reading-card.tsx", "utf8")).toContain("شو قرأ النظام");
  });
});
