/**
 * الحزمة 1.7 — مزامنة حالة الطلب من الـ OMS (02-ORDER-FLOW §10.4).
 * كل حالة OMS ← الحالة المحلية الصح · ما بترجع لورا · طلب نهائي بيوقف استطلاعه ·
 * فشل الـ OMS ما بيغيّر شي · «طلبات العميل الأخيرة» بالرد بتعرض حالة الـ OMS.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { OmsClient, setOmsClientFactory } from "@/modules/oms/client";
import { saveOmsConnection } from "@/modules/oms/connection";
import {
  OMS_POLL_FAST_MS,
  OMS_POLL_SLOW_MS,
  enqueueOmsStatusSyncs,
  handleOmsStatusSyncJob,
  isDueForPoll,
  mapOmsToLocal,
  omsStatusLabel,
  syncOmsOrderStatuses,
} from "@/modules/oms/status-sync";
import { JOB_TYPES } from "@/modules/jobs/service";
import { buildReaderReplyContext } from "@/modules/orders/reader/reply-context";

type Db = Prisma.TransactionClient;
const WS = "ws-sync";
const ACTOR = { userId: "owner-1", workspaceId: WS };
const NOW = new Date("2026-11-17T12:00:00Z");

let db: ReturnType<typeof createFakeDb>;
let remote: Record<string, () => Response>;
let gets: string[];

function fakeOms() {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const m = u.pathname.match(/^\/api\/v1\/orders\/([^/]+)$/);
    if (m && (init?.method ?? "GET") === "GET") {
      gets.push(m[1]);
      return (remote[m[1]] ?? (() => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 })))();
    }
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  }) as typeof fetch;
  setOmsClientFactory((deps) => new OmsClient({ ...deps, fetchImpl, maxGetAttempts: 1, timeoutMs: 2000 }));
}

const ok = (status: string, shipping?: string) => () => Response.json({ order_id: "x", order_number: "SY-1", status, ...(shipping ? { shipping_status: shipping } : {}) });

async function order(over: Record<string, unknown> = {}) {
  return (await db.order.create({
    data: {
      workspaceId: WS,
      orderNumber: `ORD-${Math.random().toString(36).slice(2, 8)}`,
      customerId: "cust-1",
      status: "CONFIRMED",
      confirmationStatus: "CONFIRMED_BY_CUSTOMER",
      omsOrderId: "oms-1",
      handedOffAt: new Date(NOW.getTime() - 30 * 60_000),
      createdAt: new Date(NOW.getTime() - 40 * 60_000),
      total: 30,
      currency: "USD",
      ...over,
    },
  } as never)) as any;
}
const row = (id: string) => (db._stores.order as any[]).find((o) => o.id === id);

beforeEach(async () => {
  db = createFakeDb();
  remote = {};
  gets = [];
  fakeOms();
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
  await saveOmsConnection(db as unknown as Db, ACTOR, { baseUrl: "https://oms.example.com", token: "zk1_test_token_value", autoHandoff: true });
});
afterEach(() => setOmsClientFactory(null));

describe("الخريطة: حالة الـ OMS ← الحالة المحلية", () => {
  it.each([
    [{ status: "CONFIRMED" }, "PROCESSING"],
    [{ status: "CONFIRMED", shippingStatus: "NOT_READY" }, "PROCESSING"],
    [{ status: "CONFIRMED", shippingStatus: "SHIPPED" }, "OUT_FOR_DELIVERY"],
    [{ status: "CONFIRMED", shippingStatus: "OUT_FOR_DELIVERY" }, "OUT_FOR_DELIVERY"],
    [{ status: "CONFIRMED", shippingStatus: "DELIVERED" }, "DELIVERED"],
    [{ status: "CONFIRMED", shippingStatus: "RETURNED" }, "RETURNED"],
    [{ status: "REJECTED" }, "CANCELLED"],
    [{ status: "CANCELLED" }, "CANCELLED"],
    [{ status: "confirmed", shippingStatus: "shipped" }, "OUT_FOR_DELIVERY"],
    [{ status: "NEW" }, null],
    [{ status: "IN_PROGRESS" }, null],
    [{ status: "NO_ANSWER" }, null],
    [{}, null],
  ] as const)("%j ← %s", (oms, expected) => {
    expect(mapOmsToLocal(oms as never)).toBe(expected);
  });

  it("omsStatusLabel بالعربي", () => {
    expect(omsStatusLabel("CONFIRMED", "SHIPPED")).toBe("مؤكد · مشحون");
    expect(omsStatusLabel("NEW", "NOT_READY")).toBe("جديد");
    expect(omsStatusLabel("WEIRD", null)).toBe("WEIRD");
    expect(omsStatusLabel(null, null)).toBe("");
  });
});

describe("المزامنة", () => {
  it("بتحفظ حالة الـ OMS وبتقدّم الحالة المحلية للأمام + سطر تدقيق", async () => {
    const o = await order();
    remote["oms-1"] = ok("CONFIRMED", "SHIPPED");
    const r = await syncOmsOrderStatuses(db as Db, WS, NOW);
    expect(r).toMatchObject({ checked: 1, updated: 1, advanced: 1, failed: 0, aborted: false });
    expect(row(o.id)).toMatchObject({ status: "OUT_FOR_DELIVERY", omsStatus: "CONFIRMED", omsShippingStatus: "SHIPPED" });
    expect(new Date(row(o.id).omsCheckedAt).getTime()).toBe(NOW.getTime());
    expect((db._stores.auditLog as any[]).some((a) => a.action === "order.oms_status_synced" && a.entityId === o.id)).toBe(true);
  });

  it("ما بترجع لورا: حالة محلية أبعد ← بتضل، بس omsStatus بيتحدّث", async () => {
    const o = await order({ status: "OUT_FOR_DELIVERY" });
    remote["oms-1"] = ok("CONFIRMED");
    const r = await syncOmsOrderStatuses(db as Db, WS, NOW);
    expect(r.advanced).toBe(0);
    expect(row(o.id).status).toBe("OUT_FOR_DELIVERY");
    expect(row(o.id).omsStatus).toBe("CONFIRMED");
  });

  it("إلغاء من الـ OMS ← CANCELLED محليًا", async () => {
    const o = await order();
    remote["oms-1"] = ok("REJECTED");
    await syncOmsOrderStatuses(db as Db, WS, NOW);
    expect(row(o.id).status).toBe("CANCELLED");
  });

  it("طلب نهائي بيوقف استطلاعه (ولا نداء للـ OMS)", async () => {
    await order({ status: "DELIVERED" });
    await order({ status: "CANCELLED", omsOrderId: "oms-2" });
    await order({ status: "RETURNED", omsOrderId: "oms-3" });
    const r = await syncOmsOrderStatuses(db as Db, WS, NOW);
    expect(r.checked).toBe(0);
    expect(gets).toHaveLength(0);
  });

  it("طلب بلا omsOrderId (ما انبعت) ما بينسأل عنه", async () => {
    await order({ omsOrderId: null });
    await syncOmsOrderStatuses(db as Db, WS, NOW);
    expect(gets).toHaveLength(0);
  });

  it("الدورية: 10 دقايق أول ساعتين · ساعة بعدها · وقف بعد 14 يوم", () => {
    const base = { status: "CONFIRMED", omsOrderId: "x", createdAt: new Date(NOW.getTime() - 3600_000) };
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    expect(isDueForPoll({ ...base, omsCheckedAt: null }, NOW)).toBe(true);
    expect(isDueForPoll({ ...base, omsCheckedAt: at(5 * 60_000) }, NOW)).toBe(false);
    expect(isDueForPoll({ ...base, omsCheckedAt: at(OMS_POLL_FAST_MS + 1000) }, NOW)).toBe(true);
    const old = { ...base, createdAt: new Date(NOW.getTime() - 5 * 3600_000) };
    expect(isDueForPoll({ ...old, omsCheckedAt: at(30 * 60_000) }, NOW)).toBe(false);
    expect(isDueForPoll({ ...old, omsCheckedAt: at(OMS_POLL_SLOW_MS + 1000) }, NOW)).toBe(true);
    const ancient = { ...base, createdAt: new Date(NOW.getTime() - 15 * 24 * 3600_000), handedOffAt: new Date(NOW.getTime() - 15 * 24 * 3600_000) };
    expect(isDueForPoll({ ...ancient, omsCheckedAt: null }, NOW)).toBe(false);
    expect(isDueForPoll({ ...base, omsOrderId: null, omsCheckedAt: null }, NOW)).toBe(false);
  });

  it("المستحق بس بيتسأل عنه", async () => {
    const fresh = await order({ omsCheckedAt: new Date(NOW.getTime() - 60_000) });
    const due = await order({ omsOrderId: "oms-2", omsCheckedAt: new Date(NOW.getTime() - 20 * 60_000) });
    remote["oms-2"] = ok("CONFIRMED");
    await syncOmsOrderStatuses(db as Db, WS, NOW);
    expect(gets).toEqual(["oms-2"]);
    expect(row(fresh.id).omsCheckedAt.getTime()).toBe(NOW.getTime() - 60_000);
    expect(row(due.id).omsStatus).toBe("CONFIRMED");
  });
});

describe("فشل الـ OMS ما بيغيّر شي", () => {
  it("خطأ سيرفر ← ولا تغيير، والدفعة بتوقف (ما منضرب سيرفر واقع)", async () => {
    const a = await order();
    const b = await order({ omsOrderId: "oms-2" });
    remote["oms-1"] = () => Response.json({ error: { code: "BOOM" } }, { status: 500 });
    remote["oms-2"] = ok("CONFIRMED", "DELIVERED");
    const r = await syncOmsOrderStatuses(db as Db, WS, NOW);
    expect(r.aborted).toBe(true);
    for (const o of [a, b]) {
      expect(row(o.id).status).toBe("CONFIRMED");
      expect(row(o.id).omsStatus ?? null).toBeNull();
      expect(row(o.id).omsCheckedAt ?? null).toBeNull();
    }
  });

  it("توكن غلط ← ولا تغيير + تسجيل رمز الخطأ بالربط", async () => {
    const a = await order();
    remote["oms-1"] = () => Response.json({ error: { code: "TOKEN_INVALID" } }, { status: 401 });
    const r = await syncOmsOrderStatuses(db as Db, WS, NOW);
    expect(r.aborted).toBe(true);
    expect(row(a.id).status).toBe("CONFIRMED");
    expect(((db._stores.omsConnection as any[])[0]).lastError).toBe("OMS_AUTH_FAILED");
  });

  it("طلب واحد 404 ← بيتخطّى وبيكمّل عالباقي", async () => {
    await order({ omsOrderId: "gone" });
    const b = await order({ omsOrderId: "oms-2" });
    remote["oms-2"] = ok("CONFIRMED", "SHIPPED");
    const r = await syncOmsOrderStatuses(db as Db, WS, NOW);
    expect(r).toMatchObject({ failed: 1, aborted: false, advanced: 1 });
    expect(row(b.id).status).toBe("OUT_FOR_DELIVERY");
  });

  it("ربط مطفي/ناقص ← ولا شي والمهمة بتنجح", async () => {
    await order();
    (db._stores.omsConnection as any[])[0].isActive = false;
    (db._stores.omsConnection as any[])[0].tokenEncrypted = "";
    const res = await handleOmsStatusSyncJob(db as Db, WS);
    expect(res.success).toBe(true);
    expect(gets).toHaveLength(0);
  });
});

describe("الجدولة والمهمة", () => {
  it("مهمة لكل مساحة ربطها فعّال بمفتاح (مساحة · دورة 10 دقايق) ولا تكرار", async () => {
    expect(await enqueueOmsStatusSyncs(db as Db, NOW)).toBe(1);
    expect(await enqueueOmsStatusSyncs(db as Db, new Date(NOW.getTime() + 60_000))).toBe(0);
    expect(await enqueueOmsStatusSyncs(db as Db, new Date(NOW.getTime() + OMS_POLL_FAST_MS))).toBe(1);
    const j = (db._stores.backgroundJob as any[]).filter((x) => x.type === "sync_oms_order_status");
    expect(j).toHaveLength(2);
    expect(j[0].idempotencyKey.startsWith(`oms-status:${WS}:`)).toBe(true);
  });

  it("مسجّلة بأنواع المهام والمعالجات والمجدول", () => {
    expect(JOB_TYPES).toContain("sync_oms_order_status");
    expect(readFileSync("src/modules/jobs/handlers.ts", "utf8")).toContain("sync_oms_order_status:");
    expect(readFileSync("src/modules/integrations/scheduler.ts", "utf8")).toContain("enqueueOmsStatusSyncs");
  });
});

describe("«طلبات العميل الأخيرة» بالرد بتعرض حالة الـ OMS", () => {
  it("مؤكد · مشحون", async () => {
    const o = await order({ customerId: "cust-1", sealedAt: new Date(), conversationId: "conv-1", omsStatus: "CONFIRMED", omsShippingStatus: "SHIPPED" });
    const ctx = await buildReaderReplyContext(db as Db, { workspaceId: WS, conversationId: "conv-1", customerId: "cust-1" });
    expect(ctx.recentOrders).toContain(o.orderNumber);
    expect(ctx.recentOrders).toContain("عند الـ OMS: مؤكد · مشحون");
    expect(ctx.orderCard).toContain("(عند الـ OMS: مؤكد · مشحون)");
  });
});
