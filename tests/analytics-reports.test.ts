/**
 * الحزمة 3.7 — التقارير على قاعدة بالذاكرة: L-18 (اليوم حي بلا إعادة بناء) · L-19 (منطقة المساحة) · L-20 (SLA وبلا رد) ·
 * L-21 (زمن الحل انشال) · عزل المساحات · الصلاحيات · التصدير بنفس الأرقام · الصفحة والقيود.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { findForbiddenTerms } from "@/lib/glossary";
import { getConversationAnalytics, getSLA } from "@/modules/analytics/service";
import { dayKeys, exportRows, getReport, reportQuerySchema, resolveReportRange, type ReportQuery } from "@/modules/analytics/reports";
import type { Permission } from "@/modules/rbac/permissions";

type Db = Prisma.TransactionClient;
const WS = "ws-rep";
const OTHER = "ws-other";
const NOW = new Date("2026-11-17T09:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const ALL: Permission[] = ["analytics.read", "analytics.agents", "usage.read"] as Permission[];
const canAll = (p: Permission) => ALL.includes(p);
const canRead = (p: Permission) => p === "analytics.read";
const q = (o: Partial<ReportQuery> = {}): ReportQuery => reportQuerySchema.parse({ range: "last_7_days", ...o });

let db: ReturnType<typeof createFakeDb>;
let n = 0;
const id = (p: string) => `${p}${++n}`;

async function seedOrder(extra: Record<string, unknown> = {}, ws = WS) {
  return (await db.order.create({
    data: { workspaceId: ws, orderNumber: id("SY-"), customerId: "cu", status: "CONFIRMED", total: 10, currency: "USD", createdAt: ago(60), sealedAt: ago(30), ...extra },
  } as never)) as { id: string };
}
async function seedConv(extra: Record<string, unknown> = {}, ws = WS) {
  return (await db.conversation.create({
    data: { workspaceId: ws, customerId: "cu", channelId: "ch", channelConversationId: id("cc"), createdAt: ago(120), ...extra },
  } as never)) as { id: string };
}
async function seedMsg(conv: { id: string }, direction: "INBOUND" | "OUTBOUND", at: Date, extra: Record<string, unknown> = {}) {
  return db.message.create({
    data: { workspaceId: WS, conversationId: conv.id, direction, senderType: direction === "INBOUND" ? "CUSTOMER" : "AI", createdAt: at, ...extra },
  } as never);
}

beforeEach(async () => {
  db = createFakeDb();
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w", timezone: "Asia/Damascus" } } as never);
  await db.workspace.create({ data: { id: OTHER, name: "o", slug: "o" } } as never);
});

describe("L-19: منطقة المساحة الزمنية (مش UTC)", () => {
  it("«اليوم» بتبدأ بنص ليل دمشق (UTC+3)، مش نص ليل UTC", async () => {
    // طلب مثبّت 22:30 UTC = 01:30 بتوقيت دمشق اليوم التالي
    await seedOrder({ sealedAt: new Date("2026-11-16T22:30:00Z"), createdAt: new Date("2026-11-16T22:00:00Z") });
    const today = await getReport(db, WS, q({ range: "today" }), canAll, NOW);
    expect(today.range.timezone).toBe("Asia/Damascus");
    expect(today.range.start).toBe("2026-11-16T21:00:00.000Z");
    expect(today.kpis.find((k) => k.key === "sales.sealed")!.value).toEqual({ kind: "count", value: 1 });
    const yesterday = await getReport(db, WS, q({ range: "yesterday" }), canAll, NOW);
    expect(yesterday.kpis.find((k) => k.key === "sales.sealed")!.value).toEqual({ kind: "count", value: 0 });
  });
  it("مفاتيح الأيام بتوقيت المساحة", () => {
    const keys = dayKeys(new Date("2026-11-15T21:00:00Z"), new Date("2026-11-17T21:00:00Z"), "Asia/Damascus");
    expect(keys).toEqual(["2026-11-16", "2026-11-17"]);
  });
  it("الفترة المخصصة بتاريخين بتوقيت المساحة، وأكتر من 92 يومًا بتنرفض", () => {
    const r = resolveReportRange({ range: "custom", from: "2026-11-10", to: "2026-11-12" }, "Asia/Damascus");
    expect(r.start.toISOString()).toBe("2026-11-09T21:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-11-12T21:00:00.000Z");
    expect(() => resolveReportRange({ range: "custom", from: "2026-01-01", to: "2026-11-12" }, "UTC")).toThrow();
  });
});

describe("L-18: اليوم الحالي حي (بلا جدول مجمّع ولا إعادة بناء)", () => {
  it("طلب مثبّت قبل 10 دقايق بيطلع فورًا، وما بنكتب شي بالجدول اليومي ولا بنحط مهمة تجميع", async () => {
    await seedOrder({ sealedAt: ago(10), createdAt: ago(20) });
    const r = await getReport(db, WS, q({ range: "today" }), canAll, NOW);
    expect(r.kpis.find((k) => k.key === "sales.sealed")!.value).toEqual({ kind: "count", value: 1 });
    const today = r.series.points[r.series.points.length - 1]!;
    expect(today.value).toBe(1);
    expect((await db.dailyWorkspaceAnalytics.findMany({ where: { workspaceId: WS } } as never)) as unknown[]).toHaveLength(0);
    expect((await db.backgroundJob.findMany({ where: { workspaceId: WS } } as never)) as unknown[]).toHaveLength(0);
  });
});

describe("المحمّل: عزل المساحات والتعريفات", () => {
  it("طلبات مساحة تانية ما بتدخل الأرقام", async () => {
    await seedOrder({}, OTHER);
    await seedOrder({ total: 7 });
    const r = await getReport(db, WS, q(), canAll, NOW);
    expect(r.kpis.find((k) => k.key === "sales.sealed")!.value).toEqual({ kind: "count", value: 1 });
    expect(r.kpis.find((k) => k.key === "sales.value")!.value).toEqual({ kind: "money", value: [{ currency: "USD", value: 7 }] });
  });
  it("دولار وليرة = سطرين (L-08 على القاعدة)", async () => {
    await seedOrder({ total: 20 });
    await seedOrder({ total: 150000, currency: "SYP" });
    const r = await getReport(db, WS, q(), canAll, NOW);
    const v = r.kpis.find((k) => k.key === "sales.value")!.value;
    expect(v).toEqual({ kind: "money", value: [{ currency: "SYP", value: 150000 }, { currency: "USD", value: 20 }] });
  });
  it("الطلب القديم (حالة مؤكدة بلا sealedAt) بينحسب بتاريخ إنشائه، والمسودة الجديدة لا", async () => {
    await seedOrder({ sealedAt: null, status: "CONFIRMED", createdAt: ago(60) });
    await seedOrder({ sealedAt: null, status: "NEW", createdAt: ago(60) });
    const r = await getReport(db, WS, q(), canAll, NOW);
    expect(r.kpis.find((k) => k.key === "sales.sealed")!.value).toEqual({ kind: "count", value: 1 });
  });
  it("القمع من firstOrderingAt: محادثة نية بلا طلب ما بتنحسب طلب", async () => {
    const c1 = await seedConv();
    const c2 = await seedConv();
    await seedConv();
    await db.conversationReading.create({ data: { workspaceId: WS, conversationId: c1.id, firstOrderingAt: ago(100) } } as never);
    await db.conversationReading.create({ data: { workspaceId: WS, conversationId: c2.id, firstOrderingAt: ago(100) } } as never);
    await seedOrder({ conversationId: c2.id });
    const r = await getReport(db, WS, q({ tab: "conversations" }), canAll, NOW);
    const funnel = r.kpis.find((k) => k.key === "conversations.funnel")!.value;
    if (funnel.kind !== "rows") throw new Error("rows");
    expect(funnel.rows.map((x) => x.count)).toEqual([3, 2, 1, 1, 0, 0]);
  });
  it("زمن أول رد: بلا رد من ساعة بيدخل بزمن انتظاره (L-20)", async () => {
    const answered = await seedConv({ createdAt: ago(200) });
    await seedMsg(answered, "INBOUND", ago(200));
    await seedMsg(answered, "OUTBOUND", ago(198));
    const silent = await seedConv({ createdAt: ago(60) });
    await seedMsg(silent, "INBOUND", ago(60));
    const r = await getReport(db, WS, q({ tab: "conversations" }), canAll, NOW);
    const v = r.kpis.find((k) => k.key === "conversations.first_reply")!.value;
    if (v.kind !== "minutes") throw new Error("minutes");
    expect(v.n).toBe(2);
    expect(v.value).toBe(31); // وسيط {2, 60}
  });
  it("الاستعلام «بلا رد الآن» لحظي وبآخر 24 ساعة وبلا ملاحظات داخلية", async () => {
    const waiting = await seedConv({ lastCustomerMessageAt: ago(30), lastAgentMessageAt: null, status: "OPEN" });
    await seedMsg(waiting, "INBOUND", ago(30));
    await seedConv({ lastCustomerMessageAt: ago(5), status: "OPEN" }); // لسا بمهلتها
    await seedConv({ lastCustomerMessageAt: ago(60), lastAgentMessageAt: ago(50), status: "OPEN" }); // انردّ عليها
    await seedConv({ lastCustomerMessageAt: ago(3000), status: "OPEN" }); // أقدم من 24 ساعة
    const r = await getReport(db, WS, q({ tab: "conversations" }), canAll, NOW);
    expect(r.kpis.find((k) => k.key === "conversations.unanswered_now")!.value).toMatchObject({ kind: "count", value: 1 });
  });
  it("وعد بلا طلب من بيانات التحويل، وأسباب الفشل بالعربي، والكلفة بصلاحيتها", async () => {
    await db.humanHandoff.create({ data: { workspaceId: WS, conversationId: "c", customerId: "cu", reason: "MANUAL", createdAt: ago(10), metadata: { aiClaimedNoOrder: true } } } as never);
    await db.humanHandoff.create({ data: { workspaceId: WS, conversationId: "c2", customerId: "cu", reason: "MANUAL", createdAt: ago(10), metadata: {} } } as never);
    await db.aIUsageLog.create({ data: { workspaceId: WS, purpose: "RESPONSE", provider: "p", model: "m", createdAt: ago(10), success: false, status: "FAILED", error: "Request timed out", costUsd: null } } as never);
    await db.aIUsageLog.create({ data: { workspaceId: WS, purpose: "RESPONSE", provider: "p", model: "m", createdAt: ago(9), success: true, costUsd: 0.5 } } as never);
    const full = await getReport(db, WS, q({ tab: "agent" }), canAll, NOW);
    expect(full.kpis.find((k) => k.key === "agent.ai_promise")!.value).toEqual({ kind: "count", value: 1 });
    const cost = full.kpis.find((k) => k.key === "agent.cost")!.value;
    expect(cost).toMatchObject({ kind: "money", value: [{ currency: "USD", value: 0.5 }] });
    const failures = full.kpis.find((k) => k.key === "agent.failures")!.value;
    if (failures.kind !== "rows") throw new Error("rows");
    expect(failures.rows[0]).toMatchObject({ reason: "مهلة", count: 1 });
    const limited = await getReport(db, WS, q({ tab: "agent" }), canRead, NOW);
    expect(limited.kpis.find((k) => k.key === "agent.cost")!.value.kind).toBe("unavailable");
  });
  it("نجاح الرد: رسالة عميل بمحادثة «الوكيل يرد» أخدت رد وكيل = ناجحة، بدون رد = لا", async () => {
    const a = await seedConv({ aiState: "AI_ACTIVE" });
    await seedMsg(a, "INBOUND", ago(100));
    await seedMsg(a, "OUTBOUND", ago(99), { senderType: "AI" });
    const b = await seedConv({ aiState: "AI_ACTIVE" });
    await seedMsg(b, "INBOUND", ago(90));
    const human = await seedConv({ aiState: "HUMAN_ACTIVE" });
    await seedMsg(human, "INBOUND", ago(80)); // مش لازم يرد عليها الوكيل
    const r = await getReport(db, WS, q({ tab: "agent" }), canAll, NOW);
    expect(r.kpis.find((k) => k.key === "agent.reply_success")!.value).toMatchObject({ kind: "percent", num: 1, den: 2, value: 50 });
    expect(r.kpis.find((k) => k.key === "agent.replies")!.value).toEqual({ kind: "count", value: 1 });
  });
});

describe("المقارنة والتبويبات", () => {
  it("«قارن بالفترة السابقة»: نافذة بنفس الطول قبل الفترة + فرق عن السابقة", async () => {
    await seedOrder({ sealedAt: ago(60), createdAt: ago(90) }); // آخر 7 أيام
    await seedOrder({ sealedAt: ago(60 * 24 * 9), createdAt: ago(60 * 24 * 9 + 30) }); // الفترة اللي قبلها
    await seedOrder({ sealedAt: ago(60 * 24 * 10), createdAt: ago(60 * 24 * 10 + 30) });
    const r = await getReport(db, WS, q({ compare: "1" }), canAll, NOW);
    expect(r.previousRange).toBeDefined();
    const len = new Date(r.range.end).getTime() - new Date(r.range.start).getTime();
    expect(new Date(r.previousRange!.end).getTime() - new Date(r.previousRange!.start).getTime()).toBe(len);
    const k = r.kpis.find((x) => x.key === "sales.sealed")!;
    expect(k.value).toEqual({ kind: "count", value: 1 });
    expect(k.previous).toEqual({ kind: "count", value: 2 });
    expect(k.delta).toBe(-1);
  });
  it("تبويب الفريق: بلا analytics.agents الجدول «غير متاح»، وبالصلاحية فيه الموظفين بأسمائهم", async () => {
    await db.user.create({ data: { id: "u1", name: "سارة", email: "s@x.com" } } as never);
    const c = await seedConv({ assignedAgentId: "u1", createdAt: ago(100) });
    await db.message.create({ data: { workspaceId: WS, conversationId: c.id, direction: "OUTBOUND", senderType: "HUMAN", senderId: "u1", createdAt: ago(50) } } as never);
    const denied = await getReport(db, WS, q({ tab: "team" }), canRead, NOW);
    expect(denied.kpis[0]!.value.kind).toBe("unavailable");
    const ok = await getReport(db, WS, q({ tab: "team" }), canAll, NOW);
    const v = ok.kpis[0]!.value;
    if (v.kind !== "rows") throw new Error("rows");
    expect(v.rows[0]).toMatchObject({ name: "سارة", assigned: 1, replies: 1 });
  });
});

describe("التصدير: نفس أرقام الشاشة ومعها المعادلة", () => {
  it("صف لكل قيمة، والمبالغ لكل عملة، والمعادلة بعمود", async () => {
    await seedOrder({ total: 20 });
    await seedOrder({ total: 100, currency: "SYP" });
    const r = await getReport(db, WS, q(), canAll, NOW);
    const rows = exportRows(r);
    const value = rows.filter((x) => x.metric === "قيمة الطلبات");
    expect(value).toEqual([
      expect.objectContaining({ value: 100, currency: "SYP" }),
      expect.objectContaining({ value: 20, currency: "USD" }),
    ]);
    expect(rows.every((x) => typeof x.formula === "string" && String(x.formula).length > 5)).toBe(true);
    const sealed = rows.find((x) => x.metric === "طلبات مثبّتة")!;
    expect(sealed.value).toBe((r.kpis.find((k) => k.key === "sales.sealed")!.value as { value: number }).value);
  });
});

describe("L-20: SLA — اللي ما انردّ عليهم بيدخلوا الخرق", () => {
  it("محادثة بلا رد من ساعة وهدف 30 دقيقة = خرق (قبل كانت بتتجاهل)", async () => {
    const t0 = Date.now() - 60 * 60_000;
    const silent = await seedConv({ createdAt: new Date(t0) });
    await seedMsg(silent, "INBOUND", new Date(t0));
    const sla = await getSLA(db as unknown as Db, WS, { range: "last_7_days" }, { slaFirstResponseMinutes: 30, slaHandoffResolutionMinutes: null });
    expect(sla.firstResponse.measured).toBe(1);
    expect(sla.firstResponse.breached).toBe(1);
    expect(sla.firstResponse.breachRate).toBe(1);
  });
  it("بلا رد لسا ضمن الهدف مش خرق ولا محسوبة", async () => {
    const t0 = Date.now() - 5 * 60_000;
    const fresh = await seedConv({ createdAt: new Date(t0) });
    await seedMsg(fresh, "INBOUND", new Date(t0));
    const sla = await getSLA(db as unknown as Db, WS, { range: "last_7_days" }, { slaFirstResponseMinutes: 30, slaHandoffResolutionMinutes: null });
    expect(sla.firstResponse.measured).toBe(0);
    expect(sla.firstResponse.breached).toBe(0);
  });
});

describe("L-21: زمن الحل (من updatedAt) انشال", () => {
  it("getConversationAnalytics ما بترجّع resolution، والتصدير ما فيه صفوفه", async () => {
    const r = await getConversationAnalytics(db as unknown as Db, WS, { range: "last_7_days" });
    expect(Object.keys(r)).not.toContain("resolution");
    expect(readFileSync("src/app/api/analytics/export/route.ts", "utf8")).not.toContain("resolution.");
    expect(readFileSync("src/app/(dashboard)/analytics/legacy-analytics.tsx", "utf8")).not.toContain("زمن الحل");
  });
});

describe("المسارات والصلاحيات", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("/api/reports: analytics.read + الفريق/الكلفة بصلاحيتهم داخل getReport", () => {
    const route = read("src/app/api/reports/route.ts");
    expect(route).toContain('permission: "analytics.read"');
    expect(route).toContain("getReport(prisma");
    expect(route).toContain("auth!.can");
    const x = read("src/app/api/reports/export/route.ts");
    expect(x).toContain('permission: "analytics.read"');
    expect(x).toContain("exportRows");
    expect(x).toContain("recordAudit");
    expect(x).toContain("text/csv");
  });
  it("الصفحة بتختار النسخة من مفتاح الواجهة والقديمة محفوظة، والروابط القديمة بتتحوّل", () => {
    const p = read("src/app/(dashboard)/analytics/page.tsx");
    expect(p).toContain("resolveUiVersion");
    expect(p).toContain("<ReportsView />");
    expect(p).toContain("<LegacyAnalytics />");
    const m = read("src/app/(dashboard)/analytics/v2/model.ts");
    for (const old of ["overview", "trends", "products", "ai", "exec", "agents", "campaigns", "automation"]) expect(m).toContain(old);
  });
});

describe("L-19: حقل «توقيت المتجر» بحسابي", () => {
  it("الكرت موجود بالصفحة ويحفظ عبر PUT /api/workspaces، وقائمة المساحات بترجّع المنطقة", () => {
    const card = readFileSync("src/components/settings/workspace-timezone-card.tsx", "utf8");
    expect(card).toContain('method: "PUT"');
    expect(card).toContain("timezone: value");
    expect(card).toContain('can("workspace.manage")');
    expect(readFileSync("src/app/(dashboard)/settings/account/page.tsx", "utf8")).toContain("<WorkspaceTimezoneCard />");
    expect(readFileSync("src/modules/workspaces/service.ts", "utf8")).toMatch(/select: \{ id: true, name: true, slug: true, plan: true, timezone: true/);
  });
});

describe("قيود الكود", () => {
  const DIR = join(process.cwd(), "src", "app", "(dashboard)", "analytics", "v2");
  it("ولا كلمة ممنوعة ولا ملف فوق 300 سطر بمجلد v2", () => {
    for (const f of readdirSync(DIR)) {
      const code = readFileSync(join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(findForbiddenTerms(code).map((x) => x.word), f).toEqual([]);
      expect(code.split("\n").length, f).toBeLessThanOrEqual(300);
    }
  });
});
