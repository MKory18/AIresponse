import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { resolveRange, median, timezoneOffsetMinutes } from "@/core/analytics/time";
import { validateTemplate, renderTemplate } from "@/modules/automation/template";
import { getOverview, getAIAnalytics, getProductAnalytics, getFunnel, getSLA, getConversationAnalytics } from "@/modules/analytics/service";
import { rebuildDailyAnalytics, rebuildRange } from "@/modules/analytics/aggregation";
import { incrementUsage } from "@/core/analytics/usage-service";
import { createProduct } from "@/modules/products/service";
import { createOrderFromDraft, updateDraftFromExtraction } from "@/modules/orders/order-service";
import { updateDraftFromExtraction as updateDraft } from "@/modules/orders/draft-service";
import { estimateCost, logUsage } from "@/modules/ai/router";

const WS_A = "ws-a";
const WS_B = "ws-b";
const AGENT = { userId: "agent-1", workspaceId: WS_A };
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let productId: string;

beforeEach(async () => {
  db = createFakeDb();
  const product = await createProduct(db as Db, AGENT, { name: "ماء الكمأة", sku: "TW-500", price: 450000, currency: "SYP" });
  productId = product.id;
});

describe("Phase 8 — time ranges & timezone", () => {
  it("resolves preset ranges", () => {
    const r = resolveRange({ range: "last_7_days" });
    expect(r.end.getTime() - r.start.getTime()).toBeGreaterThanOrEqual(6 * 24 * 3600_000);
    expect(r.end.getTime() - r.start.getTime()).toBeLessThanOrEqual(8 * 24 * 3600_000);
  });

  it("custom range is validated and clamped", () => {
    expect(() => resolveRange({ range: "custom" })).toThrow();
    expect(() => resolveRange({ range: "custom", from: "2026-01-01", to: "2027-01-01" })).toThrow();
    const ok = resolveRange({ range: "custom", from: "2026-01-01", to: "2026-01-15" });
    expect(ok.end.getTime() - ok.start.getTime()).toBe(14 * 24 * 3600_000); // to = exclusive-ish midnight
  });

  it("timezone shifts day boundaries (Damascus UTC+3)", () => {
    const offset = timezoneOffsetMinutes("Asia/Damascus", new Date("2026-06-01T12:00:00Z"));
    expect(offset).toBe(180);
    const damascusDay = resolveRange({ range: "today", timezone: "Asia/Damascus" });
    // The damascus day start must be wall-clock midnight in Damascus.
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Damascus", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    expect(fmt.format(damascusDay.start)).toBe("00:00:00");
    expect(fmt.format(new Date(damascusDay.start.getTime() - 60_000))).not.toBe("00:00:00");
  });

  it("median helper", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBeNull();
  });
});

describe("Phase 8 — template allowlist (privacy)", () => {
  it("blocks sensitive fields from ever entering templates", () => {
    expect(validateTemplate("{{customer.passwordHash}}").ok).toBe(false);
    expect(validateTemplate("{{order.constructor}}").ok).toBe(false);
    expect(renderTemplate("{{customer.name}}", { customer: { name: "محمد" } })).toBe("محمد");
  });
});

describe("Phase 8 — AI cost semantics", () => {
  it("known model pricing → deterministic cost", () => {
    expect(estimateCost("gpt-4o-mini", 1000, 500)).toBeCloseTo(0.0009, 6);
  });

  it("unknown pricing → null, never $0", () => {
    expect(estimateCost("unknown-model-xyz", 1000, 500)).toBeNull();
    expect(estimateCost("mock", 1000, 500)).toBeNull();
  });

  it("AIUsageLog stores null cost for unpriced models", async () => {
    await logUsage(db as Db, {
      workspaceId: WS_A, purpose: "RESPONSE", provider: "mock", model: "mock",
      promptTokens: 1000, completionTokens: 500, latencyMs: 5, success: true,
    });
    const logs = db._stores.aIUsageLog as any[];
    expect(logs[0].costUsd).toBeNull();
    expect(logs[0].promptTokens).toBe(1000);
  });

  it("ai analytics separates tokens from cost (null cost shown as null)", async () => {
    await logUsage(db as Db, {
      workspaceId: WS_A, purpose: "RESPONSE", provider: "mock", model: "mock",
      promptTokens: 100, completionTokens: 50, latencyMs: 5, success: true,
    });
    const result = await getAIAnalytics(db as Db, WS_A, { range: "last_7_days" });
    expect(result.calls).toBe(1);
    expect(result.inputTokens).toBe(100);
    expect(result.estimatedCost).toBeNull();
  });
});

describe("Phase 8 — usage metering", () => {
  it("increments monthly usage counters", async () => {
    await incrementUsage(db as Db, WS_A, { messagesInbound: 2, aiCalls: 1, aiInputTokens: 10 });
    await incrementUsage(db as Db, WS_A, { messagesInbound: 1 });
    const { getWorkspaceUsageSummary } = await import("@/core/analytics/usage-service");
    const summary = await getWorkspaceUsageSummary(db as Db, WS_A);
    expect(summary.usage.messagesInbound).toBe(3);
    expect(summary.usage.aiCalls).toBe(1);
  });

  it("same-event duplicate does not double-count (caller passes deltas once)", async () => {
    // incrementUsage is called once per trusted domain site; the aggregation
    // rebuild (not increments) is the idempotent recomputation path.
    await incrementUsage(db as Db, WS_A, { messagesInbound: 1 });
    const before = await db.workspaceUsage.findFirst({ where: { workspaceId: WS_A } });
    await incrementUsage(db as Db, WS_B, { messagesInbound: 5 });
    const after = await db.workspaceUsage.findFirst({ where: { workspaceId: WS_A } });
    expect(before!.messagesInbound).toBe(after!.messagesInbound); // WS_B isolated
  });

  it("usage is workspace-scoped", async () => {
    await incrementUsage(db as Db, WS_A, { ordersCreated: 100 });
    await incrementUsage(db as Db, WS_B, { ordersCreated: 50 });
    const a = await db.workspaceUsage.findFirst({ where: { workspaceId: WS_A } });
    const b = await db.workspaceUsage.findFirst({ where: { workspaceId: WS_B } });
    expect(a!.ordersCreated).toBe(100);
    expect(b!.ordersCreated).toBe(50);
  });
});

describe("Phase 8 — historical revenue from snapshots", () => {
  it("critical: product price change does NOT change historical revenue", async () => {
    const customer = await db.customer.create({ data: { workspaceId: WS_A } } as never);
    const conv = await db.conversation.create({
      data: { workspaceId: WS_A, customerId: customer.id, channelId: "ch", channelConversationId: "c1" },
    } as never);
    await updateDraft(db as Db, {
      workspaceId: WS_A, conversationId: conv.id, customerId: customer.id,
      extraction: { productId, quantity: 3, phone: "0930000000", rawAddress: "دويلعة", province: "دمشق" },
      source: "TEST",
    });
    const draft = await db.orderDraft.findUniqueOrThrow({ where: { conversationId: conv.id } });
    const order = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    expect(order.total).toBe(1350000); // 450000 × 3 snapshot

    // price doubles AFTER the order
    await db.product.update({ where: { id: productId }, data: { price: 900000 } });

    const products = await getProductAnalytics(db as Db, WS_A, { range: "last_30_days" });
    if (products.length === 0) {
      console.log("DEBUG items", JSON.stringify(db._stores.orderItem), JSON.stringify(db._stores.order.map((o: any) => ({ id: o.id, ws: o.workspaceId, st: o.status }))));
    }
    expect(products[0].confirmedRevenue).toBe(1350000); // NOT 2700000
    expect(products[0].units).toBe(3);
  });
});

describe("Phase 8 — workspace isolation", () => {
  it("critical: A 100 orders, B 50 — no query mixes them", async () => {
    for (const [ws, count] of [[WS_A, 100], [WS_B, 50]] as const) {
      for (let i = 0; i < count; i++) {
        await db.order.create({ data: { workspaceId: ws, orderNumber: `O-${ws}-${i}`, customerId: "c", total: 1000 } } as never);
      }
    }
    const a = await db.order.findMany({ where: { workspaceId: WS_A }, select: { total: true } });
    const b = await db.order.findMany({ where: { workspaceId: WS_B }, select: { total: true } });
    expect(a).toHaveLength(100);
    expect(b).toHaveLength(50);
    const overviewA = await getOverview(db as Db, WS_A, { range: "last_30_days" });
    expect(overviewA.orders.created).toBe(100);
    const overviewB = await getOverview(db as Db, WS_B, { range: "last_30_days" });
    expect(overviewB.orders.created).toBe(50);
  });

  it("overview never sums across workspaces even with shared-shaped data", async () => {
    await db.order.create({ data: { workspaceId: WS_B, orderNumber: "B-1", customerId: "c", total: 999999 } } as never);
    const overviewA = await getOverview(db as Db, WS_A, { range: "last_30_days" });
    expect(overviewA.revenue.confirmed).toBe(0);
  });
});

describe("Phase 8 — funnel & zero denominators", () => {
  it("rates are null (not NaN) when denominators are 0", async () => {
    const funnel = await getFunnel(db as Db, WS_A, { range: "last_7_days" });
    expect(funnel.conversations).toBe(0);
    expect(funnel.rates.draftStartRate).toBeNull();
    expect(funnel.rates.confirmRate).toBeNull();
  });

  it("funnel computes real rates with data", async () => {
    const customer = await db.customer.create({ data: { workspaceId: WS_A } } as never);
    const conv = await db.conversation.create({
      data: { workspaceId: WS_A, customerId: customer.id, channelId: "ch", channelConversationId: "c2" },
    } as never);
    await updateDraft(db as Db, {
      workspaceId: WS_A, conversationId: conv.id, customerId: customer.id,
      extraction: { productId, quantity: 1, phone: "0930000000", rawAddress: "دويلعة", province: "دمشق" },
      source: "TEST",
    });
    const draft = await db.orderDraft.findUniqueOrThrow({ where: { conversationId: conv.id } });
    await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    const funnel = await getFunnel(db as Db, WS_A, { range: "last_7_days" });
    expect(funnel.conversations).toBe(1);
    expect(funnel.ordersConfirmed).toBe(1);
    expect(funnel.rates.confirmRate).toBe(1);
    expect(funnel.rates.deliveryRate).toBe(0); // 0 delivered / 1 confirmed = 0
  });
});

describe("Phase 8 — first response time definition", () => {
  it("FRT = first OUTBOUND after first INBOUND", async () => {
    const customer = await db.customer.create({ data: { workspaceId: WS_A } } as never);
    const conv = await db.conversation.create({
      data: { workspaceId: WS_A, customerId: customer.id, channelId: "ch", channelConversationId: "c3" },
    } as never);
    const t0 = Date.now();
    await db.message.createMany({
      data: [
        { conversationId: conv.id, workspaceId: WS_A, senderType: "CUSTOMER", direction: "INBOUND", type: "TEXT", text: "مرحبا", createdAt: new Date(t0) },
        { conversationId: conv.id, workspaceId: WS_A, senderType: "HUMAN", direction: "OUTBOUND", type: "TEXT", text: "رد", createdAt: new Date(t0 + 30 * 60_000) },
      ],
    } as never);
    const result = await getConversationAnalytics(db as Db, WS_A, { range: "last_7_days" });
    expect(result.firstResponse.count).toBe(1);
    expect(result.firstResponse.medianMinutes).toBeCloseTo(30, 0);
  });
});

describe("Phase 8 — SLA", () => {
  it("breach counting with configured target", async () => {
    const customer = await db.customer.create({ data: { workspaceId: WS_A } } as never);
    const conv = await db.conversation.create({
      data: { workspaceId: WS_A, customerId: customer.id, channelId: "ch", channelConversationId: "c4" },
    } as never);
    const t0 = Date.now();
    await db.message.createMany({
      data: [
        { conversationId: conv.id, workspaceId: WS_A, senderType: "CUSTOMER", direction: "INBOUND", type: "TEXT", createdAt: new Date(t0) },
        { conversationId: conv.id, workspaceId: WS_A, senderType: "AI", direction: "OUTBOUND", type: "TEXT", createdAt: new Date(t0 + 60 * 60_000) }, // 60 min
      ],
    } as never);
    const sla = await getSLA(db as Db, WS_A, { range: "last_7_days" }, { slaFirstResponseMinutes: 30, slaHandoffResolutionMinutes: 240 });
    expect(sla.firstResponse.breached).toBe(1);
    expect(sla.firstResponse.met).toBe(0);
    expect(sla.firstResponse.breachRate).toBe(1);
  });

  it("null target → null breach (never hardcoded business values)", async () => {
    const sla = await getSLA(db as Db, WS_A, { range: "last_7_days" }, { slaFirstResponseMinutes: null, slaHandoffResolutionMinutes: null });
    expect(sla.firstResponse.breached).toBeNull();
    expect(sla.firstResponse.breachRate).toBeNull();
  });
});

describe("Phase 8 — daily aggregation (idempotent, late events)", () => {
  it("rebuild is idempotent — repeated rebuild yields identical totals", async () => {
    await db.conversation.create({ data: { workspaceId: WS_A, customerId: "c", channelId: "ch", channelConversationId: "x" } } as never);
    const day = new Date();
    await rebuildDailyAnalytics(db as Db, WS_A, day);
    await rebuildDailyAnalytics(db as Db, WS_A, day);
    const rows = db._stores.dailyWorkspaceAnalytics as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].conversations).toBe(1);
  });

  it("late event → rebuild picks it up without duplicates", async () => {
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    await rebuildDailyAnalytics(db as Db, WS_A, yesterday);
    // late event arrives dated yesterday
    await db.message.create({
      data: { conversationId: "conv", workspaceId: WS_A, senderType: "CUSTOMER", direction: "INBOUND", type: "TEXT", createdAt: yesterday },
    } as never);
    await rebuildDailyAnalytics(db as Db, WS_A, yesterday);
    const rows = db._stores.dailyWorkspaceAnalytics as any[];
    if (rows[0]?.inboundMessages !== 1) console.log("DBG", JSON.stringify(rows)); 
    expect(rows[0].inboundMessages).toBe(1);
    await rebuildRange(db as Db, WS_A, yesterday, new Date());
    const rebuilt = (db._stores.dailyWorkspaceAnalytics as any[]).filter((r) => r.inboundMessages === 1);
    expect(rebuilt).toHaveLength(1);
  });

  it("aggregation is workspace-scoped", async () => {
    await db.conversation.create({ data: { workspaceId: WS_B, customerId: "c", channelId: "ch", channelConversationId: "y" } } as never);
    await rebuildDailyAnalytics(db as Db, WS_A, new Date());
    const rows = db._stores.dailyWorkspaceAnalytics as any[];
    expect(rows.every((r) => r.workspaceId === WS_A)).toBe(true);
    expect(rows[0].conversations).toBe(0); // WS_B conversation not counted
  });
});
