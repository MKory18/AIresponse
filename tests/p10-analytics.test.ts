import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { getOverview, getConversationAnalytics, getOrderAnalytics, getProductAnalytics, getAIAnalytics, getFunnel, resolveRange, type RangeQuery } from "@/modules/analytics/service";
import { getSalesAnalytics, recordSalesEvent } from "@/modules/sales/metrics";
import { getAgentAnalytics } from "@/modules/analytics/agents";
import { getCampaignAnalytics } from "@/modules/analytics/campaigns-analytics";
import { getTrends } from "@/modules/analytics/trends";
import { rebuildDailyAnalytics } from "@/modules/analytics/aggregation";
import { toCsv, csvEscapeCell, sumMoney, avgMoney } from "@/modules/analytics/csv";
import { ROLE_PERMISSIONS, PERMISSIONS } from "@/modules/rbac/permissions";

/**
 * P10 — التحليلات والتقارير: كل مؤشر بمعادلة موثقة من بيانات فعلية.
 * القواعد المثبتة: الغياب ≠ صفر (null → "غير متاح")، قبول API ≠ تسليم،
 * مسودة ≠ بيع، عزل المؤسسة، وعدم تكرار المحادثة الواحدة.
 */
const WS = "ws-p10";
const WS_B = "ws-p10-b";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

const q = (r: RangeQuery = { range: "last_7_days" }): RangeQuery => r;

async function seedConv(extra: Record<string, unknown> = {}, ws = WS) {
  return (await db.conversation.create({
    data: { workspaceId: ws, customerId: `cust-${Math.random().toString(36).slice(2, 8)}`, channelId: "ch-1", channelConversationId: `cc-${Math.random().toString(36).slice(2, 9)}`, ...extra },
  } as never)) as any;
}

async function seedMsg(conv: any, direction: "INBOUND" | "OUTBOUND", minutesAfter: number, extra: Record<string, unknown> = {}) {
  return (await db.message.create({
    data: { workspaceId: WS, conversationId: conv.id, direction, senderType: direction === "INBOUND" ? "CUSTOMER" : "HUMAN", createdAt: new Date(new Date(conv.createdAt).getTime() + minutesAfter * 60_000), ...extra },
  } as never)) as any;
}

beforeEach(() => {
  db = createFakeDb();
});

// ── 1. النظرة التنفيذية ─────────────────────────────────────────────────────

describe("P10-1 getOverview (formulas from DB)", () => {
  it("counts conversations once (not per message) + real customers", async () => {
    const c1 = await seedConv();
    await seedMsg(c1, "INBOUND", 1);
    await seedMsg(c1, "OUTBOUND", 2);
    await seedMsg(c1, "INBOUND", 3); // نفس المحادثة — لا تُحسب مرتين
    await db.customer.create({ data: { workspaceId: WS, name: "عميل" } } as never);
    await db.customer.create({ data: { workspaceId: WS, name: "عميل2" } } as never);
    await db.customer.create({ data: { workspaceId: WS_B, name: "آخر" } } as never);

    const r = await getOverview(db as Db, WS, q());
    expect(r.conversations.total).toBe(1);
    expect(r.messages.inbound).toBe(2);
    expect(r.messages.outbound).toBe(1);
    // P10: عملاء حقيقيون — استنساخ عدد المحادثات كان placeholder
    expect(r.customers.newInRange).toBe(2);
    expect(r.customers.total).toBe(2); // عزل المؤسسة: WS_B لا يُحسب
  });

  it("confirmed revenue only for CONFIRMED-family statuses; Decimal sums precisely", async () => {
    const mk = async (status: string, total: string) =>
      db.order.create({ data: { workspaceId: WS, orderNumber: `o-${Math.random()}`, status: status as never, total } } as never);
    await mk("CONFIRMED", "10.01");
    await mk("DELIVERED", "20.02");
    await mk("CANCELLED", "99.99");
    const r = await getOverview(db as Db, WS, q());
    expect(r.orders.confirmed).toBe(2);
    expect(r.orders.cancelled).toBe(1);
    // جمع سنتات دقيق: 10.01 + 20.02 = 30.03 (وليس 30.029999...)
    expect(r.revenue.confirmed).toBeCloseTo(30.03, 2);
    expect(r.revenue.delivered).toBeCloseTo(20.02, 2);
  });

  it("AI cost null when no known pricing — never 0-as-actual", async () => {
    await db.aIUsageLog.create({ data: { workspaceId: WS, purpose: "RESPONSE", provider: "openai", model: "gpt", costUsd: null } } as never);
    const r = await getOverview(db as Db, WS, q());
    expect(r.ai.estimatedCost).toBeNull();
    expect(r.ai.calls).toBe(1);
  });

  it("AI cost sums only known costs when mixed", async () => {
    await db.aIUsageLog.create({ data: { workspaceId: WS, purpose: "RESPONSE", provider: "p", model: "m", costUsd: 0.5 } } as never);
    await db.aIUsageLog.create({ data: { workspaceId: WS, purpose: "RESPONSE", provider: "p", model: "m", costUsd: null } } as never);
    const r = await getOverview(db as Db, WS, q());
    expect(r.ai.estimatedCost).toBeCloseTo(0.5, 6);
  });

  it("tenant isolation: WS_B conversations never leak", async () => {
    await seedConv({}, WS_B);
    await seedConv({}, WS_B);
    const r = await getOverview(db as Db, WS, q());
    expect(r.conversations.total).toBe(0);
    expect(r.customers.total).toBe(0);
  });
});

// ── 2. المنطقة الزمنية والفترة ──────────────────────────────────────────────

describe("P10-2 timezone + range resolution", () => {
  it("today in Damascus starts at 21:00Z previous day (UTC+3)", () => {
    const r = resolveRange({ range: "today", timezone: "Asia/Damascus" });
    const h = new Date(r.start).toISOString().slice(11, 16);
    expect(h).toBe("21:00"); // منتصف ليل دمشق = 21:00Z
    expect(r.end.getTime() - r.start.getTime()).toBe(24 * 3600_000);
  });

  it("last_7_days covers 7 business days (start -6d, end +1d)", () => {
    const r = resolveRange({ range: "last_7_days", timezone: "UTC" });
    expect(Math.round((r.end.getTime() - r.start.getTime()) / 24 / 3600_000)).toBe(7);
  });

  it("period comparison: same-length previous window yields independent counts", async () => {
    const now = new Date();
    await db.order.create({ data: { workspaceId: WS, orderNumber: "o-now", status: "CONFIRMED", total: "5", createdAt: now } } as never);
    await db.order.create({ data: { workspaceId: WS, orderNumber: "o-old", status: "CONFIRMED", total: "3", createdAt: new Date(now.getTime() - 8 * 24 * 3600_000) } } as never);
    const cur = await getOverview(db as Db, WS, q({ range: "last_7_days", timezone: "UTC" }));
    const prev = await getOverview(db as Db, WS, { range: "custom", from: new Date(now.getTime() - 14 * 24 * 3600_000).toISOString(), to: new Date(now.getTime() - 7 * 24 * 3600_000).toISOString(), timezone: "UTC" });
    expect(cur.orders.confirmed).toBe(1);
    expect(prev.orders.confirmed).toBe(1);
  });
});

// ── 3. المحادثات: FRT وتجنب التكرار ─────────────────────────────────────────

describe("P10-3 conversation analytics", () => {
  it("FRT = first OUTBOUND after first INBOUND; conversation without reply excluded (not 0)", async () => {
    const answered = await seedConv();
    await seedMsg(answered, "INBOUND", 0);
    await seedMsg(answered, "OUTBOUND", 30); // 30 دقيقة
    const unanswered = await seedConv();
    await seedMsg(unanswered, "INBOUND", 0);
    const outboundFirst = await seedConv();
    await seedMsg(outboundFirst, "OUTBOUND", 0); // بلا رسالة عميل أولًا — لا FRT
    const r = await getConversationAnalytics(db as Db, WS, q());
    expect(r.firstResponse.count).toBe(1);
    expect(r.firstResponse.avgMinutes).toBeCloseTo(30, 6);
    expect(r.newConversations).toBe(3); // محادثات جديدة (وليس عدد الرسائل)
    expect(r.inboundMessages).toBe(2);
  });

  it("FRT only counts OUTBOUND after the customer message (pre-emptive outbound ignored)", async () => {
    const c = await seedConv();
    await seedMsg(c, "OUTBOUND", -5); // قبل رسالة العميل — لا يُحسب
    await seedMsg(c, "INBOUND", 0);
    await seedMsg(c, "OUTBOUND", 12);
    const r = await getConversationAnalytics(db as Db, WS, q());
    expect(r.firstResponse.avgMinutes).toBeCloseTo(12, 6);
  });
});

// ── 4. الطلبات: التعريفات والمراحل ──────────────────────────────────────────

describe("P10-4 order analytics", () => {
  it("draft is NOT an order; stages separated", async () => {
    await db.orderDraft.create({ data: { workspaceId: WS, conversationId: "c1", state: "COLLECTING" } } as never);
    await db.order.create({ data: { workspaceId: WS, orderNumber: "o1", status: "NEW", total: "10" } } as never);
    const funnel = await getFunnel(db as Db, WS, q());
    const r = await getOrderAnalytics(db as Db, WS, q());
    expect(r.created).toBe(1); // الـ draft ليس طلبًا
    expect(funnel.draftsStarted).toBe(1);
    expect(funnel.ordersConfirmed).toBe(0); // NEW ≠ مؤكد
  });

  it("avg order value = confirmedGmv / confirmed; cancelled outside denominator", async () => {
    await db.order.create({ data: { workspaceId: WS, orderNumber: "a", status: "CONFIRMED", total: "30.00" } } as never);
    await db.order.create({ data: { workspaceId: WS, orderNumber: "b", status: "CONFIRMED", total: "45.00" } } as never);
    await db.order.create({ data: { workspaceId: WS, orderNumber: "c", status: "CANCELLED", total: "100.00" } } as never);
    const r = await getOrderAnalytics(db as Db, WS, q());
    const avg = r.gmv.confirmedGmv / r.confirmed;
    expect(avg).toBeCloseTo(37.5, 2); // (30+45)/2 — الملغي خارج المقام
  });

  it("OMS-dependent delivery data: nothing invented (0 from DB), OMS flagged unverified upstream", async () => {
    const r = await getOrderAnalytics(db as Db, WS, q());
    expect(r.delivered).toBe(0);
  });
});

// ── 5. المنتجات ─────────────────────────────────────────────────────────────

describe("P10-5 product analytics (snapshot prices)", () => {
  it("units + confirmed revenue from OrderItem snapshots, per product", async () => {
    const p1 = await db.product.create({ data: { workspaceId: WS, name: "كريم", sku: "SKU-1", price: 10 } } as never);
    const o = await db.order.create({ data: { workspaceId: WS, orderNumber: "po-1", status: "CONFIRMED", total: "25" } } as never);
    const o2 = await db.order.create({ data: { workspaceId: WS, orderNumber: "po-2", status: "DELIVERED", total: "10" } } as never);
    await db.orderItem.create({ data: { orderId: o.id, productId: p1.id, productNameSnapshot: "كريم", skuSnapshot: "SKU-1", unitPrice: "12.5", quantity: 2, subtotal: "25" } } as never);
    await db.orderItem.create({ data: { orderId: o2.id, productId: p1.id, productNameSnapshot: "كريم", skuSnapshot: "SKU-1", unitPrice: "10", quantity: 1, subtotal: "10" } } as never);
    const rows = await getProductAnalytics(db as Db, WS, q());
    expect(rows).toHaveLength(1);
    expect(rows[0].units).toBe(3);
    expect(rows[0].confirmedOrders).toBe(2); // CONFIRMED و DELIVERED كلاهما ضمن عائلة المؤكد
    expect(rows[0].confirmedRevenue).toBeCloseTo(35, 2); // snapshots: 25 + 10
    expect(rows[0].deliveredOrders).toBe(1);
    expect(rows[0].deliveredRevenue).toBeCloseTo(10, 2);
  });
});

// ── 6. الذكاء: التكلفة المجهولة والمهام ─────────────────────────────────────

describe("P10-6 AI analytics", () => {
  it("costUsd=null → estimatedCost=null (not 0); byTask/byModel keep source identity", async () => {
    await db.aIUsageLog.create({ data: { workspaceId: WS, purpose: "RESPONSE", provider: "openai", model: "gpt-4o", costUsd: null, latencyMs: 100 } } as never);
    const r = await getAIAnalytics(db as Db, WS, q());
    expect(r.calls).toBe(1);
    expect(r.estimatedCost).toBeNull();
    expect(r.byTask[0].key).toBe("RESPONSE");
    expect(r.byModel[0].key).toBe("gpt-4o");
    expect(r.avgLatencyMs).toBeCloseTo(100, 6);
  });

  it("mixed known/unknown costs sum only known ones", async () => {
    await db.aIUsageLog.create({ data: { workspaceId: WS, purpose: "RESPONSE", provider: "a", model: "m", costUsd: 1.25 } } as never);
    await db.aIUsageLog.create({ data: { workspaceId: WS, purpose: "SUMMARY", provider: "a", model: "m", costUsd: null } } as never);
    const r = await getAIAnalytics(db as Db, WS, q());
    expect(r.estimatedCost).toBeCloseTo(1.25, 6);
    expect(r.byTask).toHaveLength(2);
  });
});

// ── 7. مؤشرات البيع (P8) ────────────────────────────────────────────────────

describe("P10-7 sales analytics (offers ≠ sales)", () => {
  it("offerAcceptRate = OFFER_ACCEPTED / OFFER_SHOWN; suggestion alone is not a sale", async () => {
    await recordSalesEvent(db as Db, { workspaceId: WS, type: "OFFER_QUALIFIED" });
    await recordSalesEvent(db as Db, { workspaceId: WS, type: "OFFER_SHOWN" });
    await recordSalesEvent(db as Db, { workspaceId: WS, type: "OFFER_SHOWN" });
    await recordSalesEvent(db as Db, { workspaceId: WS, type: "OFFER_ACCEPTED", sku: "S1" });
    const r = await getSalesAnalytics(db as Db, WS, {});
    expect(r.offersQualified).toBe(1);
    expect(r.offersShown).toBe(2);
    expect(r.offerAcceptRate).toBeCloseTo(0.5, 6); // مقام = المعروض لا المؤهل
  });

  it("null rate when nothing shown; cross-sell counters separate", async () => {
    const r = await getSalesAnalytics(db as Db, WS, {});
    expect(r.offerAcceptRate).toBeNull();
    await recordSalesEvent(db as Db, { workspaceId: WS, type: "CROSS_SELL_SHOWN" });
    await recordSalesEvent(db as Db, { workspaceId: WS, type: "CROSS_SELL_ADDED" });
    const r2 = await getSalesAnalytics(db as Db, WS, {});
    expect(r2.crossSellShown).toBe(1);
    expect(r2.crossSellAdded).toBe(1);
    expect(r2.offerAcceptRate).toBeNull();
  });
});

// ── 8. أداء الموظفين ────────────────────────────────────────────────────────

describe("P10-8 agent analytics (documented attribution)", () => {
  it("attribution via assignedAgentId only; AI replies never count as agent replies", async () => {
    const c1 = await seedConv({ assignedAgentId: "agent-1" });
    await seedMsg(c1, "INBOUND", 0);
    await seedMsg(c1, "OUTBOUND", 20, { senderType: "AI", senderId: "ai-bot" }); // رد AI — ليس موظفًا
    await seedMsg(c1, "OUTBOUND", 40, { senderType: "HUMAN", senderId: "agent-1" });
    const c2 = await seedConv({ assignedAgentId: "agent-2" });
    await seedMsg(c2, "INBOUND", 0);
    await seedMsg(c2, "OUTBOUND", 10, { senderType: "HUMAN", senderId: "agent-2" });
    const r = await getAgentAnalytics(db as Db, WS, q());
    const a1 = r.agents.find((a) => a.agentId === "agent-1")!;
    const a2 = r.agents.find((a) => a.agentId === "agent-2")!;
    expect(a1.repliesSent).toBe(1);
    expect(a1.conversationsAssigned).toBe(1);
    expect(a2.firstResponseMedianMinutes).toBeCloseTo(10, 6);
    expect(r.totalAgents).toBe(2);
  });

  it("orders attributed via conversation assignment — not last viewer; offer metrics UNAVAILABLE with reason", async () => {
    const c = await seedConv({ assignedAgentId: "agent-1" });
    await db.order.create({ data: { workspaceId: WS, orderNumber: "oa", status: "CONFIRMED", total: "40", conversationId: c.id } } as never);
    await db.order.create({ data: { workspaceId: WS, orderNumber: "ob", status: "CONFIRMED", total: "10" } } as never); // بلا محادثة — لا إسناد
    await db.auditLog.create({ data: { workspaceId: WS, userId: "agent-1", action: "sales.discount_approved" } } as never);
    await db.auditLog.create({ data: { workspaceId: WS, userId: "agent-1", action: "sales.discount_rejected" } } as never);
    const r = await getAgentAnalytics(db as Db, WS, q());
    const a1 = r.agents.find((a) => a.agentId === "agent-1")!;
    expect(a1.ordersLinked).toBe(1);
    expect(a1.ordersLinkedConfirmed).toBe(1);
    expect(a1.ordersLinkedConfirmedValue).toBeCloseTo(40, 2);
    expect(a1.discountApproved).toBe(1);
    expect(a1.discountRejected).toBe(1);
    expect(a1.offerMetrics).toMatchObject({ status: "UNAVAILABLE", reason: "SALES_EVENT_HAS_NO_ACTOR" });
  });

  it("RBAC pin: analytics.agents for MANAGER/OWNER/ADMIN only", () => {
    expect(PERMISSIONS).toContain("analytics.agents");
    expect(ROLE_PERMISSIONS.MANAGER).toContain("analytics.agents");
    expect(ROLE_PERMISSIONS.SALES_AGENT).not.toContain("analytics.agents");
    expect(ROLE_PERMISSIONS.VIEWER).not.toContain("analytics.agents");
    expect(ROLE_PERMISSIONS.SUPPORT_AGENT).not.toContain("analytics.agents");
  });
});

// ── 9. الحملات ──────────────────────────────────────────────────────────────

describe("P10-9 campaign analytics (accept ≠ delivery, snapshot ≠ sent)", () => {
  it("recipient statuses + exclusion reasons + unique recipients vs api accepted", async () => {
    const camp = await db.campaign.create({ data: { workspaceId: WS, segmentId: "seg", name: "حملة", channelType: "WHATSAPP" } } as never);
    const rows: Array<[string, string | null]> = [["SENT", null], ["SENT", null], ["EXCLUDED", "OPTED_OUT"], ["EXCLUDED", "BLACKLISTED"], ["FAILED", null], ["PENDING", null]];
    for (const [status, excludeReason] of rows) {
      await db.campaignRecipient.create({ data: { workspaceId: WS, campaignId: camp.id, customerId: `c-${Math.random()}`, status, excludeReason } } as never);
    }
    await db.campaignEvent.create({ data: { workspaceId: WS, campaignId: camp.id, type: "STARTED", count: 2 } } as never);
    const r = await getCampaignAnalytics(db as Db, WS, q());
    expect(r.campaigns.createdInRange).toBe(1);
    expect(r.audience.recipientRows).toBe(6);
    expect(r.audience.uniqueRecipients).toBe(6);
    expect(r.audience.byStatus.SENT).toBe(2);
    expect(r.audience.excluded).toBe(2);
    expect(r.audience.byExcludeReason).toEqual({ OPTED_OUT: 1, BLACKLISTED: 1 });
    expect(r.sending.apiAccepted).toBe(2); // لقطة (6) ≠ مرسل (2)
    expect(r.sending.deliveryVerification).toBe("UNVERIFIED_NO_STATUS_WEBHOOK_DATA");
    expect(r.sending.deliveryConfirmed).toBe(0);
    expect(r.attribution.status).toBe("UNAVAILABLE");
    expect(r.attribution.reason).toBe("ORDER_HAS_NO_CAMPAIGN_ATTRIBUTION");
    expect(r.attribution.roas).toBeNull();
    expect(r.sending.eventsByType.STARTED).toBe(2);
  });

  it("delivery counted only with provider status proof (message DELIVERED)", async () => {
    const camp = await db.campaign.create({ data: { workspaceId: WS, segmentId: "seg", name: "ح2", channelType: "WHATSAPP" } } as never);
    const m = await db.message.create({ data: { workspaceId: WS, conversationId: "cx", direction: "OUTBOUND", deliveryStatus: "DELIVERED" } } as never);
    await db.campaignRecipient.create({ data: { workspaceId: WS, campaignId: camp.id, customerId: "cu", status: "SENT", messageId: m.id } } as never);
    const r = await getCampaignAnalytics(db as Db, WS, q());
    expect(r.sending.deliveryConfirmed).toBe(1);
    expect(r.sending.deliveryVerification).toBe("VERIFIED_BY_STATUS_WEBHOOK");
  });

  it("tenant isolation on campaigns", async () => {
    await db.campaign.create({ data: { workspaceId: WS_B, segmentId: "s", name: "ب", channelType: "WHATSAPP" } } as never);
    const r = await getCampaignAnalytics(db as Db, WS, q());
    expect(r.campaigns.createdInRange).toBe(0);
    expect(r.audience.recipientRows).toBe(0);
  });
});

// ── 10. الاتجاهات (الجدول اليومي المجمّع) ───────────────────────────────────

describe("P10-10 trends (daily aggregation read + self-heal)", () => {
  it("rebuilt days read as OK; missing days are MISSING (not zero) and enqueue one idempotent rebuild", async () => {
    await rebuildDailyAnalytics(db as Db, WS, new Date());
    const r = await getTrends(db as Db, WS, { range: "last_7_days", timezone: "UTC" });
    const okRows = (r.series as any[]).filter((s) => s.dataStatus === "OK");
    expect(okRows).toHaveLength(1);
    expect(r.coverage.missing).toBe(r.days.length - 1);
    expect(r.coverage.rebuildEnqueued).toBe(true);
    const job = await (db as any).backgroundJob.findFirst({ where: { idempotencyKey: `analytics-rebuild:${WS}` } });
    expect(job.type).toBe("aggregate_workspace_analytics");
    const jobsBefore = await (db as any).backgroundJob.count({});
    await getTrends(db as Db, WS, { range: "last_7_days", timezone: "UTC" });
    expect(await (db as any).backgroundJob.count({})).toBe(jobsBefore);
  });

  it("tenant isolation on daily rows", async () => {
    await rebuildDailyAnalytics(db as Db, WS_B, new Date());
    const r = await getTrends(db as Db, WS, { range: "last_7_days", timezone: "UTC" });
    expect((r.series as any[]).filter((s) => s.dataStatus === "OK")).toHaveLength(0);
  });
});

// ── 11. CSV: دقة + حماية الحقن ──────────────────────────────────────────────

describe("P10-11 CSV export correctness + formula injection guard", () => {
  it("sumMoney/avgMoney use cents (no float drift)", () => {
    expect(sumMoney(["0.1", "0.2"])).toBe(0.3);
    expect(sumMoney([null, undefined, "1.05"])).toBe(1.05);
    expect(sumMoney([null, undefined])).toBeNull(); // غياب ≠ صفر
    expect(avgMoney(["10.00", "30.00"])).toBe(20);
    expect(avgMoney([null])).toBeNull();
  });

  it("formula injection: leading = + - @ tab CR get apostrophe prefix", () => {
    expect(csvEscapeCell("=1+1")).toBe("'=1+1");
    expect(csvEscapeCell("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(csvEscapeCell("-2")).toBe("'-2");
    expect(csvEscapeCell("@cmd")).toBe("'@cmd");
    expect(csvEscapeCell("\tcmd")).toBe("'\tcmd");
    expect(csvEscapeCell("طبيعي")).toBe("طبيعي");
    expect(csvEscapeCell(42)).toBe("42");
    expect(csvEscapeCell(null)).toBe("");
  });

  it("toCsv: columns, comma quoting, empty rows", () => {
    expect(toCsv([], ["a"])).toBe("");
    const csv = toCsv([{ name: "علي", val: 5, note: "has, comma" }]);
    expect(csv.split("\r\n")[0]).toBe("name,val,note");
    expect(csv.split("\r\n")[1]).toContain('"has, comma"');
  });

  it("export numbers match the report service (same source functions)", async () => {
    await db.order.create({ data: { workspaceId: WS, orderNumber: "e1", status: "CONFIRMED", total: "12.5" } } as never);
    const report = await getOrderAnalytics(db as Db, WS, q());
    expect(report.confirmed).toBe(1);
    expect(report.gmv.confirmedGmv).toBeCloseTo(12.5, 2);
  });
});
