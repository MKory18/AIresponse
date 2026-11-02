import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { AuthorizationError, AppError, NotFoundError } from "@/core/errors";
import { buildSalesPlan, parseOffers, computeOfferSaving, classifyObjection, isProductAvailable, safeObjectionFallback } from "@/modules/sales/plan-builder";
import { salesPlanSchema, productOfferSchema, MAX_OFFER_PRESSES, MAX_CROSS_SELL } from "@/modules/sales/plan-schemas";
import { recordSalesEvent, offerShownCount, getSalesAnalytics } from "@/modules/sales/metrics";
import { evaluateDiscountPolicy, discountedPrice, requestDiscountApproval, decideDiscountApproval, useDiscountApproval, listDiscountApprovals } from "@/modules/sales/pricing-policy";
import { recordAdSource } from "@/modules/sales/ad-source";
import { buildCoachSuggestions, assertNoWholesaleLeak } from "@/modules/sales/coach";
import { ROLE_PERMISSIONS, PERMISSIONS } from "@/modules/rbac/permissions";

const WS = "ws-p8";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
let mock: MockAIProvider;

const emptyVectors = () => ({ search: async () => [] }) as never;

const ctx = (can: (p: string) => boolean = () => false, userId = "agent-1") => ({
  userId,
  workspaceId: WS,
  can: can as never,
});

async function seedConv(opts: { aiState?: string } = {}) {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "P", externalId: `pg-${Math.random().toString(36).slice(2, 7)}` },
  } as never)) as any;
  await db.channelAccount.create({
    data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: ch.externalId, pageName: "P", encryptedCredentials: encryptSecret("page-token-test") },
  } as never);
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: { body?: string }) => {
          const u = new URL(url as string);
          if (u.pathname.endsWith("/me/messages")) {
            let body: any = null;
            try { body = JSON.parse(String((init as any)?.body ?? "")); } catch { /* ignore */ }
            const rid = body?.recipient?.id ?? "psid";
            return Response.json({ recipient_id: rid, message_id: `mid-${rid}` });
          }
          return Response.json({ id: ch.externalId, name: "P" });
        }) as typeof fetch,
      })
  );
  const cust = (await db.customer.create({
    data: { workspaceId: WS, name: "عميل" },
  } as never)) as any;
  const psid = `psid-${Math.random().toString(36).slice(2, 9)}`;
  await db.channelIdentity.create({
    data: { workspaceId: WS, customerId: cust.id, channelType: "FACEBOOK", channelExternalId: psid, displayName: "عميل" },
  } as never);
  const conv = (await db.conversation.create({
    data: {
      workspaceId: WS, customerId: cust.id, channelId: ch.id,
      channelConversationId: psid,
      status: "OPEN", aiState: opts.aiState ?? "AI_ACTIVE",
      aiEnabled: (opts.aiState ?? "AI_ACTIVE") === "AI_ACTIVE",
      lastCustomerMessageAt: new Date(Date.now() - 120 * 60_000),
    },
  } as never)) as any;
  return { conv, cust, ch };
}

async function seedProduct(extra: Record<string, unknown> = {}) {
  return (await db.product.create({
    data: {
      workspaceId: WS, name: "كريم تعليم", sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
      price: 100, currency: "USD", stockStatus: "IN_STOCK",
      offers: [], complementarySkus: [], objections: [],
      ...extra,
    },
  } as never)) as any;
}

async function seedInbound(text: string, conv: any, cust: any) {
  const res = await processIncomingMessage(db as Db, {
    workspaceId: WS,
    channelType: "FACEBOOK",
    channelId: conv.channelId,
    externalUserId: conv.channelConversationId,
    externalConversationId: conv.channelConversationId,
    externalMessageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    externalEventId: `e-${Math.random().toString(36).slice(2, 8)}`,
    provider: "facebook",
    type: "TEXT",
    text,
  });
  const inbound = (db._stores.message as any[]).find(
    (m) => m.direction === "INBOUND" && m.conversationId === res.conversationId
  );
  return { ...res, messageId: inbound.id };
}

beforeEach(async () => {
  db = createFakeDb();
  (db._stores.workspaceMember as any[]).push({ id: "m1", workspaceId: WS, userId: "agent-1", status: "ACTIVE" });
  mock = new MockAIProvider();
  setMockAIProvider(mock);
  setFacebookClientFactory(undefined as never);
});

// ── 1. Offers: parse + deterministic math ─────────────────────────────────

describe("P8-1 offers: parse + saving math", () => {
  it("parses a valid offer row", () => {
    const row = { title: "عرض الكمية", quantity: 3, price: 250 };
    expect(productOfferSchema.safeParse(row).success).toBe(true);
    expect(parseOffers([row])).toHaveLength(1);
  });

  it("drops malformed rows fail-soft", () => {
    expect(parseOffers([{ title: "x" }])).toHaveLength(0);
    expect(parseOffers("not-array" as never)).toHaveLength(0);
    expect(parseOffers([{ title: "x", quantity: 0, price: 1 }])).toHaveLength(0);
  });

  it("drops expired offers", () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(parseOffers([{ title: "x", quantity: 2, price: 100, expiresAt: past }])).toHaveLength(0);
    expect(parseOffers([{ title: "x", quantity: 2, price: 100, expiresAt: future }])).toHaveLength(1);
  });

  it("saving = unitPrice×qty − price, only when positive", () => {
    expect(computeOfferSaving(100, { title: "o", quantity: 3, price: 250 })).toBe(50);
    expect(computeOfferSaving(100, { title: "o", quantity: 3, price: 300 })).toBeNull();
    expect(computeOfferSaving(100, { title: "o", quantity: 3, price: 350 })).toBeNull();
  });

  it("availability respects stock source-of-truth only", () => {
    expect(isProductAvailable({ isActive: true, stockStatus: "IN_STOCK" })).toBe(true);
    expect(isProductAvailable({ isActive: true, stockStatus: "OUT_OF_STOCK" })).toBe(false);
    expect(isProductAvailable({ isActive: true, stockStatus: "DISCONTINUED" })).toBe(false);
    expect(isProductAvailable({ isActive: false, stockStatus: "IN_STOCK" })).toBe(false);
  });
});

// ── 2. Sales plan builder (deterministic, numbers from DB) ────────────────

describe("P8-2 buildSalesPlan (deterministic, numbers from DB)", () => {
  it("builds primary with computed subtotal and OMS source", async () => {
    const p = await seedProduct({ syncedFromOms: true });
    const plan = await buildSalesPlan(db as unknown as Db, {
      workspaceId: WS, intent: "ORDER_CREATE", product: p, quantity: 2, recordEvents: false,
    });
    expect(plan.primary!.unitPrice).toBe(100);
    expect(plan.primary!.quantity).toBe(2);
    expect(plan.primary!.subtotal).toBe(200);
    expect(plan.primary!.source).toBe("OMS_SYNC");
    expect(salesPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("no product → NO_PRODUCT; bad price → PRICE_UNAVAILABLE; out of stock → PRODUCT_UNAVAILABLE", async () => {
    const none = await buildSalesPlan(db as unknown as Db, {
      workspaceId: WS, intent: "ORDER_CREATE", recordEvents: false,
    });
    expect(none.primary).toBeNull();
    expect(none.noOfferReason).toBe("NO_PRODUCT");

    const bad = await seedProduct({ price: 0 });
    const plan = await buildSalesPlan(db as unknown as Db, {
      workspaceId: WS, intent: "ORDER_CREATE", product: bad, recordEvents: false,
    });
    expect(plan.noOfferReason).toBe("PRICE_UNAVAILABLE");

    const out = await seedProduct({ sku: "SKU-OUT", stockStatus: "OUT_OF_STOCK" });
    const plan2 = await buildSalesPlan(db as unknown as Db, {
      workspaceId: WS, intent: "ORDER_CREATE", product: out, recordEvents: false,
    });
    expect(plan2.noOfferReason).toBe("PRODUCT_UNAVAILABLE");
    expect(plan2.constraints).toContain("PRODUCT_UNAVAILABLE");
  });

  it("best valid offer becomes upsell with recomputed saving + OFFER_QUALIFIED", async () => {
    const p = await seedProduct({
      offers: [
        { title: "قطعتان", quantity: 2, price: 199 },
        { title: "ثلاث", quantity: 3, price: 250, saving: 9999 },
      ],
    });
    const plan = await buildSalesPlan(db as unknown as Db, {
      workspaceId: WS, intent: "ORDER_CREATE", product: p, quantity: 1,
      customerId: "c1", conversationId: "cv1",
    });
    expect(plan.upsell!.title).toBe("ثلاث");
    expect(plan.upsell!.saving).toBe(50); // 100*3 − 250 — raw saving field ignored
    expect(plan.noOfferReason).toBeNull();
    const events = (db._stores.salesEvent as any[]).filter((e) => e.type === "OFFER_QUALIFIED");
    expect(events).toHaveLength(1);
    expect(events[0].sku).toBe(p.sku);
    expect(events[0].value).toBe(50);
  });

  it("offers with no real saving → OFFER_NOT_WORTHWHILE", async () => {
    const p = await seedProduct({ offers: [{ title: "x", quantity: 2, price: 220 }] });
    const plan = await buildSalesPlan(db as unknown as Db, {
      workspaceId: WS, intent: "ORDER_CREATE", product: p, recordEvents: false,
    });
    expect(plan.upsell).toBeNull();
    expect(plan.noOfferReason).toBe("OFFER_NOT_WORTHWHILE");
  });

  it("no offers at all → NO_VALID_OFFERS", async () => {
    const p = await seedProduct({});
    const plan = await buildSalesPlan(db as unknown as Db, {
      workspaceId: WS, intent: "ORDER_CREATE", product: p, recordEvents: false,
    });
    expect(plan.noOfferReason).toBe("NO_VALID_OFFERS");
  });

  it(`press cap: ${MAX_OFFER_PRESSES}× OFFER_SHOWN → OFFER_PRESSED_OUT`, async () => {
    const p = await seedProduct({ offers: [{ title: "عرض", quantity: 3, price: 250 }] });
    const { conv } = await seedConv();
    for (let i = 0; i < MAX_OFFER_PRESSES; i += 1) {
      await recordSalesEvent(db as unknown as Db, { workspaceId: WS, type: "OFFER_SHOWN", conversationId: conv.id, sku: p.sku });
    }
    expect(await offerShownCount(db as unknown as Db, WS, conv.id, p.sku)).toBe(2);
    const plan = await buildSalesPlan(db as unknown as Db, {
      workspaceId: WS, intent: "ORDER_CREATE", product: p,
      conversationId: conv.id, recordEvents: false,
    });
    expect(plan.noOfferReason).toBe("OFFER_PRESSED_OUT");
    expect(plan.constraints).toContain("OFFER_PRESS_CAP");
  });

  it("customer decline → OFFER_DECLINED_BY_CUSTOMER (no more pushing)", async () => {
    const p = await seedProduct({ offers: [{ title: "عرض", quantity: 3, price: 250 }] });
    const { conv } = await seedConv();
    await recordSalesEvent(db as unknown as Db, {
      workspaceId: WS, type: "OFFER_QUALIFIED", conversationId: conv.id, sku: p.sku,
      payload: { declined: true },
    });
    const plan = await buildSalesPlan(db as unknown as Db, {
      workspaceId: WS, intent: "ORDER_CREATE", product: p,
      conversationId: conv.id, recordEvents: false,
    });
    expect(plan.noOfferReason).toBe("OFFER_DECLINED_BY_CUSTOMER");
    expect(plan.constraints).toContain("OFFER_DECLINE_RESPECTED");
  });
});

// ── 3. Cross-sell rules ───────────────────────────────────────────────────

describe("P8-3 cross-sell rules", () => {
  it("no complementary data → empty, never invented", async () => {
    const p = await seedProduct({});
    const plan = await buildSalesPlan(db as unknown as Db, {
      workspaceId: WS, intent: "ORDER_CREATE", product: p, recordEvents: false,
    });
    expect(plan.crossSell).toEqual([]);
  });

  it("self excluded, unpriced/unavailable skipped, limit 2", async () => {
    await seedProduct({ sku: "SKU-A", name: "منتج A", price: 0 });
    await seedProduct({ sku: "SKU-B", name: "منتج B", price: 300, stockStatus: "OUT_OF_STOCK" });
    await seedProduct({ sku: "SKU-C", name: "منتج C", price: 40 });
    await seedProduct({ sku: "SKU-D", name: "منتج D", price: 50 });
    await seedProduct({ sku: "SKU-E", name: "منتج E", price: 60 });
    const p = await seedProduct({
      sku: "SKU-1",
      complementarySkus: ["SKU-1", "SKU-A", "SKU-B", "SKU-C", "SKU-D", "SKU-E", "GHOST"],
    });
    const plan = await buildSalesPlan(db as unknown as Db, {
      workspaceId: WS, intent: "ORDER_CREATE", product: p, recordEvents: false,
    });
    expect(plan.crossSell.map((c) => c.sku)).toEqual(["SKU-C", "SKU-D"]);
    expect(plan.crossSell.length).toBeLessThanOrEqual(MAX_CROSS_SELL);
  });
});

// ── 4. Objections ─────────────────────────────────────────────────────────

describe("P8-4 objection classification (deterministic)", () => {
  it("classifies Arabic objection topics", () => {
    expect(classifyObjection("السعر غالي عليا")).toBe("PRICE_HIGH");
    expect(classifyObjection("بدي أفكر شوي")).toBe("HESITANT");
    expect(classifyObjection("إيهما أفضل من هذا")).toBe("COMPARISON");
    expect(classifyObjection("بدي كمية أكبر")).toBe("QUANTITY");
    expect(classifyObjection("بدي غير هذا الماركة ثانية")).toBe("WANT_DIFFERENT");
    expect(classifyObjection("مش هلأ، لاحقًا")).toBe("NOT_READY");
    expect(classifyObjection("تمام، سلّموا الطلب")).toBeNull();
  });

  it("objection with local trusted answer flagged; fallback text never invents", async () => {
    const p = await seedProduct({ objections: ["أسعارنا رسمية وفوائد المنتج تستحق."] });
    const plan = await buildSalesPlan(db as unknown as Db, {
      workspaceId: WS, intent: "PRICE_QUESTION", product: p,
      customerText: "غالي", recordEvents: false,
    });
    expect(plan.objection!.topic).toBe("PRICE_HIGH");
    expect(plan.objection!.trustedAnswerAvailable).toBe(true);
    expect(safeObjectionFallback("PRICE_HIGH")).not.toContain("60");
  });
});

// ── 5. Discount policy + approvals ────────────────────────────────────────

describe("P8-5 discount policy (server-enforced cap)", () => {
  it("within cap → allowed; above cap → approval; no cap → approval; invalid → rejected", () => {
    expect(evaluateDiscountPolicy({ discountCap: 15, price: 100 }, 10)).toEqual({
      allowed: true, requiresApproval: false, capPercent: 15, reason: "WITHIN_CAP",
    });
    expect(evaluateDiscountPolicy({ discountCap: 15, price: 100 }, 20).requiresApproval).toBe(true);
    expect(evaluateDiscountPolicy({ discountCap: null, price: 100 }, 5).reason).toBe("NO_CAP_CONFIGURED");
    expect(evaluateDiscountPolicy({ discountCap: 15 }, 0).reason).toBe("INVALID_DISCOUNT");
  });

  it("discounted price math", () => {
    expect(discountedPrice(100, 10)).toEqual({ price: 90, amount: 10 });
    expect(discountedPrice(99.99, 15).amount).toBe(15);
  });

  it("approval flow: request → supervisor decides → use binding", async () => {
    const p = await seedProduct({ discountCap: 5 });
    const requester = ctx(() => false, "agent-1");
    const { approval } = await requestDiscountApproval(db as unknown as Db, requester, {
      productId: p.id, discountPercent: 10, reason: "عميل مهم",
    });
    expect(approval.status).toBe("PENDING");
    expect(Number(approval.discountPercent)).toBe(10);

    // self-approval denied
    await expect(
      decideDiscountApproval(db as unknown as Db, ctx(() => true, "agent-1"), approval.id, "APPROVED")
    ).rejects.toBeInstanceOf(AuthorizationError);

    const approved = await decideDiscountApproval(db as unknown as Db, ctx(() => true, "boss-1"), approval.id, "APPROVED");
    expect(approved.status).toBe("APPROVED");
    expect(approved.decidedBy).toBe("boss-1");

    // double decision denied
    await expect(
      decideDiscountApproval(db as unknown as Db, ctx(() => true, "boss-1"), approval.id, "REJECTED")
    ).rejects.toBeInstanceOf(AppError);

    // binding: same price → valid
    const use1 = await useDiscountApproval(db as unknown as Db, WS, approval.id, { productId: p.id, unitPrice: 100 });
    expect(use1.valid).toBe(true);
    // price changed → invalid
    const use2 = await useDiscountApproval(db as unknown as Db, WS, approval.id, { productId: p.id, unitPrice: 120 });
    expect(use2).toEqual({ valid: false, reason: "PRICE_CHANGED" });
  });

  it("expiry invalidates the approval", async () => {
    const p = await seedProduct({});
    const { approval } = await requestDiscountApproval(db as unknown as Db, ctx(() => false, "a1"), {
      productId: p.id, discountPercent: 5,
    });
    await db.discountApproval.update({
      where: { id: approval.id },
      data: { status: "APPROVED", expiresAt: new Date(Date.now() - 1000) },
    } as never);
    const use = await useDiscountApproval(db as unknown as Db, WS, approval.id, { productId: p.id, unitPrice: 100 });
    expect(use).toEqual({ valid: false, reason: "EXPIRED" });
    const row = (db._stores.discountApproval as any[]).find((r) => r.id === approval.id);
    expect(row.status).toBe("INVALIDATED");
  });

  it("product mismatch / not approved rejected", async () => {
    const p = await seedProduct({});
    const other = await seedProduct({ sku: "SKU-2" });
    const { approval } = await requestDiscountApproval(db as unknown as Db, ctx(() => false, "a1"), {
      productId: p.id, discountPercent: 5,
    });
    await db.discountApproval.update({ where: { id: approval.id }, data: { status: "APPROVED" } } as never);
    expect(
      await useDiscountApproval(db as unknown as Db, WS, approval.id, { productId: other.id, unitPrice: 100 })
    ).toEqual({ valid: false, reason: "PRODUCT_MISMATCH" });

    const p2 = await seedProduct({ sku: "SKU-3" });
    const { approval: ap2 } = await requestDiscountApproval(db as unknown as Db, ctx(() => false, "a1"), {
      productId: p2.id, discountPercent: 5,
    });
    expect(
      await useDiscountApproval(db as unknown as Db, WS, ap2.id, { productId: p2.id, unitPrice: 100 })
    ).toEqual({ valid: false, reason: "NOT_APPROVED" });
  });

  it("listDiscountApprovals filters by workspace + status", async () => {
    const p = await seedProduct({});
    await requestDiscountApproval(db as unknown as Db, ctx(() => false, "a1"), {
      productId: p.id, discountPercent: 5,
    });
    expect(await listDiscountApprovals(db as unknown as Db, WS, "PENDING")).toHaveLength(1);
    expect(await listDiscountApprovals(db as unknown as Db, "ws-other")).toHaveLength(0);
  });

  it("unauthorized can() → decide rejected", async () => {
    const p = await seedProduct({});
    const { approval } = await requestDiscountApproval(db as unknown as Db, ctx(() => false, "a1"), {
      productId: p.id, discountPercent: 5,
    });
    await expect(
      decideDiscountApproval(db as unknown as Db, ctx(() => false, "boss-1"), approval.id, "APPROVED")
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

// ── 6. Wholesale price secrecy ────────────────────────────────────────────

describe("P8-6 wholesale price never leaks", () => {
  it("coach hides wholesale without permission, shows with it", async () => {
    const p = await seedProduct({ wholesalePrice: 60 });
    const { conv } = await seedConv();
    const hidden = await buildCoachSuggestions(db as unknown as Db, ctx(() => false), { conversationId: conv.id, productId: p.id });
    expect(hidden.wholesalePrice).toBeNull();
    const shown = await buildCoachSuggestions(
      db as unknown as Db,
      ctx((perm) => perm === "products.wholesale"),
      { conversationId: conv.id, productId: p.id }
    );
    expect(shown.wholesalePrice).toBe(60);
    // نص الاقتراحات لا يحمل سعر الجملة إطلاقًا
    for (const s of [...hidden.suggestions, ...shown.suggestions]) {
      expect(s.draftText ?? "").not.toContain("60");
    }
  });

  it("coach requires discount permission even to compute discount details", async () => {
    const p = await seedProduct({ discountCap: 15 });
    const { conv } = await seedConv();
    await expect(
      buildCoachSuggestions(db as unknown as Db, ctx(() => false), {
        conversationId: conv.id, productId: p.id, discountPercent: 10,
      })
    ).rejects.toBeInstanceOf(AuthorizationError);
    const okRes = await buildCoachSuggestions(
      db as unknown as Db,
      ctx((perm) => perm === "orders.discount"),
      { conversationId: conv.id, productId: p.id, discountPercent: 10 }
    );
    const disc = okRes.suggestions.find((s) => s.kind === "DISCOUNT");
    expect(disc).toBeDefined();
    expect(okRes.salesPlan.discount!.discountedPrice).toBe(90);
  });

  it("leak guard throws on wholesale number in customer text", () => {
    expect(() => assertNoWholesaleLeak("سعر الجملة 60 فقط", 60)).toThrow(AuthorizationError);
    expect(() => assertNoWholesaleLeak("السعر 100", 60)).not.toThrow();
  });

  it("coach is internal-only and never sends anything", async () => {
    const p = await seedProduct({ offers: [{ title: "عرض", quantity: 3, price: 250 }] });
    const { conv } = await seedConv();
    const res = await buildCoachSuggestions(
      db as unknown as Db,
      ctx(() => true),
      { conversationId: conv.id }
    );
    expect(res.internalOnly).toBe(true);
    const outbound = (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND");
    expect(outbound).toHaveLength(0);
    expect((db._stores.salesEvent as any[]).some((e) => e.type === "COACH_USED")).toBe(true);
  });

  it("missing data → explicit reason, no guessing", async () => {
    const p = await seedProduct({ price: 0 });
    const { conv } = await seedConv();
    const res = await buildCoachSuggestions(db as unknown as Db, ctx(() => false), {
      conversationId: conv.id, productId: p.id,
    });
    expect(res.salesPlan.noOfferReason).toBe("PRICE_UNAVAILABLE");
    expect(res.suggestions.some((s) => s.kind === "REPLY_HINT")).toBe(false);
  });

  it("coach on unknown conversation → NotFound", async () => {
    await expect(
      buildCoachSuggestions(db as unknown as Db, ctx(() => false), { conversationId: "nope" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── 7. RBAC pins for sales permissions ────────────────────────────────────

describe("P8-7 RBAC pins for sales permissions", () => {
  it("MANAGER gets all three; SALES_AGENT only orders.discount; VIEWER none", () => {
    const manager = ROLE_PERMISSIONS.MANAGER;
    expect(manager).toContain("orders.discount");
    expect(manager).toContain("orders.discount.approve");
    expect(manager).toContain("products.wholesale");
    const agent = ROLE_PERMISSIONS.SALES_AGENT;
    expect(agent).toContain("orders.discount");
    expect(agent).not.toContain("orders.discount.approve");
    expect(agent).not.toContain("products.wholesale");
    const viewer = ROLE_PERMISSIONS.VIEWER;
    expect(viewer.some((p) => ["orders.discount", "orders.discount.approve", "products.wholesale"].includes(p))).toBe(false);
    // VIEWER read-only invariant intact
    expect(viewer.every((p) => p.endsWith(".read") || p.endsWith(".view"))).toBe(true);
    // permissions registered in master list
    for (const perm of ["orders.discount", "orders.discount.approve", "products.wholesale"]) {
      expect(PERMISSIONS).toContain(perm);
    }
  });
});

// ── 8. Metrics/analytics (documented formulas, manually computable) ───────

describe("P8-8 sales analytics", () => {
  it("offerAcceptRate = OFFER_ACCEPTED / OFFER_SHOWN", async () => {
    for (let i = 0; i < 4; i += 1) {
      await recordSalesEvent(db as unknown as Db, { workspaceId: WS, type: "OFFER_SHOWN", sku: "S" });
    }
    for (let i = 0; i < 1; i += 1) {
      await recordSalesEvent(db as unknown as Db, { workspaceId: WS, type: "OFFER_ACCEPTED", sku: "S" });
    }
    await recordSalesEvent(db as unknown as Db, { workspaceId: WS, type: "CROSS_SELL_SHOWN", sku: "S2" });
    await recordSalesEvent(db as unknown as Db, { workspaceId: WS, type: "CROSS_SELL_ADDED", sku: "S2" });
    await recordSalesEvent(db as unknown as Db, { workspaceId: WS, type: "DISCOUNT_REQUESTED" });
    await recordSalesEvent(db as unknown as Db, { workspaceId: WS, type: "DISCOUNT_APPROVED" });
    await recordSalesEvent(db as unknown as Db, { workspaceId: WS, type: "DISCOUNT_REJECTED" });
    const a = await getSalesAnalytics(db as unknown as Db, WS);
    expect(a.offersShown).toBe(4);
    expect(a.offerAcceptRate).toBe(0.25);
    expect(a.crossSellAdded).toBe(1);
    expect(a.discountRequests).toBe(1);
    expect(a.discountApproved).toBe(1);
    expect(a.discountRejected).toBe(1);
  });

  it("no shown offers → null rate (never zero-division)", async () => {
    const a = await getSalesAnalytics(db as unknown as Db, WS);
    expect(a.offerAcceptRate).toBeNull();
  });
});

// ── 9. Ad source attribution (first-touch wins) ───────────────────────────

describe("P8-9 ad source attribution", () => {
  it("first touch wins, webhook replay never overwrites, no data → unknown", async () => {
    const { cust } = await seedConv();
    const r1 = await recordAdSource(db as unknown as Db, { workspaceId: WS, customerId: cust.id, source: "camp-123" });
    expect(r1.set).toBe(true);
    const after1 = (db._stores.customer as any[]).find((c) => c.id === cust.id);
    expect(after1.adSource).toBe("camp-123");
    const firstAt = after1.adSourceAt;
    // %عاد نفس العميل من إعلان آخر — المصدر الأصلي مقدس
    const r2 = await recordAdSource(db as unknown as Db, { workspaceId: WS, customerId: cust.id, source: "other-999" });
    expect(r2.set).toBe(false);
    const after2 = (db._stores.customer as any[]).find((c) => c.id === cust.id);
    expect(after2.adSource).toBe("camp-123");
    expect(after2.adSourceAt).toBe(firstAt);
    // %من دون بيانات إحالة → غير معروف (null)
    const { cust: c2 } = await seedConv();
    const r3 = await recordAdSource(db as unknown as Db, { workspaceId: WS, customerId: c2.id, source: null });
    expect(r3.set).toBe(false);
    expect((db._stores.customer as any[]).find((c) => c.id === c2.id).adSource ?? null).toBeNull();
  });

  it("inbound pipeline captures adRef from trusted channel metadata only", async () => {
    const { conv, cust } = await seedConv();
    await processIncomingMessage(db as Db, {
      workspaceId: WS,
      channelType: "FACEBOOK",
      channelId: conv.channelId,
      externalUserId: conv.channelConversationId,
      externalConversationId: conv.channelConversationId,
      externalMessageId: `m-${Math.random().toString(36).slice(2, 8)}`,
      externalEventId: `e-${Math.random().toString(36).slice(2, 8)}`,
      provider: "facebook",
      type: "TEXT",
      text: "مرحبا",
      metadata: { adRef: "camp-meta" },
    });
    expect((db._stores.customer as any[]).find((c) => c.id === cust.id).adSource).toBe("camp-meta");
  });
});

// ── 10. Full AI pipeline with plan (numbers only from DB) ─────────────────

describe("P8-10 pipeline integration", () => {
  async function seedInboundViaConv(text: string, conv: any, cust: any) {
    const res = await processIncomingMessage(db as Db, {
      workspaceId: WS,
      channelType: "FACEBOOK",
      channelId: conv.channelId,
      externalUserId: cust.id,
      externalConversationId: conv.channelConversationId,
      externalMessageId: `m-${Math.random().toString(36).slice(2, 8)}`,
      externalEventId: `e-${Math.random().toString(36).slice(2, 8)}`,
      provider: "facebook",
      type: "TEXT",
      text,
    });
    const inbound = (db._stores.message as any[]).find(
      (m) => m.direction === "INBOUND" && m.conversationId === res.conversationId
    );
    return { ...res, messageId: inbound.id };
  }

  it("buying context with product offer → plan numbers recorded, response sent, wholesale absent", async () => {
    await seedProduct({
      offers: [{ title: "خطة ثلاث", quantity: 3, price: 250 }],
      wholesalePrice: 60,
      complementarySkus: [],
    });
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async (url: string, init?: { body?: string }) => {
            const u = new URL(url as string);
            if (u.pathname.endsWith("/me/messages")) {
              let body: any = null;
              try { body = JSON.parse(String((init as any)?.body ?? "")); } catch { /* ignore */ }
              const rid = body?.recipient?.id ?? "psid";
              return Response.json({ recipient_id: rid, message_id: `mid-${rid}` });
            }
            return Response.json({ id: "page", name: "Demo" });
          }) as typeof fetch,
        })
    );
    const { conv, cust } = await seedConv();
    mock.intentHandler = () => ({ intent: "ORDER_CREATE", confidence: 0.95, entities: { quantity: 2 }, memories: [] });
    const r = await seedInboundViaConv("أبغى كريم تعليم", conv, cust);
    const res = await processAIMessage(
      db as Db,
      { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS },
      { provider: mock, vectorStore: emptyVectors() }
    );
    expect(["RESPONDED", "CLARIFIED"]).toContain(res.status);
    const events = (db._stores.salesEvent as any[]).map((e) => e.type);
    expect(events).toContain("OFFER_QUALIFIED");
    expect(events).toContain("OFFER_SHOWN");
    const shown = (db._stores.salesEvent as any[]).find((e) => e.type === "OFFER_SHOWN");
    expect(shown.value).toBe(50); // 100*3 − 250
    // %'رسالة الصفحة الواحدة' لا تحتوي سعر الجملة (60)
    const outbound = (db._stores.message as any[]).find(
      (m) => m.direction === "OUTBOUND" && m.conversationId === r.conversationId
    );
    expect(outbound).toBeDefined();
    expect(outbound.text).not.toContain("60");
  });

  it("HUMAN_ACTIVE conversation → pipeline disabled, no sales events", async () => {
    await seedProduct({ offers: [{ title: "عرض", quantity: 3, price: 250 }] });
    void 0;
    const { conv, cust } = await seedConv({ aiState: "HUMAN_ACTIVE" });
    mock.intentHandler = () => ({ intent: "ORDER_CREATE", confidence: 0.95, entities: { quantity: 2 }, memories: [] });
    const r = await seedInboundViaConv("أبغى كريم تعليم", conv, cust);
    const res = await processAIMessage(
      db as Db,
      { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS },
      { provider: mock, vectorStore: emptyVectors() }
    );
    expect(res.status).toBe("AI_DISABLED");
    expect((db._stores.salesEvent as any[]).filter((e) => e.type !== "OFFER_QUALIFIED" || e.conversationId === conv.id)).toHaveLength(0);
    expect((db._stores.salesEvent as any[])).toHaveLength(0);
  });
});
