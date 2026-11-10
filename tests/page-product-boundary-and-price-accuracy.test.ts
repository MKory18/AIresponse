/**
 * Goal 1: a page only "knows" products currently active in its catalog.
 * Goal 2: prices, specs and catalog data stay accurate in replies.
 *
 * In-memory DB and mock provider: behaviour only, not production latency.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct, updateProduct } from "@/modules/products/service";
import { productInputSchema, productUpdateSchema } from "@/modules/products/schemas";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import {
  buildCatalogBoundary,
  createRecallGuard,
  loadRecallGuard,
  scrubRecalledHistory,
  scrubRecalledText,
} from "@/modules/ai/catalog-boundary";
import { buildAIContext } from "@/modules/ai/context-builder";
import { canonicalCurrency, detectCurrencies, priceAmountsIn, validateResponse } from "@/modules/ai/guardrails";
import { trustedDataPrompt } from "@/modules/ai/prompts";
import { catalogProductIds } from "@/modules/catalog/service";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { handleOrderIntent } from "@/modules/orders/intelligence";
import { buildSalesPlan } from "@/modules/sales/plan-builder";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

type Db = Prisma.TransactionClient;
const WS = "ws-recall";
const AGENT = { userId: "agent-recall", workspaceId: WS };
const REMOVED = "زيت الكمأة المحذوف";
const INSIDE = "ماء الورد الطبيعي";

let db: ReturnType<typeof createFakeDb>;
const asDb = () => db as unknown as Db;
let counter = 0;

beforeEach(() => {
  db = createFakeDb();
  setMockAIProvider(undefined);
});

afterEach(() => {
  setMockAIProvider(undefined);
  setFacebookClientFactory(undefined as never);
});

async function product(name: string, sku: string, extra: Record<string, unknown> = {}) {
  return (await createProduct(asDb(), AGENT, { name, sku, price: 25, currency: "USD", ...extra } as never)) as unknown as {
    id: string;
    name: string;
    sku: string;
  };
}

/** A connected page; `catalogIds` null means the workspace has no catalogs at all. */
async function makePage(catalogIds: string[] | null) {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", externalId: "page-1", sendMode: "AUTO_REPLY" },
  } as never)) as { id: string };
  await db.channelAccount.create({
    data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-1", pageName: "صفحة", encryptedCredentials: encryptSecret("tok") },
  } as never);
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string) => {
          if (new URL(url).pathname.includes("/messages")) {
            return Response.json({ recipient_id: "psid-1", message_id: `mid-${Date.now()}-${counter++}` });
          }
          return Response.json({ id: "p", name: "p" });
        }) as typeof fetch,
      })
  );
  if (catalogIds) {
    const catalog = (await db.catalog.create({ data: { workspaceId: WS, name: "كتالوج", isActive: true } } as never)) as { id: string };
    await db.catalogPageAssignment.create({ data: { workspaceId: WS, catalogId: catalog.id, channelId: ch.id } } as never);
    for (const productId of catalogIds) {
      await db.catalogProduct.create({ data: { catalogId: catalog.id, productId } } as never);
    }
  }
  await db.aISettings.create({
    data: { workspaceId: WS, provider: "mock", temperature: 0.4, maxTokens: 500, aiEnabled: true, autoRespond: true },
  } as never);
  return ch.id;
}

async function runTurn(
  channelId: string,
  text: string,
  opts: {
    intent?: string;
    entities?: Record<string, unknown>;
    respond?: string;
    seed?: (conversationId: string, customerId: string) => Promise<void>;
  } = {}
) {
  const n = counter++;
  const inbound = await processIncomingMessage(asDb(), {
    workspaceId: WS,
    channelType: "FACEBOOK",
    channelId,
    externalUserId: "psid-1",
    externalConversationId: "psid-1",
    externalMessageId: `m-${n}`,
    externalEventId: `e-${n}`,
    provider: "facebook",
    type: "TEXT",
    text,
  });
  const conversation = (await db.conversation.findUnique({ where: { id: inbound.conversationId } })) as unknown as { customerId: string };
  await opts.seed?.(inbound.conversationId, conversation.customerId);

  const systems: string[] = [];
  const users: string[] = [];
  const mock = new MockAIProvider();
  mock.intentHandler = (u: string) => {
    users.push(u);
    return {
      intent: opts.intent ?? "PRODUCT_QUESTION",
      confidence: 0.9,
      entities: opts.entities ?? {},
      missingFields: [],
      memories: [],
      requestedAction: "ANSWER",
    };
  };
  mock.responseHandler = (u: string, s: string) => {
    users.push(u);
    systems.push(s);
    return opts.respond ?? "أهلا فيك";
  };
  setMockAIProvider(mock);
  const res = await processAIMessage(
    asDb(),
    { conversationId: inbound.conversationId, messageId: inbound.messageId, workspaceId: WS },
    { vectorStore: { size: 0, search: async () => [] } as never }
  );
  return { res, system: systems.join("\n"), user: users.join("\n") };
}

/** Old history row, written directly so no AI job is pending for it. */
async function seedHistory(conversationId: string, text: string, ageSeconds: number, senderType = "CUSTOMER") {
  await db.message.create({
    data: {
      workspaceId: WS,
      conversationId,
      direction: senderType === "CUSTOMER" ? "INBOUND" : "OUTBOUND",
      senderType,
      text,
      isNote: false,
      deletedAt: null,
      // A day old: past the ordering guard's "fresh older sibling" window.
      createdAt: new Date(Date.now() - 86_400_000 - ageSeconds * 1000),
    },
  } as never);
}

describe("Goal 1 item 1: open drafts cannot outlive the catalog", () => {
  const extraction = (intent: string) =>
    ({ intent, confidence: 0.95, language: "ar", entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER" }) as never;

  async function customer(phone = "0931111222") {
    return (await db.customer.create({ data: { workspaceId: WS, name: "زبون", phone, status: "INTERESTED" } } as never)) as { id: string };
  }

  async function readyDraft(conversationId: string, customerId: string, productName: string) {
    const result = await updateDraftFromExtraction(asDb(), {
      workspaceId: WS,
      conversationId,
      customerId,
      extraction: { productName, quantity: 2, phone: "0931111222", rawAddress: "دمشق المزة" },
      source: "TEST",
    });
    expect(result.draft.state).toBe("READY");
    return result.draft;
  }

  it("a READY draft for a removed product is not confirmed, and keeps the contact fields", async () => {
    const removed = await product(REMOVED, "OIL-1");
    const inside = await product(INSIDE, "ROSE-1");
    const c = await customer();
    const draft = await readyDraft("conv-a", c.id, removed.name);

    const result = await handleOrderIntent(asDb(), {
      workspaceId: WS,
      conversationId: "conv-a",
      customerId: c.id,
      extraction: extraction("ORDER_CREATE"),
      customerText: "نعم",
      allowedProductIds: [inside.id],
    });

    expect(result.action).not.toBe("ORDER_CONFIRMED");
    expect(await db.order.count({ where: { workspaceId: WS } } as never)).toBe(0);
    expect(result.summaryText ?? "").not.toContain(REMOVED);
    const after = (await db.orderDraft.findUnique({ where: { id: draft.id } })) as unknown as Record<string, unknown>;
    expect(after.productId).toBeNull();
    expect(after.productName).toBeNull();
    expect(after.state).toBe("COLLECTING");
    expect(after.phone).toBe("0931111222");
    expect(after.rawAddress).toBe("دمشق المزة");
  });

  it("an unassigned page (empty allowed set) cannot confirm either", async () => {
    const removed = await product(REMOVED, "OIL-1");
    const c = await customer();
    await readyDraft("conv-b", c.id, removed.name);
    const result = await handleOrderIntent(asDb(), {
      workspaceId: WS,
      conversationId: "conv-b",
      customerId: c.id,
      extraction: extraction("UNKNOWN"),
      customerText: "نعم",
      allowedProductIds: [],
    });
    expect(result.action).not.toBe("ORDER_CONFIRMED");
    expect(await db.order.count({ where: { workspaceId: WS } } as never)).toBe(0);
  });

  it("the which-order question never names the removed product", async () => {
    const removed = await product(REMOVED, "OIL-1");
    const a = await product(INSIDE, "ROSE-1");
    const b = await product("عسل السدر الجبلي", "HONEY-1");
    const c = await customer();
    await readyDraft("conv-c", c.id, removed.name);
    await readyDraft("conv-c", c.id, a.name);
    await readyDraft("conv-c", c.id, b.name);

    const result = await handleOrderIntent(asDb(), {
      workspaceId: WS,
      conversationId: "conv-c",
      customerId: c.id,
      extraction: extraction("ORDER_CREATE"),
      customerText: "نعم",
      allowedProductIds: [a.id, b.id],
    });
    expect(result.action).toBe("ASK_MISSING_FIELD");
    expect(result.summaryText).toContain(INSIDE);
    expect(result.summaryText).not.toContain(REMOVED);
  });

  it("no catalogs (undefined allowed set) keeps confirming as before", async () => {
    const removed = await product(REMOVED, "OIL-1");
    const c = await customer();
    await readyDraft("conv-d", c.id, removed.name);
    const result = await handleOrderIntent(asDb(), {
      workspaceId: WS,
      conversationId: "conv-d",
      customerId: c.id,
      extraction: extraction("ORDER_CREATE"),
      customerText: "نعم",
    });
    expect(result.action).toBe("ORDER_CONFIRMED");
  });
});

describe("Goal 1 item 2: cross-sell stays inside the page", () => {
  it("buildSalesPlan drops complementary products outside the allowed set", async () => {
    const outside = await product(REMOVED, "OIL-1");
    const inside = await product("عسل السدر الجبلي", "HONEY-1");
    const main = await product(INSIDE, "ROSE-1");
    const row = { ...(await db.product.findUnique({ where: { id: main.id } })), complementarySkus: [outside.sku, inside.sku] };

    const plan = await buildSalesPlan(asDb(), {
      workspaceId: WS,
      intent: "PRICE_QUESTION",
      product: row as never,
      allowedProductIds: [main.id, inside.id],
      recordEvents: false,
    } as never);
    expect(plan.crossSell.map((c) => c.sku)).toEqual([inside.sku]);
  });

  it("the reply prompt never carries the outside product's name", async () => {
    const outside = await product(REMOVED, "OIL-1", { price: 77777 });
    const main = await product(INSIDE, "ROSE-1");
    await db.product.update({ where: { id: main.id }, data: { complementarySkus: [outside.sku] } } as never);
    const channelId = await makePage([main.id]);
    const { system } = await runTurn(channelId, `بكم ${INSIDE}؟`, { intent: "PRICE_QUESTION", entities: { product: INSIDE } });
    expect(system).toContain(INSIDE);
    expect(system).not.toContain(REMOVED);
    expect(system).not.toContain("77777");
  });
});

describe("Goal 1 items 3-5: recall guard", () => {
  const guard = () => createRecallGuard({ outsideNames: [REMOVED, "زيت", "عسل", "ab"], allowedNames: [INSIDE, "زيت الزيتون"] });

  it("removes only the sentence mentioning an outside name", () => {
    expect(scrubRecalledText(guard(), `اهتم بـ${REMOVED} كثيرًا. يسكن بدمشق.`)).toBe("يسكن بدمشق.");
    expect(scrubRecalledText(guard(), `سطر عن ${REMOVED}\nسطر سليم`)).toBe("سطر سليم");
  });

  it("returns untouched text when nothing matches", () => {
    const text = "يسكن بدمشق.  بيحب   العطور";
    expect(scrubRecalledText(guard(), text)).toBe(text);
  });

  it("normalizes hamza, ta marbuta and diacritics", () => {
    const g = createRecallGuard({ outsideNames: ["ماء الكمأة"], allowedNames: [] });
    expect(scrubRecalledText(g, "بدي ماء الكماه")).toBe("");
    expect(scrubRecalledText(g, "بدي مَاءْ الكمأة")).toBe("");
  });

  it("matches attached Arabic particles but not longer words", () => {
    expect(scrubRecalledText(guard(), "بالعسل")).toBe("");
    expect(scrubRecalledText(guard(), "معسل تفاحتين")).toBe("معسل تفاحتين");
  });

  it("skips very short names", () => {
    expect(scrubRecalledText(guard(), "ab cd")).toBe("ab cd");
  });

  it("does not remove a name that is also an allowed product's name", () => {
    const g = createRecallGuard({ outsideNames: [INSIDE], allowedNames: [INSIDE] });
    expect(scrubRecalledText(g, `بدي ${INSIDE}`)).toBe(`بدي ${INSIDE}`);
  });

  it("does not trip on an outside name inside an allowed product's name", () => {
    expect(scrubRecalledText(guard(), "بدي زيت الزيتون")).toBe("بدي زيت الزيتون");
    expect(scrubRecalledText(guard(), "بدي زيت")).toBe("");
  });

  it("drops whole history messages but keeps the current one", () => {
    const rows = [
      { id: "1", text: `بدي ${REMOVED}` },
      { id: "2", text: "مرحبا" },
      { id: "3", text: `بكم ${REMOVED}؟` },
      { id: "4", text: null },
    ];
    expect(scrubRecalledHistory(guard(), rows, "3").map((r) => r.id)).toEqual(["2", "3", "4"]);
  });

  it("is a no-op with no guard", () => {
    expect(scrubRecalledText(null, REMOVED)).toBe(REMOVED);
    expect(scrubRecalledHistory(null, [{ id: "1", text: REMOVED }])).toHaveLength(1);
  });

  it("loadRecallGuard returns null in no-catalog mode", async () => {
    await product(REMOVED, "OIL-1");
    expect(await loadRecallGuard(asDb(), WS, undefined)).toBeNull();
  });

  it("loadRecallGuard blocks archived and unlinked products, never allowed ones", async () => {
    const inside = await product(INSIDE, "ROSE-1");
    await product(REMOVED, "OIL-1");
    const g = await loadRecallGuard(asDb(), WS, [inside.id]);
    expect(scrubRecalledText(g, `بدي ${REMOVED}`)).toBe("");
    expect(scrubRecalledText(g, `بدي ${INSIDE}`)).toBe(`بدي ${INSIDE}`);
  });

  async function seedRecall(conversationId: string, customerId: string) {
    await db.customerMemory.create({
      data: { workspaceId: WS, customerId, type: "FACT", key: "k1", value: `مهتم بـ${REMOVED}`, source: "t", confidence: 0.9 },
    } as never);
    await db.customerMemory.create({
      data: { workspaceId: WS, customerId, type: "FACT", key: "k2", value: "يسكن بدمشق", source: "t", confidence: 0.9 },
    } as never);
    await db.conversation.update({
      where: { id: conversationId },
      data: { summary: `اهتم بـ${REMOVED}. ينقصه العنوان.` },
    } as never);
    await seedHistory(conversationId, `بدي ${REMOVED}`, 300);
    await seedHistory(conversationId, `سعر ${REMOVED} 90 دولار`, 200, "AI");
    await seedHistory(conversationId, "صباح الخير", 100);
  }

  it("memory, summary and history never reach the model for a removed product", async () => {
    const inside = await product(INSIDE, "ROSE-1");
    await product(REMOVED, "OIL-1");
    const channelId = await makePage([inside.id]);
    const { system, user } = await runTurn(channelId, "شو عندكم؟", { seed: seedRecall });
    expect(system).not.toContain(REMOVED);
    expect(user).not.toContain(REMOVED);
    expect(system).toContain("يسكن بدمشق");
    expect(system).toContain("ينقصه العنوان");
    expect(user).toContain("صباح الخير");
  });

  it("the current customer message stays even if it names the removed product", async () => {
    const inside = await product(INSIDE, "ROSE-1");
    await product(REMOVED, "OIL-1");
    const channelId = await makePage([inside.id]);
    const { user } = await runTurn(channelId, `بكم ${REMOVED}؟`);
    expect(user).toContain(`بكم ${REMOVED}؟`);
  });

  it("stored data is not touched", async () => {
    const inside = await product(INSIDE, "ROSE-1");
    await product(REMOVED, "OIL-1");
    const channelId = await makePage([inside.id]);
    await runTurn(channelId, "شو عندكم؟", { seed: seedRecall });
    const rows = (await db.customerMemory.findMany({ where: { workspaceId: WS } } as never)) as unknown as { value: string }[];
    expect(rows.map((r) => r.value)).toContain(`مهتم بـ${REMOVED}`);
  });

  it("no-catalog mode keeps memory, summary and history as they are", async () => {
    await product(REMOVED, "OIL-1");
    const channelId = await makePage(null);
    const { system, user } = await runTurn(channelId, "شو عندكم؟", { seed: seedRecall });
    expect(system).toContain(`مهتم بـ${REMOVED}`);
    expect(system).toContain(`اهتم بـ${REMOVED}`);
    expect(user).toContain(`بدي ${REMOVED}`);
  });
});

describe("Goal 1 item 6: media fallback respects the boundary", () => {
  const store = { size: 0, search: async () => [] } as never;

  async function asset() {
    return (await db.mediaAsset.create({
      data: { workspaceId: WS, type: "IMAGE", category: "PRODUCT", url: "https://x/y.jpg", title: "صورة الكمأة" },
    } as never)) as { id: string };
  }

  it("a catalog page with no resolved product gets no media", async () => {
    await asset();
    const ctx = await buildAIContext(asDb(), store, { workspaceId: WS, query: "الكمأة", allowedProductIds: ["p-inside"] });
    expect(ctx.media).toEqual([]);
    expect(ctx.citations.filter((c) => c.sourceType === "MEDIA")).toEqual([]);
  });

  it("no-catalog mode keeps the search fallback", async () => {
    const a = await asset();
    const ctx = await buildAIContext(asDb(), store, { workspaceId: WS, query: "الكمأة" });
    expect(ctx.media.map((m) => m.id)).toEqual([a.id]);
  });
});

describe("Goal 1 item 7: linked but inactive products leave the allowed set", () => {
  it("catalogProductIds keeps only active, non-archived products in link order", async () => {
    const live = await product(INSIDE, "A-1");
    const archived = await product("منتج مؤرشف", "A-2");
    const inactive = await product("منتج موقوف", "A-3");
    const second = await product("منتج ثاني", "A-4");
    await db.product.update({ where: { id: archived.id }, data: { isArchived: true } } as never);
    await db.product.update({ where: { id: inactive.id }, data: { isActive: false } } as never);
    const catalog = (await db.catalog.create({ data: { workspaceId: WS, name: "ك", isActive: true } } as never)) as { id: string };
    for (const [i, p] of [live, archived, inactive, second].entries()) {
      await db.catalogProduct.create({ data: { catalogId: catalog.id, productId: p.id, sortOrder: i } } as never);
    }
    expect(await catalogProductIds(asDb(), WS, catalog.id)).toEqual([live.id, second.id]);
  });
});

describe("Goal 1 item 8: name-list cap never hides active products", () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `منتج رقم ${i + 1}`);

  it("lists more than 40 names", () => {
    expect(buildCatalogBoundary(names(50))).toContain("منتج رقم 50");
  });

  it("an over-long list is worded as non-exhaustive and declares nothing unavailable", () => {
    const text = buildCatalogBoundary(names(1000));
    expect(text).toContain("ليست كاملة");
    expect(text).not.toContain("غير متاح");
    expect(text).not.toContain("غير متوفر حاليًا");
  });

  it("the pipeline passes every active product past the old cap", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 45; i++) ids.push((await product(`منتج رقم ${i}`, `S-${i}`)).id);
    const channelId = await makePage(ids);
    const { system } = await runTurn(channelId, "شو عندكم؟");
    expect(system).toContain("منتج رقم 45");
  });
});

describe("Goal 2 a-c: price guardrail", () => {
  const ctx = (price: string, currency = "USD", extra: Record<string, unknown> = {}) =>
    ({
      product: {
        id: "p1", name: "منتج", sku: "S", price, currency, compareAtPrice: null, stockStatus: "IN_STOCK",
        shortDescription: null, description: null, benefits: [], usage: null, warnings: null, ingredients: null,
        objections: [], salesNotes: null, faqs: [], priceTiers: [], ...extra,
      },
      knowledge: { faqs: [], documents: [] },
      media: [],
      feedback: [],
      citations: [],
    }) as never;
  const violations = (response: string, c: never) => validateResponse({ response, context: c }).violations;

  it("compares numerically: a moved decimal point is a different price", () => {
    expect(violations("السعر 2.5 USD", ctx("25"))).toContain("PRICE_MISMATCH");
    expect(violations("السعر 255 USD", ctx("25.5"))).toContain("PRICE_MISMATCH");
  });

  it("equal values pass in any notation", () => {
    expect(violations("السعر 25.00 USD", ctx("25"))).toEqual([]);
    expect(violations("السعر 25.5 USD", ctx("25.50"))).toEqual([]);
    expect(violations("السعر ٢٥٠٠٠ ل.س", ctx("25000", "SYP"))).toEqual([]);
    expect(violations("السعر 150.000 ل.س", ctx("150000", "SYP"))).toEqual([]);
    expect(violations("السعر 1,500,000 ل.س", ctx("1500000", "SYP"))).toEqual([]);
    expect(violations("السعر 25,5 USD", ctx("25.5"))).toEqual([]);
  });

  it.each(["سعره 40", "بسعر 40", "ثمنه 40", "تكلفته 40", "بـ 40", "بـ40", "السعر: 40", "سعر الحبة 40", "السعر هو 40"])(
    "catches a wrong price after a price word: %s",
    (text) => {
      expect(violations(text, ctx("25"))).toContain("PRICE_MISMATCH");
    }
  );

  it.each(["سعره 25", "بـ 25", "ثمنها 25"])("the right price after a price word passes: %s", (text) => {
    expect(violations(text, ctx("25"))).toEqual([]);
  });

  it("thousand-scale forms are read as their full value", () => {
    expect(violations("سعره 25 ألف ليرة", ctx("150000", "SYP"))).toContain("PRICE_MISMATCH");
    expect(violations("سعره 150 ألف ليرة", ctx("150000", "SYP"))).toEqual([]);
    expect(violations("150 الف ل.س", ctx("150000", "SYP"))).toEqual([]);
    expect(violations("السعر 1.5 مليون ليرة", ctx("1500000", "SYP"))).toEqual([]);
    expect(violations("سعره 25 ألف", ctx("25000", "SYP"))).toEqual([]);
  });

  it.each([
    "حجمه 50 مل",
    "سعر 3 حبات مناسب",
    "بـ 50 مل",
    "بـ 3 أيام بيوصلك",
    "بـ 20% خصم",
    "سعره 0933123456",
    "بـ 15/10 بيوصل",
    "بـ 15 تشرين بيوصل",
    "تمام 3 حبات",
  ])("does not flag non-prices: %s", (text) => {
    expect(violations(text, ctx("25"))).toEqual([]);
  });

  it("a price word with no product context is an invented price", () => {
    expect(violations("سعره 40", { ...(ctx("25") as object), product: undefined } as never)).toContain("UNSUPPORTED_PRICE");
  });

  it("a quantity is not allowed as a price next to a currency", async () => {
    const main = await product(INSIDE, "ROSE-1");
    const channelId = await makePage([main.id]);
    const { res } = await runTurn(channelId, `بكم 3 من ${INSIDE}؟`, {
      intent: "PRICE_QUESTION",
      entities: { product: INSIDE, quantity: 3 },
      respond: "سعره 3 USD",
    });
    expect(res.status).toBe("AI_FAILED");
    expect(res.error).toContain("PRICE_MISMATCH");
  });

  it("the plan's real figures still pass", async () => {
    const main = await product(INSIDE, "ROSE-1");
    const channelId = await makePage([main.id]);
    const { res } = await runTurn(channelId, `بكم 3 من ${INSIDE}؟`, {
      intent: "PRICE_QUESTION",
      entities: { product: INSIDE, quantity: 3 },
      respond: "السعر 25 USD والإجمالي 75 USD",
    });
    expect(res.status).not.toBe("AI_FAILED");
  });
});

describe("Goal 2 d-e: product block in the prompt", () => {
  it("shows the currency once and on customer-facing tiers, keeps wholesale out", async () => {
    const main = await product(INSIDE, "ROSE-1", {
      priceTiers: [
        { label: "عرض الأربعاء", price: "9" },
        { label: "سعر الجملة", price: "8" },
      ],
    });
    const channelId = await makePage([main.id]);
    const { system } = await runTurn(channelId, `شو ${INSIDE}؟`, { entities: { product: INSIDE } });
    expect(system).toContain("السعر الرسمي: 25 USD");
    expect(system).not.toContain("USD USD");
    expect(system).toContain("عرض الأربعاء 9 USD");
    expect(system).not.toContain("سعر الجملة");
  });

  it("passes description, ingredients and compare-at price, trimmed", async () => {
    const description = "وصف تفصيلي للمنتج ".repeat(200);
    const main = await product(INSIDE, "ROSE-1", {
      description,
      ingredients: "ماء ورد مقطر وزيت اللوز",
      compareAtPrice: 40,
    });
    const channelId = await makePage([main.id]);
    const { system } = await runTurn(channelId, `شو ${INSIDE}؟`, { entities: { product: INSIDE } });
    expect(system).toContain(description.slice(0, 200));
    expect(system).not.toContain(description);
    expect(system).toContain("ماء ورد مقطر وزيت اللوز");
    expect(system).toContain("40 USD");
  });

  it("omits a compare-at price that is not above the price", () => {
    const text = trustedDataPrompt({
      product: {
        name: "منتج", price: "25", currency: "USD", compareAtPrice: "20", stockStatus: "IN_STOCK",
        shortDescription: null, benefits: [], usage: null, warnings: null, objections: [], salesNotes: null, faqs: [],
      },
    } as never);
    expect(text).not.toContain("20 USD");
  });
});

describe("Goal 2 f: price validation", () => {
  const base = { name: "منتج", sku: "S1" };

  it("allows at most 2 decimals", () => {
    expect(productInputSchema.safeParse({ ...base, price: "12.345" }).success).toBe(false);
    expect(productInputSchema.safeParse({ ...base, price: "12.34" }).success).toBe(true);
    expect(productInputSchema.safeParse({ ...base, price: 1, priceTiers: [{ label: "عرض", price: "1.234" }] }).success).toBe(false);
  });

  it("requires compareAtPrice above price, with an error on that field", () => {
    const low = productInputSchema.safeParse({ ...base, price: 25, compareAtPrice: 25 });
    expect(low.success).toBe(false);
    if (!low.success) expect(low.error.issues[0].path).toEqual(["compareAtPrice"]);
    expect(productInputSchema.safeParse({ ...base, price: 25, compareAtPrice: 30 }).success).toBe(true);
    expect(productInputSchema.safeParse({ ...base, price: 25, compareAtPrice: null }).success).toBe(true);
  });

  it("applies to updates carrying both fields", () => {
    expect(productUpdateSchema.safeParse({ price: 25, compareAtPrice: 20 }).success).toBe(false);
    expect(productUpdateSchema.safeParse({ price: 25, compareAtPrice: 30 }).success).toBe(true);
    expect(productUpdateSchema.safeParse({ compareAtPrice: 30 }).success).toBe(true);
    expect(productUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("updateProduct checks a partial update against the stored price", async () => {
    const p = await product(INSIDE, "ROSE-1");
    await expect(updateProduct(asDb(), AGENT, p.id, { compareAtPrice: 20 })).rejects.toMatchObject({ code: "INVALID_COMPARE_AT_PRICE" });
    await expect(updateProduct(asDb(), AGENT, p.id, { compareAtPrice: 30 })).resolves.toBeTruthy();
    await expect(updateProduct(asDb(), AGENT, p.id, { price: 35 })).rejects.toMatchObject({ code: "INVALID_COMPARE_AT_PRICE" });
    await expect(updateProduct(asDb(), AGENT, p.id, { compareAtPrice: null, price: 35 })).resolves.toBeTruthy();
    await expect(updateProduct(asDb(), AGENT, p.id, { name: "اسم جديد" })).resolves.toBeTruthy();
  });
});

describe("Goal 2 g: catalog page is null-safe", () => {
  const page = () => readFileSync(join(process.cwd(), "src/app/(dashboard)/catalogs/[id]/page.tsx"), "utf8");

  it("never dereferences a missing product or channel", () => {
    const src = page();
    expect(src).not.toContain("p.product.id");
    expect(src).toMatch(/product:\s*\{[\s\S]*?\}\s*\|\s*null/);
    expect(src).toMatch(/channel:\s*\{[^}]*\}\s*\|\s*null/);
    expect(src).not.toContain("{pg.channel.displayName}");
    expect(src).not.toContain("pg.channel.id");
    expect(src).toContain("p?.name");
  });
});

const violations = (response: string, c: never) => validateResponse({ response, context: c }).violations;
const ctx = (price: string, currency = "USD") =>
  ({
    product: {
      id: "p1", name: "منتج", sku: "S", price, currency, compareAtPrice: null, stockStatus: "IN_STOCK",
      shortDescription: null, description: null, benefits: [], usage: null, warnings: null, ingredients: null,
      objections: [], salesNotes: null, faqs: [], priceTiers: [],
    },
    knowledge: { faqs: [], documents: [] },
    media: [],
    feedback: [],
    citations: [],
  }) as never;

describe("Part 0: currency tokens have real boundaries", () => {
  it.each(["لسا", "لسا ما وصل الطلب", "لسه بدك شي", "جلسة تجميل", "فلسطين", "سلسلة"])(
    "ordinary word is not ل.س: %s",
    (text) => {
      expect(detectCurrencies(text).size).toBe(0);
    }
  );

  it("an ordinary «لسا» reply no longer raises CURRENCY_MISMATCH", () => {
    expect(violations("لسا عنا منه، بتحب أحجزلك؟", ctx("25"))).toEqual([]);
  });

  it("«5 لسا» is not read as a price", () => {
    expect(priceAmountsIn("بقي 5 لسا")).toEqual([]);
  });

  it.each(["100 ل.س", "100ل.س", "١٠٠ ل.س.", "الله يخليك 100 ل س", "(100 ل.س)", "5000 ليرة", "ليره", "5000 ليرات", "SYP 100"])(
    "still detects Syrian pounds: %s",
    (text) => {
      expect([...detectCurrencies(text)]).toEqual(["SYP"]);
    }
  );

  it("amounts next to ل.س still count as prices", () => {
    expect(priceAmountsIn("السعر 5000 ل.س")).toEqual([5000]);
    expect(priceAmountsIn("5000ل.س")).toEqual([5000]);
  });

  it("the stored currency «ل.س» still canonicalizes", () => {
    expect(canonicalCurrency("ل.س")).toBe("SYP");
  });

  it.each(["we made it", "the buyer is happy", "layer of foam", "madam"])(
    "English word is not an ISO currency: %s",
    (text) => {
      expect(detectCurrencies(text).size).toBe(0);
    }
  );

  it("real ISO codes still count, attached to digits or not", () => {
    expect([...detectCurrencies("20 MAD")]).toEqual(["DIRHAM"]);
    expect([...detectCurrencies("20MAD")]).toEqual(["DIRHAM"]);
    expect([...detectCurrencies("100 usd")]).toEqual(["USD"]);
  });
});

describe("Part 0: amounts in the grounded FAQ/knowledge text are allowed", () => {
  const noProduct = (faqs: string[], documents: string[] = []) =>
    ({
      knowledge: {
        faqs: faqs.map((answer, i) => ({ id: `f${i}`, question: "سؤال", answer })),
        documents: documents.map((content, i) => ({ id: `d${i}`, content, score: 1 })),
      },
      feedback: [],
      media: [],
      citations: [],
    }) as never;

  it("a bare price copied from an FAQ answer passes with no product", () => {
    expect(violations("رسوم التوصيل 5 دولار", noProduct(["رسوم التوصيل 5 دولار"]))).toEqual([]);
  });

  it("a price from a knowledge document passes with no product", () => {
    expect(violations("التوصيل بـ 7 دولار", noProduct([], ["التوصيل للمحافظات 7 دولار"]))).toEqual([]);
  });

  it("an FAQ amount written with no price word still counts", () => {
    expect(violations("التوصيل 5 دولار", noProduct(["رسوم التوصيل: 5"]))).toEqual([]);
  });

  it("amounts scaled in the grounded text compare by value", () => {
    expect(violations("التوصيل 25000 ليرة", noProduct(["التوصيل 25 ألف ليرة"]))).toEqual([]);
  });

  it("an amount in no grounded source still fails with no product", () => {
    expect(violations("رسوم التوصيل 9 دولار", noProduct(["رسوم التوصيل 5 دولار"]))).toContain("UNSUPPORTED_PRICE");
  });

  it("no grounded text at all still fails", () => {
    expect(violations("سعره 40", noProduct([]))).toContain("UNSUPPORTED_PRICE");
  });

  it("a duration in the FAQ does not ground a price", () => {
    expect(violations("التوصيل بـ 3 دولار", noProduct(["التوصيل خلال 3 أيام"]))).toContain("UNSUPPORTED_PRICE");
  });

  it("a phone number in the FAQ does not ground a price", () => {
    expect(violations("سعره 933123456 دولار", noProduct(["اتصل على 0933123456"]))).toContain("UNSUPPORTED_PRICE");
  });

  it("the question text does not ground a price: only answers do", () => {
    const context = {
      knowledge: { faqs: [{ id: "f", question: "هل السعر 40؟", answer: "اسأل الموظف" }], documents: [] },
      feedback: [],
      media: [],
      citations: [],
    } as never;
    expect(violations("سعره 40", context)).toContain("UNSUPPORTED_PRICE");
  });

  it("the grounded amount in another currency still fails", () => {
    expect(violations("رسوم التوصيل 5 ليرة", noProduct(["رسوم التوصيل 5 دولار"]))).toContain("UNSUPPORTED_PRICE");
  });

  it("with a product, an FAQ amount passes and an invented one still fails", () => {
    const product = ctx("25") as object;
    const context = { ...product, knowledge: { faqs: [{ id: "f", question: "س", answer: "التوصيل 5 دولار" }], documents: [] } } as never;
    expect(violations("التوصيل 5 دولار", context)).toEqual([]);
    expect(violations("التوصيل 9 دولار", context)).toContain("PRICE_MISMATCH");
  });

  it("with a USD product, an FAQ fee in ليرة is not a currency mismatch; an ungrounded currency still is", () => {
    const product = ctx("25") as object;
    const context = { ...product, knowledge: { faqs: [{ id: "f", question: "س", answer: "التوصيل 5000 ليرة" }], documents: [] } } as never;
    expect(violations("التوصيل 5000 ليرة", context)).toEqual([]);
    expect(violations("السعر 25 درهم", context)).toContain("CURRENCY_MISMATCH");
  });

  it("a legitimate FAQ answer does not end in AI_FAILED through the real pipeline", async () => {
    const channelId = await makePage(null);
    await db.faq.create({
      data: { workspaceId: WS, question: "كم رسوم التوصيل", answer: "رسوم التوصيل 5 دولار", productId: null },
    } as never);
    const { res } = await runTurn(channelId, "كم رسوم التوصيل؟", {
      intent: "DELIVERY_QUESTION",
      respond: "رسوم التوصيل 5 دولار",
    });
    expect(res.status).toBe("RESPONDED");
  });
});
