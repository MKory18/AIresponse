import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OrderStatus } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { decryptSecret, encryptSecret } from "@/core/crypto";
import type { Db } from "@/modules/customers/service";
import { setIntegrationDnsLookup } from "@/modules/integrations/connections";
import { captureAttribution } from "@/modules/integrations/attribution";
import { conversationRef } from "@/modules/integrations/format";
import {
  OMS_APP_EVENTS,
  handleOmsAppWebhook,
  omsAppEnvelopeSchema,
  omsStatusForAppEvent,
  type OmsAppEnvelope,
} from "@/modules/oms/app-webhook";
import { buildOmsIntake, formatOmsIntakeText, linkManualOmsOrder, normalizeOmsOrderNumber, sourceLabel, unlinkManualOmsOrder } from "@/modules/oms/manual";
import { OMS_NO_TOKEN, getOmsConnectionView, probeOmsConnection, saveOmsConnection } from "@/modules/oms/connection";
import { AUTO_HANDOFF_ACTOR, handleAutoHandoffJob, maybeEnqueueAutoHandoff } from "@/modules/oms/auto-handoff";
import { OmsClient, setOmsClientFactory, toV1OrderBody, type OmsOrderPayload } from "@/modules/oms/client";
import { handoffOrderToOms } from "@/modules/oms/handoff";
import { buildOmsClient, syncCustomersFromOms, syncProductsFromOms } from "@/modules/oms/sync";
import { canReachOrderStatus, canTransitionOrder } from "@/modules/orders/state-machine";
import { createOrderFromDraft } from "@/modules/orders/order-service";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createProduct } from "@/modules/products/service";

/**
 * P12 — ربط الـ OMS الحقيقي (أحداث «التطبيقات» · الوضع اليدوي · الاتصال ·
 * عقد v1 · الترحيل التلقائي ولقطة الإسناد على الطلب).
 * اختبارات HTTP لمسار /api/webhooks/oms/[key] بملف p12-v1-routes.test.ts.
 */

const WS = "ws-p12-oms";
const WS_B = "ws-p12-oms-b";
const ctx = { userId: "owner-1", workspaceId: WS };
const ctxB = { userId: "owner-b", workspaceId: WS_B };
const SECRET = "test-oms-webhook-secret-0000000000000001";

// الاختبارات لا تلمس الشبكة: محلّل DNS قابل للتبديل لكل اختبار (FAIL = فشل حل).
const dns = new Map<string, string>();
beforeAll(() =>
  setIntegrationDnsLookup(async (host) => {
    const addr = dns.get(host) ?? "93.184.216.34";
    if (addr === "FAIL") throw new Error("ENOTFOUND");
    return [{ address: addr, family: 4 }];
  })
);
afterAll(() => setIntegrationDnsLookup(null));
afterEach(() => {
  dns.clear();
  setOmsClientFactory(null);
  delete process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORK;
});

type FakeDb = ReturnType<typeof createFakeDb>;
type Row = Record<string, any>;

function fake(): FakeDb {
  const db = createFakeDb();
  db._stores.workspace.push(
    { id: WS, name: "Zaki", slug: "zaki", timezone: "Asia/Amman", integrationSettings: {} },
    { id: WS_B, name: "Other", slug: "other", timezone: "UTC", integrationSettings: {} }
  );
  return db;
}
const asDb = (db: FakeDb) => db as unknown as Db;

let seq = 0;
async function seedOrder(db: FakeDb, o: Row = {}): Promise<Row> {
  seq += 1;
  const workspaceId = o.workspaceId ?? WS;
  const customer = (await db.customer.create({
    data: { workspaceId, name: "محمد", phone: `09300000${String(seq).padStart(2, "0")}`, ...(o.customer ?? {}) },
  } as never)) as Row;
  const { customer: _c, items, ...rest } = o;
  const created = (await db.order.create({
    data: {
      workspaceId,
      orderNumber: `ORD-T${seq}`,
      customerId: customer.id,
      status: "CONFIRMED",
      confirmationStatus: "CONFIRMED_BY_CUSTOMER",
      deliveryAddress: "المزة",
      province: "دمشق",
      notes: null,
      subtotal: 450000,
      discount: 0,
      deliveryFee: 5000,
      total: 455000,
      currency: "SYP",
      omsOrderId: null,
      omsOrderNumber: null,
      omsStatus: null,
      items: {
        create: items ?? [{ productNameSnapshot: "ماء الكمأة", skuSnapshot: "TW-500", unitPrice: 150000, quantity: 3, subtotal: 450000 }],
      },
      ...rest,
    },
  } as never)) as Row;
  return created;
}
const orderRow = (db: FakeDb, id: string) => db._stores.order.find((o) => o.id === id)!;
const audits = (db: FakeDb, action: string) => db._stores.auditLog.filter((a) => a.action === action);

function env(event: string, data: Row = {}, at = new Date().toISOString()): OmsAppEnvelope {
  return { event, at, data: { ...data } } as OmsAppEnvelope;
}
const conn = { id: "oms-conn-1", workspaceId: WS };

// ─────────────────────────────── الحالة لكل حدث ───────────────────────────────

describe("P12 OMS app events — الحالة لكل حدث ومخطط الغلاف", () => {
  it("الأحداث الستة بالضبط وكل حدث له حالة الـ OMS الصحيحة", () => {
    expect([...OMS_APP_EVENTS].sort()).toEqual(
      ["order.cancelled", "order.confirmed", "order.created", "order.delivered", "order.returned", "order.shipped"].sort()
    );
    expect(omsStatusForAppEvent(env("order.created"))).toBe("NEW");
    expect(omsStatusForAppEvent(env("order.confirmed"))).toBe("CONFIRMED");
    expect(omsStatusForAppEvent(env("order.cancelled"))).toBe("CANCELLED");
    expect(omsStatusForAppEvent(env("order.delivered"))).toBe("DELIVERED");
    expect(omsStatusForAppEvent(env("order.returned"))).toBe("RETURNED");
    expect(omsStatusForAppEvent(env("order.shipped", { shippingStatus: "IN_TRANSIT" }))).toBe("SHIPPED");
    expect(omsStatusForAppEvent(env("order.shipped", { shippingStatus: "OUT_FOR_DELIVERY" }))).toBe("OUT_FOR_DELIVERY");
    expect(omsStatusForAppEvent(env("order.updated"))).toBeNull();
    expect(omsStatusForAppEvent(env("ORDER.SHIPPED"))).toBeNull();
  });

  it("الغلاف: data إلزامي و event غير فارغ — والحقول الإضافية من الـ OMS تمر", () => {
    expect(omsAppEnvelopeSchema.safeParse({ event: "order.shipped", data: {} }).success).toBe(true);
    expect(omsAppEnvelopeSchema.safeParse({ event: "", data: {} }).success).toBe(false);
    expect(omsAppEnvelopeSchema.safeParse({ event: "order.shipped" }).success).toBe(false);
    const real = {
      event: "order.shipped",
      at: "2026-10-11T09:00:00.000Z",
      data: { orderId: "cm1", orderNumber: "1001", shippingStatus: "SHIPPED", previousStatus: "CONFIRMED", total: "455000.00", currency: "SYP", trackingNumber: "TRK-9" },
    };
    const parsed = omsAppEnvelopeSchema.safeParse(real);
    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data.data as Row).currency).toBe("SYP");
  });
});

// ─────────────────────────── آلة الحالات: للأمام فقط ───────────────────────────

describe("P12 canReachOrderStatus — قفزات الـ OMS للأمام فقط", () => {
  const ALL: OrderStatus[] = [
    "NEW",
    "CONFIRMATION_PENDING",
    "CONFIRMED",
    "PROCESSING",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "CANCELLED",
    "FAILED",
    "RETURNED",
  ];

  it("قفزات الـ OMS الحقيقية مسموحة (مؤكد ← مشحون ← مُسلَّم)", () => {
    expect(canTransitionOrder("CONFIRMED", "OUT_FOR_DELIVERY")).toBe(false);
    expect(canReachOrderStatus("CONFIRMED", "OUT_FOR_DELIVERY")).toBe(true);
    expect(canReachOrderStatus("CONFIRMED", "DELIVERED")).toBe(true);
    expect(canReachOrderStatus("NEW", "DELIVERED")).toBe(true);
    expect(canReachOrderStatus("CONFIRMED", "RETURNED")).toBe(true);
    expect(canReachOrderStatus("DELIVERED", "RETURNED")).toBe(true);
  });

  it("لا رجوع للخلف ولا خروج من حالة نهائية ولا «وصول» لنفس الحالة", () => {
    expect(canReachOrderStatus("DELIVERED", "OUT_FOR_DELIVERY")).toBe(false);
    expect(canReachOrderStatus("OUT_FOR_DELIVERY", "CONFIRMED")).toBe(false);
    expect(canReachOrderStatus("DELIVERED", "CANCELLED")).toBe(false);
    for (const terminal of ["CANCELLED", "FAILED", "RETURNED"] as OrderStatus[]) {
      for (const to of ALL) expect(canReachOrderStatus(terminal, to)).toBe(false);
    }
    for (const s of ALL) expect(canReachOrderStatus(s, s)).toBe(false);
  });

  it("خاصية: كل انتقال مباشر قابل للوصول، ولا دورة (a→b و b→a معًا مستحيل)", () => {
    for (const a of ALL) {
      for (const b of ALL) {
        if (canTransitionOrder(a, b)) expect(canReachOrderStatus(a, b)).toBe(true);
        if (a !== b) expect(canReachOrderStatus(a, b) && canReachOrderStatus(b, a)).toBe(false);
      }
    }
  });
});

// ────────────────────────── معالجة أحداث التطبيقات ──────────────────────────

describe("P12 handleOmsAppWebhook — مطابقة · ربط · مرآة الحالة", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = fake();
  });

  it("طلب مرحَّل بالـ API: order.shipped يقفز من مؤكد إلى «بالتوصيل» مع مرآة الحالة", async () => {
    const o = await seedOrder(db, { omsOrderId: "cm_oms_1" });
    const res = await handleOmsAppWebhook(asDb(db), {
      connection: conn,
      envelope: env("order.shipped", { orderId: "cm_oms_1", shippingStatus: "SHIPPED", trackingNumber: "TRK-77" }),
      deliveryId: "dlv_1",
    });
    expect(res).toMatchObject({ outcome: "applied", orderId: o.id, appliedLocalStatus: "OUT_FOR_DELIVERY", duplicate: false, stale: false });
    const row = orderRow(db, o.id);
    expect(row.status).toBe("OUT_FOR_DELIVERY");
    expect(row.omsStatus).toBe("SHIPPED");
    const audit = audits(db, "oms.status_changed");
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.note).toBe("tracking:TRK-77");
  });

  it("order.delivered مباشرة بعد مؤكد = مُسلَّم (القفز عبر مسار صالح)", async () => {
    const o = await seedOrder(db, { omsOrderId: "cm_oms_2" });
    const res = await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.delivered", { orderId: "cm_oms_2" }), deliveryId: "d2" });
    expect(res).toMatchObject({ outcome: "applied", appliedLocalStatus: "DELIVERED" });
    expect(orderRow(db, o.id).status).toBe("DELIVERED");
  });

  it("order.created / order.confirmed = مرآة فقط (لا تغيير للحالة المحلية المؤكدة)", async () => {
    const o = await seedOrder(db, { omsOrderId: "cm_oms_3" });
    const created = await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.created", { orderId: "cm_oms_3" }, "2026-10-11T08:00:00.000Z"), deliveryId: "c1" });
    expect(created).toMatchObject({ outcome: "applied", appliedLocalStatus: null });
    expect(orderRow(db, o.id).omsStatus).toBe("NEW");
    const confirmed = await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.confirmed", { orderId: "cm_oms_3" }, "2026-10-11T08:05:00.000Z"), deliveryId: "c2" });
    expect(confirmed).toMatchObject({ outcome: "applied", appliedLocalStatus: null });
    expect(orderRow(db, o.id).status).toBe("CONFIRMED");
    expect(orderRow(db, o.id).omsStatus).toBe("CONFIRMED");
  });

  it("الربط اليدوي بالرقم: أول حدث يكمّل معرّف الـ OMS ثم المطابقة بالمعرّف وحده", async () => {
    const o = await seedOrder(db, { omsOrderNumber: "A-1001", handoffMode: "manual", createdAt: new Date("2026-10-11T07:00:00.000Z") });
    const first = await handleOmsAppWebhook(asDb(db), {
      connection: conn,
      envelope: env("order.confirmed", { orderId: "cm_real_9", orderNumber: "A-1001" }, "2026-10-11T08:00:00.000Z"),
      deliveryId: "m1",
    });
    expect(first.outcome).toBe("applied");
    const row = orderRow(db, o.id);
    expect(row.omsOrderId).toBe("cm_real_9");
    expect(row.omsOrderNumber).toBe("A-1001");
    const link = audits(db, "oms.order_link_completed");
    expect(link).toHaveLength(1);
    expect(link[0]).toMatchObject({ entityId: o.id, workspaceId: WS });
    // الحدث التالي بلا رقم — المعرّف وحده يكفي الآن.
    const next = await handleOmsAppWebhook(asDb(db), {
      connection: conn,
      envelope: env("order.shipped", { orderId: "cm_real_9" }, "2026-10-11T09:00:00.000Z"),
      deliveryId: "m2",
    });
    expect(next).toMatchObject({ outcome: "applied", appliedLocalStatus: "OUT_FOR_DELIVERY" });
    expect(audits(db, "oms.order_link_completed")).toHaveLength(1);
  });

  it("طلب مرحَّل بالـ API بلا رقم: أول حدث يكمّل الرقم أيضًا (والعكس)", async () => {
    const o = await seedOrder(db, { omsOrderId: "cm_oms_4" });
    await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.confirmed", { orderId: "cm_oms_4", orderNumber: "2002" }), deliveryId: "n1" });
    expect(orderRow(db, o.id).omsOrderNumber).toBe("2002");
    expect(orderRow(db, o.id).omsOrderId).toBe("cm_oms_4");
  });

  it("طلب مش إلنا = «تجاهل» بلا أي كتابة (لا webhookEvent · لا سجل · لا تغيير)", async () => {
    const o = await seedOrder(db, { omsOrderId: "cm_oms_5" });
    const before = JSON.stringify(db._stores.order);
    const res = await handleOmsAppWebhook(asDb(db), {
      connection: conn,
      envelope: env("order.shipped", { orderId: "cm_unknown", orderNumber: "9999" }),
      deliveryId: "u1",
    });
    expect(res).toEqual({ outcome: "ignored", reason: "UNKNOWN_ORDER" });
    expect(JSON.stringify(db._stores.order)).toBe(before);
    expect(db._stores.webhookEvent).toHaveLength(0);
    expect(db._stores.auditLog).toHaveLength(0);
    expect(orderRow(db, o.id).status).toBe("CONFIRMED");
  });

  it("المطابقة داخل مساحة الاتصال فقط: نفس الرقم بمساحة تانية لا يُلمس", async () => {
    const other = await seedOrder(db, { workspaceId: WS_B, omsOrderNumber: "A-1001" });
    const res = await handleOmsAppWebhook(asDb(db), {
      connection: conn,
      envelope: env("order.delivered", { orderId: "cm_x", orderNumber: "A-1001" }),
      deliveryId: "iso1",
    });
    expect(res).toEqual({ outcome: "ignored", reason: "UNKNOWN_ORDER" });
    const row = orderRow(db, other.id);
    expect(row.omsOrderId ?? null).toBeNull();
    expect(row.status).toBe("CONFIRMED");
  });

  it("حدث بلا معرّف ولا رقم = NO_ORDER_REF · حدث غير مدعوم = UNSUPPORTED_EVENT", async () => {
    await seedOrder(db, { omsOrderId: "cm_oms_6" });
    expect(await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.shipped", { orderId: "  " }), deliveryId: "x" })).toEqual({
      outcome: "ignored",
      reason: "NO_ORDER_REF",
    });
    expect(await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.updated", { orderId: "cm_oms_6" }), deliveryId: "y" })).toEqual({
      outcome: "ignored",
      reason: "UNSUPPORTED_EVENT",
    });
    expect(db._stores.webhookEvent).toHaveLength(0);
  });

  it("نفس X-Zaki-Delivery مرتين = معالجة واحدة (مكرر بلا أثر ثاني)", async () => {
    const o = await seedOrder(db, { omsOrderId: "cm_oms_7" });
    const input = { connection: conn, envelope: env("order.shipped", { orderId: "cm_oms_7" }), deliveryId: "dup-1" };
    const a = await handleOmsAppWebhook(asDb(db), input);
    const b = await handleOmsAppWebhook(asDb(db), input);
    expect(a).toMatchObject({ outcome: "applied", duplicate: false });
    expect(b).toMatchObject({ outcome: "applied", duplicate: true, appliedLocalStatus: null });
    expect(audits(db, "oms.status_changed")).toHaveLength(1);
    expect(db._stores.webhookEvent).toHaveLength(1);
    expect(orderRow(db, o.id).status).toBe("OUT_FOR_DELIVERY");
  });

  it("بلا X-Zaki-Delivery: نفس الحدث (نفس at) لا يُعالج مرتين أيضًا", async () => {
    await seedOrder(db, { omsOrderId: "cm_oms_8" });
    const envelope = env("order.shipped", { orderId: "cm_oms_8" }, "2026-10-11T07:00:00.000Z");
    await handleOmsAppWebhook(asDb(db), { connection: conn, envelope, deliveryId: null });
    const again = await handleOmsAppWebhook(asDb(db), { connection: conn, envelope, deliveryId: null });
    expect(again).toMatchObject({ duplicate: true });
    expect(audits(db, "oms.status_changed")).toHaveLength(1);
  });

  it("حالة نهائية لا ترجع للخلف: مُسلَّم + shipped متأخر = مرآة فقط · ملغى + delivered = يبقى ملغى", async () => {
    const delivered = await seedOrder(db, { omsOrderId: "cm_d", status: "DELIVERED" });
    const r1 = await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.shipped", { orderId: "cm_d" }, "2026-10-11T08:00:00.000Z"), deliveryId: "t1" });
    expect(r1).toMatchObject({ outcome: "applied", appliedLocalStatus: null });
    expect(orderRow(db, delivered.id).status).toBe("DELIVERED");

    const cancelled = await seedOrder(db, { omsOrderId: "cm_c", status: "CANCELLED" });
    const r2 = await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.delivered", { orderId: "cm_c" }), deliveryId: "t2" });
    expect(r2).toMatchObject({ appliedLocalStatus: null });
    expect(orderRow(db, cancelled.id).status).toBe("CANCELLED");

    const returned = await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.returned", { orderId: "cm_d" }, "2026-10-11T09:00:00.000Z"), deliveryId: "t3" });
    expect(returned).toMatchObject({ appliedLocalStatus: "RETURNED" });
    expect(orderRow(db, delivered.id).status).toBe("RETURNED");
  });

  it("حدث وصل متأخرًا (at أقدم من آخر حالة مطبّقة) = stale لا يُطبّق", async () => {
    const o = await seedOrder(db, { omsOrderId: "cm_s" });
    await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.delivered", { orderId: "cm_s" }, "2026-10-11T10:00:00.000Z"), deliveryId: "s1" });
    const late = await handleOmsAppWebhook(asDb(db), {
      connection: conn,
      envelope: env("order.cancelled", { orderId: "cm_s" }, "2026-10-11T09:00:00.000Z"),
      deliveryId: "s2",
    });
    expect(late).toMatchObject({ outcome: "applied", stale: true, appliedLocalStatus: null });
    expect(orderRow(db, o.id).status).toBe("DELIVERED");
    expect(orderRow(db, o.id).omsStatus).toBe("DELIVERED");
  });

  it("ربط يدوي خاطئ على نفس الرقم: الحدث بيروح للطلب الصحيح بالمعرّف، والخاطئ ما بينلمس بس بيتعلّم بالسجل", async () => {
    // Order.omsOrderId @unique بقاعدة البيانات — الـ fake ما بيفرضه على update فنحاكيه هنا.
    const base = db.order.update.bind(db.order);
    (db.order as Row).update = async (args: Row) => {
      const id = args.data?.omsOrderId;
      if (id && db._stores.order.some((r) => r.omsOrderId === id && r.id !== args.where.id)) {
        throw Object.assign(new Error("Unique constraint failed on omsOrderId"), { code: "P2002" });
      }
      return base(args as never);
    };
    const wrong = await seedOrder(db, { omsOrderNumber: "N-55", handoffMode: "manual" });
    const owner = await seedOrder(db, { omsOrderId: "cm_owner" });
    const res = await handleOmsAppWebhook(asDb(db), {
      connection: conn,
      envelope: env("order.shipped", { orderId: "cm_owner", orderNumber: "N-55" }),
      deliveryId: "conf-1",
    });
    expect(res.outcome).toBe("applied");
    expect(orderRow(db, owner.id).status).toBe("OUT_FOR_DELIVERY");
    expect(orderRow(db, wrong.id).omsOrderId ?? null).toBeNull();
    expect(orderRow(db, wrong.id).status).toBe("CONFIRMED");
    expect(audits(db, "oms.manual_link_suspect").map((a) => a.entityId)).toEqual([wrong.id]);
  });

  it("معرّف OMS مربوط فعلًا بطلب تاني (تعارض حقيقي) لا يُسرق بصمت", async () => {
    const base = db.order.update.bind(db.order);
    (db.order as Row).update = async (args: Row) => {
      const id = args.data?.omsOrderId;
      if (id && db._stores.order.some((r) => r.omsOrderId === id && r.id !== args.where.id)) {
        throw Object.assign(new Error("Unique constraint failed on omsOrderId"), { code: "P2002" });
      }
      return base(args as never);
    };
    // الطلب صاحب المعرّف بمساحة تانية (ما بينطابق هون) — والرقم مربوط يدويًا محليًا.
    const manual = await seedOrder(db, { omsOrderNumber: "N-77", handoffMode: "manual" });
    db._stores.order.push({ id: "other-ws-order", workspaceId: "ws-other", omsOrderId: "cm_elsewhere", status: "CONFIRMED" });
    const res = await handleOmsAppWebhook(asDb(db), {
      connection: conn,
      envelope: env("order.confirmed", { orderId: "cm_elsewhere", orderNumber: "N-77" }),
      deliveryId: "conf-2",
    });
    expect(res.outcome).toBe("ignored");
    expect(orderRow(db, manual.id).omsOrderId ?? null).toBeNull();
    expect(audits(db, "oms.order_link_conflict")).toHaveLength(1);
  });
});

// ─────────────────────────────── الوضع اليدوي ───────────────────────────────

describe("P12 OMS manual — نص شاشة «إدخال الطلب بالذكاء» بالـ OMS", () => {
  const LABELS = ["الاسم:", "الرقم:", "اسم المحافظة:", "العنوان:", "الطلب ( المنتج ):", "الكمية:", "السعر:", "الملاحظات:", "اسم الصفحة:"];
  const base = {
    customerName: "محمد الأحمد",
    phone: "0930000000",
    province: "دمشق",
    address: "المزة، شارع الجلاء",
    items: [{ productNameSnapshot: "ماء الكمأة", skuSnapshot: "TW-500", unitPrice: 150000, quantity: 3, subtotal: 450000 }],
    discount: 0,
    deliveryFee: 5000,
    total: 455000,
    currency: "SYP",
    notes: null,
    orderNumber: "ORD-ABC",
    source: "واتساب · رمز K7Q2",
  };
  const valueOf = (text: string, label: string) => text.split("\n").find((l) => l.startsWith(label))!.slice(label.length).trim();

  it("تسع أسطر بالترتيب والتسميات الحرفية للـ OMS، والسعر = سطر المنتج كامل بلا توصيل", () => {
    const { text, warnings } = formatOmsIntakeText(base);
    const lines = text.split("\n");
    expect(lines).toHaveLength(9);
    lines.forEach((l, i) => expect(l.startsWith(LABELS[i])).toBe(true));
    expect(valueOf(text, "الاسم:")).toBe("محمد الأحمد");
    expect(valueOf(text, "الرقم:")).toBe("0930000000");
    expect(valueOf(text, "اسم المحافظة:")).toBe("دمشق");
    expect(valueOf(text, "العنوان:")).toBe("المزة، شارع الجلاء");
    expect(valueOf(text, "الطلب ( المنتج ):")).toBe("ماء الكمأة");
    expect(valueOf(text, "الكمية:")).toBe("3");
    expect(valueOf(text, "السعر:")).toBe("450000.00");
    expect(valueOf(text, "اسم الصفحة:")).toBe("واتساب · رمز K7Q2");
    const notes = valueOf(text, "الملاحظات:");
    expect(notes).toContain("ORD-ABC");
    expect(notes).toContain("5000.00");
    expect(notes).toContain("455000.00 SYP");
    expect(warnings).toEqual([]);
  });

  it("خصم على طلب بمنتج واحد يُطرح من السطر (والسطر لا ينزل تحت الصفر)", () => {
    expect(valueOf(formatOmsIntakeText({ ...base, discount: 50000 }).text, "السعر:")).toBe("400000.00");
    expect(valueOf(formatOmsIntakeText({ ...base, discount: 999999 }).text, "السعر:")).toBe("0.00");
  });

  it("أكثر من منتج: السطر الرئيسي = الأغلى، الباقي بالملاحظات مع تحذير، والخصم لا يُطرح بل يُحذّر", () => {
    const { text, warnings } = formatOmsIntakeText({
      ...base,
      discount: 50,
      items: [
        { productNameSnapshot: "صابون", skuSnapshot: "S-1", unitPrice: 100, quantity: 1, subtotal: 100 },
        { productNameSnapshot: "زيت", skuSnapshot: "O-1", unitPrice: 150, quantity: 2, subtotal: 300 },
      ],
    });
    expect(valueOf(text, "الطلب ( المنتج ):")).toBe("زيت");
    expect(valueOf(text, "الكمية:")).toBe("2");
    expect(valueOf(text, "السعر:")).toBe("300.00");
    expect(valueOf(text, "الملاحظات:")).toContain("صابون × 1 = 100.00 SYP");
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toContain("50.00");
  });

  it("سطر جديد داخل العنوان/الاسم لا يحقن حقلًا مزيفًا بالنص (سطر واحد لكل تسمية)", () => {
    const { text } = formatOmsIntakeText({ ...base, address: "شارع 1\nالرقم: 0999999999\r\nالسعر: 1", customerName: "علي\nالكمية: 99" });
    const lines = text.split("\n");
    expect(lines).toHaveLength(9);
    for (const label of LABELS) expect(lines.filter((l) => l.startsWith(label))).toHaveLength(1);
    expect(valueOf(text, "الرقم:")).toBe("0930000000");
    expect(valueOf(text, "الكمية:")).toBe("3");
  });

  it("هاتف/عنوان ناقص = «-» مع تحذير · طلب بلا منتجات = رفض", () => {
    const { text, warnings } = formatOmsIntakeText({ ...base, phone: "", address: "" });
    expect(valueOf(text, "الرقم:")).toBe("-");
    expect(valueOf(text, "العنوان:")).toBe("-");
    expect(warnings).toHaveLength(2);
    expect(() => formatOmsIntakeText({ ...base, items: [] })).toThrowError(expect.objectContaining({ code: "ORDER_HAS_NO_ITEMS" }));
  });

  it("اسم الصفحة (مصدر الطلب) بالعربي حسب القناة والإسناد ولا يتجاوز 40 حرف", () => {
    expect(sourceLabel("whatsapp", "CODE", "K7Q2")).toBe("واتساب · رمز K7Q2");
    expect(sourceLabel("messenger", "AD", null)).toBe("ماسنجر · إعلان");
    expect(sourceLabel("instagram", "NONE", null)).toBe("إنستغرام · الردود");
    expect(sourceLabel("whatsapp", "CODE", null)).toBe("واتساب · الردود");
    expect(sourceLabel(null, null, null)).toBe("الردود · الردود");
    expect(sourceLabel("telegram", "CODE", "ABCDEFGHIJ12".repeat(5)).length).toBeLessThanOrEqual(40);
  });

  it("buildOmsIntake: المؤكد فقط · لا للقائمة السوداء · لا لطلب مساحة أخرى", async () => {
    const db = fake();
    const pending = await seedOrder(db, { confirmationStatus: "PENDING", status: "NEW" });
    await expect(buildOmsIntake(asDb(db), WS, pending.id)).rejects.toMatchObject({ code: "ORDER_NOT_CONFIRMED" });
    const black = await seedOrder(db, { customer: { isBlacklisted: true } });
    await expect(buildOmsIntake(asDb(db), WS, black.id)).rejects.toMatchObject({ code: "ORDER_CUSTOMER_BLACKLISTED" });
    const foreign = await seedOrder(db, { workspaceId: WS_B });
    await expect(buildOmsIntake(asDb(db), WS, foreign.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("buildOmsIntake: اسم المسودة يغلب، المصدر من لقطة الإسناد، والربط يظهر", async () => {
    const db = fake();
    const draft = (await db.orderDraft.create({ data: { workspaceId: WS, customerName: "أبو خالد", phone: "0944444444" } } as never)) as Row;
    const o = await seedOrder(db, {
      draftId: draft.id,
      channel: "whatsapp",
      attributionMethod: "CODE",
      refCode: "K7Q2",
      orderNumber: "ORD-XYZ",
    });
    const r = await buildOmsIntake(asDb(db), WS, o.id);
    expect(valueOf(r.text, "الاسم:")).toBe("أبو خالد");
    expect(valueOf(r.text, "الرقم:")).toMatch(/^0930000/); // هاتف الزبون الموثوق يغلب هاتف المسودة
    expect(valueOf(r.text, "اسم الصفحة:")).toBe("واتساب · رمز K7Q2");
    expect(r).toMatchObject({ linked: false, omsOrderNumber: null, orderNumber: "ORD-XYZ" });
    await linkManualOmsOrder(asDb(db), ctx, o.id, "SY-2026-1001");
    expect(await buildOmsIntake(asDb(db), WS, o.id)).toMatchObject({ linked: true, omsOrderNumber: "SY-2026-1001" });
  });
});

describe("P12 OMS manual — ربط رقم الـ OMS وفكّه", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = fake();
  });

  it("صيغة الرقم = صيغة الـ OMS (SY-2026-0148) · توحيد: مسافات · # · حروف صغيرة · أرقام عربية · شرطات بديلة", async () => {
    const o = await seedOrder(db);
    for (const bad of ["", "1", "1001", "78120", "-100", "SY-26-0148", "SY-2026-014", "SY_2026_0148", "ر١٠٠", "ORD/2026-15_a", `${"A".repeat(11)}-2026-0148`]) {
      await expect(linkManualOmsOrder(asDb(db), ctx, o.id, bad)).rejects.toMatchObject({ code: "INVALID_OMS_ORDER_NUMBER" });
    }
    expect(orderRow(db, o.id).omsOrderNumber).toBeNull();
    const ok = await linkManualOmsOrder(asDb(db), ctx, o.id, "  #sy-2026-0148  ");
    expect(ok).toEqual({ orderId: o.id, omsOrderNumber: "SY-2026-0148", changed: true });
    expect(normalizeOmsOrderNumber("\u200fJO–٢٠٢٦–٠٠٠٧")).toBe("JO-2026-0007");
    const o2 = await seedOrder(db);
    expect((await linkManualOmsOrder(asDb(db), ctx, o2.id, "JO–٢٠٢٦–٠٠٠٧")).omsOrderNumber).toBe("JO-2026-0007");
  });

  it("ربط ناجح: الرقم + وضع يدوي + وقت الترحيل + حالة NEW + سجل؛ ونفس الرقم مرة تانية = بلا تغيير", async () => {
    const o = await seedOrder(db);
    await linkManualOmsOrder(asDb(db), ctx, o.id, "SY-2026-1001");
    const row = orderRow(db, o.id);
    expect(row).toMatchObject({ omsOrderNumber: "SY-2026-1001", handoffMode: "manual", omsStatus: "NEW" });
    expect(row.handedOffAt).toBeTruthy();
    expect(row.omsOrderId).toBeNull();
    const audit = audits(db, "oms.order_linked_manual");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: "owner-1", entityId: o.id, metadata: { omsOrderNumber: "SY-2026-1001", previous: null } });
    expect(await linkManualOmsOrder(asDb(db), ctx, o.id, "sy-2026-1001")).toMatchObject({ changed: false });
    expect(audits(db, "oms.order_linked_manual")).toHaveLength(1);
    // تصحيح الرقم قبل أول حدث مسموح والسجل يحفظ السابق.
    await linkManualOmsOrder(asDb(db), ctx, o.id, "SY-2026-1002");
    expect(orderRow(db, o.id).omsOrderNumber).toBe("SY-2026-1002");
    expect(audits(db, "oms.order_linked_manual")[1].metadata).toMatchObject({ omsOrderNumber: "SY-2026-1002", previous: "SY-2026-1001" });
  });

  it("رقم محجوز لطلب تاني بنفس المساحة = OMS_ORDER_NUMBER_TAKEN (ومسموح بمساحة أخرى)", async () => {
    const a = await seedOrder(db);
    const b = await seedOrder(db);
    await linkManualOmsOrder(asDb(db), ctx, a.id, "SY-2026-1001");
    await expect(linkManualOmsOrder(asDb(db), ctx, b.id, "SY-2026-1001")).rejects.toMatchObject({ code: "OMS_ORDER_NUMBER_TAKEN", statusCode: 409 });
    expect(orderRow(db, b.id).omsOrderNumber).toBeNull();
    const foreign = await seedOrder(db, { workspaceId: WS_B });
    expect((await linkManualOmsOrder(asDb(db), ctxB, foreign.id, "SY-2026-1001")).changed).toBe(true);
  });

  it("طلب غير مؤكد لا يُربط · طلب مساحة أخرى = غير موجود", async () => {
    const pending = await seedOrder(db, { confirmationStatus: "PENDING", status: "NEW" });
    await expect(linkManualOmsOrder(asDb(db), ctx, pending.id, "SY-2026-1001")).rejects.toMatchObject({ code: "ORDER_NOT_CONFIRMED" });
    const foreign = await seedOrder(db, { workspaceId: WS_B });
    await expect(linkManualOmsOrder(asDb(db), ctx, foreign.id, "SY-2026-1001")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("بعد ما أكمل حدث الـ OMS المعرّف: تغيير الرقم مقفول — بس الربط اليدوي بينفك (رقم غلط) وبينربط من جديد", async () => {
    const o = await seedOrder(db, { createdAt: new Date(Date.now() - 60 * 60_000) });
    await linkManualOmsOrder(asDb(db), ctx, o.id, "SY-2026-1001");
    await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.confirmed", { orderId: "cm_lock", orderNumber: "SY-2026-1001" }), deliveryId: "lock-1" });
    expect(orderRow(db, o.id).omsOrderId).toBe("cm_lock");
    await expect(linkManualOmsOrder(asDb(db), ctx, o.id, "SY-2026-1002")).rejects.toMatchObject({ code: "OMS_LINK_LOCKED", statusCode: 409 });
    // نفس الرقم بعد اكتمال الربط = لا تغيير (لا خطأ).
    expect(await linkManualOmsOrder(asDb(db), ctx, o.id, "SY-2026-1001")).toMatchObject({ changed: false });
    // ربط يدوي = بيضل قابل للفك حتى بعد اكتمال المعرّف (الرقم كتبه موظف).
    await unlinkManualOmsOrder(asDb(db), ctx, o.id);
    expect(orderRow(db, o.id)).toMatchObject({ omsOrderId: null, omsOrderNumber: null, handoffMode: null, omsStatus: null });
    expect(audits(db, "oms.order_unlinked_manual")[0].metadata).toMatchObject({ omsOrderNumber: "SY-2026-1001", hadOmsId: true, omsStatus: "CONFIRMED" });
    // أحداث الرقم الغلط بعد الفك ما بتلمس الطلب.
    const after = await handleOmsAppWebhook(asDb(db), { connection: conn, envelope: env("order.shipped", { orderId: "cm_lock", orderNumber: "SY-2026-1001" }), deliveryId: "lock-2" });
    expect(after).toEqual({ outcome: "ignored", reason: "UNKNOWN_ORDER" });
    expect(orderRow(db, o.id).status).toBe("CONFIRMED");
    expect((await linkManualOmsOrder(asDb(db), ctx, o.id, "SY-2026-1002")).changed).toBe(true);
  });

  it("ترحيل API (معرّف من رد الـ OMS نفسه) ما بينفك يدويًا (OMS_LINK_LOCKED)", async () => {
    const o = await seedOrder(db, { omsOrderId: "cm_api_1", omsOrderNumber: "SY-2026-3001", handoffMode: "api" });
    await expect(unlinkManualOmsOrder(asDb(db), ctx, o.id)).rejects.toMatchObject({ code: "OMS_LINK_LOCKED" });
    expect(orderRow(db, o.id).omsOrderId).toBe("cm_api_1");
  });

  it("الفك يمسح الربط والسجل يحفظ الرقم والحالة؛ طلب غير مربوط = لا شيء", async () => {
    const o = await seedOrder(db);
    await unlinkManualOmsOrder(asDb(db), ctx, o.id);
    expect(audits(db, "oms.order_unlinked_manual")).toHaveLength(0);
    await linkManualOmsOrder(asDb(db), ctx, o.id, "SY-2026-1001");
    await unlinkManualOmsOrder(asDb(db), ctx, o.id);
    expect(orderRow(db, o.id)).toMatchObject({ omsOrderId: null, omsOrderNumber: null, handoffMode: null, handedOffAt: null, omsStatus: null });
    expect(audits(db, "oms.order_unlinked_manual")[0].metadata).toEqual({ omsOrderNumber: "SY-2026-1001", hadOmsId: false, localStatus: "CONFIRMED", omsStatus: "NEW" });
    // بعد الفك الرقم متاح لطلب آخر.
    const other = await seedOrder(db);
    expect((await linkManualOmsOrder(asDb(db), ctx, other.id, "SY-2026-1001")).changed).toBe(true);
  });
});

// ─────────────────────────────── اتصال الـ OMS ───────────────────────────────

describe("P12 saveOmsConnection — وضع الترحيل · الأسرار · مفتاح المسار", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = fake();
  });
  const row = () => db._stores.omsConnection[0];

  it("وضع api بلا توكن حقيقي مرفوض؛ الوضع اليدوي بلا توكن مقبول (بديل لا يصلح لنداء)", async () => {
    await expect(saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", mode: "api" })).rejects.toMatchObject({ code: "OMS_TOKEN_REQUIRED" });
    await expect(saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io" })).rejects.toMatchObject({ code: "OMS_TOKEN_REQUIRED" });
    expect(db._stores.omsConnection).toHaveLength(0);
    const view = await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", mode: "manual" });
    expect(view).toMatchObject({ configured: true, mode: "manual", hasToken: false });
    expect(decryptSecret(row().tokenEncrypted)).toBe(OMS_NO_TOKEN);
    // التحويل لـ api يشترط توكنًا حقيقيًا — البديل لا يُحسب.
    await expect(saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", mode: "api" })).rejects.toMatchObject({ code: "OMS_TOKEN_REQUIRED" });
    const api = await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", mode: "api", token: "oms-real-token-1" });
    expect(api).toMatchObject({ mode: "api", hasToken: true });
    // حفظ تالي بلا توكن يبقي التوكن الحقيقي.
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", isActive: false });
    expect(decryptSecret(row().tokenEncrypted)).toBe("oms-real-token-1");
    expect(row().isActive).toBe(false);
  });

  it("الترحيل التلقائي بوضع api فقط · سر التوقيع ≥ 16 حرف", async () => {
    await expect(
      saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", mode: "manual", autoHandoff: true })
    ).rejects.toMatchObject({ code: "AUTO_HANDOFF_NEEDS_API" });
    await expect(
      saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", mode: "manual", webhookSecret: "zk_short_secret" })
    ).rejects.toMatchObject({ code: "WEBHOOK_SECRET_TOO_SHORT" });
    expect(db._stores.omsConnection).toHaveLength(0);
    const v = await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", token: "tok-123456", autoHandoff: true, webhookSecret: `  ${SECRET}  ` });
    expect(v).toMatchObject({ autoHandoff: true, hasWebhookSecret: true });
    expect(decryptSecret(row().webhookSecretEncrypted)).toBe(SECRET);
  });

  it("مفتاح مسار الاستقبال يتولّد بصيغة يقبلها المسار، ثابت عبر الحفظ، ويتبدل عند الطلب فقط", async () => {
    const v1 = await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", mode: "manual" });
    const key = row().webhookKey as string;
    expect(key).toMatch(/^[A-Za-z0-9_-]{16,64}$/); // نفس regex مسار /api/webhooks/oms/[key]
    expect(v1.webhookPath).toBe(`/api/webhooks/oms/${key}`);
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io" });
    expect(row().webhookKey).toBe(key);
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", rotateWebhookKey: true });
    expect(row().webhookKey).not.toBe(key);
    expect(row().webhookKey).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const saved = audits(db, "oms.connection_saved");
    expect(saved.map((a) => a.metadata.webhookKeyRotated)).toEqual([false, false, true]);
  });

  it("العرض والسجل بلا أسرار: hasToken/hasWebhookSecret فقط", async () => {
    process.env.APP_URL = "https://replies.zaki.io/";
    try {
      const view = await saveOmsConnection(asDb(db), ctx, {
        baseUrl: "https://oms.zaki.io/",
        mode: "api",
        token: "oms-secret-token-xyz",
        webhookSecret: SECRET,
      });
      const shown = JSON.stringify(view);
      expect(shown).not.toContain("oms-secret-token-xyz");
      expect(shown).not.toContain(SECRET);
      for (const k of ["token", "tokenEncrypted", "webhookSecret", "webhookSecretEncrypted"]) expect(view).not.toHaveProperty(k);
      expect(view).toMatchObject({ baseUrl: "https://oms.zaki.io", hasToken: true, hasWebhookSecret: true, apiVersion: "v1" });
      expect(view.webhookUrl).toBe(`https://replies.zaki.io/api/webhooks/oms/${row().webhookKey}`);
      expect(view.events).toEqual(OMS_APP_EVENTS);
      // المخزّن مشفّر لا نص.
      expect(row().tokenEncrypted).not.toContain("oms-secret-token-xyz");
      expect(row().webhookSecretEncrypted).not.toContain(SECRET);
      const auditText = JSON.stringify(db._stores.auditLog);
      expect(auditText).not.toContain("oms-secret-token-xyz");
      expect(auditText).not.toContain(SECRET);
      expect(audits(db, "oms.connection_saved")[0].metadata).toMatchObject({ tokenChanged: true, webhookSecretChanged: true, mode: "api" });
      expect(JSON.stringify(await getOmsConnectionView(asDb(db), WS))).not.toContain("oms-secret-token-xyz");
    } finally {
      delete process.env.APP_URL;
    }
  });

  it("لهجة الـ API: اتصال جديد = v1، اتصال قديم legacy يبقى legacy إلا إذا تغيّر صراحة", async () => {
    db._stores.omsConnection.push({
      id: "legacy-1",
      workspaceId: WS,
      baseUrl: "https://oms.zaki.io",
      tokenEncrypted: encryptSecret("old-token"),
      isActive: true,
      mode: "api",
      apiVersion: "legacy",
      webhookSecretEncrypted: null,
      webhookKey: null,
      autoHandoff: false,
    });
    const v = await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io" });
    expect(v.apiVersion).toBe("legacy");
    expect(v.hasToken).toBe(true);
    expect(row().webhookKey).toMatch(/^[A-Za-z0-9_-]{16,64}$/); // الصف القديم يأخذ مفتاحًا
    expect((await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", apiVersion: "v1" })).apiVersion).toBe("v1");
  });

  it("حارس الرابط: الشبكة الخاصة مرفوضة إلا بعلم المشغّل · http عام مرفوض · DNS يشير لعنوان داخلي مرفوض", async () => {
    await expect(saveOmsConnection(asDb(db), ctx, { baseUrl: "http://127.0.0.1:3000", mode: "manual" })).rejects.toMatchObject({ code: "INVALID_SYSTEM_URL" });
    await expect(saveOmsConnection(asDb(db), ctx, { baseUrl: "http://oms.zaki.io", mode: "manual" })).rejects.toMatchObject({ code: "INVALID_SYSTEM_URL" });
    dns.set("oms.evil.example", "169.254.169.254");
    await expect(saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.evil.example", mode: "manual" })).rejects.toMatchObject({ code: "INVALID_SYSTEM_URL" });
    dns.set("oms.typo.example", "FAIL");
    await expect(saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.typo.example", mode: "manual" })).rejects.toMatchObject({ code: "INVALID_SYSTEM_URL" });
    expect(db._stores.omsConnection).toHaveLength(0);
    process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORK = "true";
    const v = await saveOmsConnection(asDb(db), ctx, { baseUrl: "http://127.0.0.1:3000", mode: "manual" });
    expect(v.baseUrl).toBe("http://127.0.0.1:3000");
  });
});

describe("P12 probeOmsConnection — صحة الـ OMS ثم باب v1", () => {
  type Call = { url: string; init: RequestInit };
  function fetchWith(handler: (url: string) => Response | Promise<Response>, calls: Call[]): typeof fetch {
    return (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return handler(String(url));
    }) as unknown as typeof fetch;
  }

  it("غير مضبوط = OMS_NOT_CONFIGURED", async () => {
    await expect(probeOmsConnection(asDb(fake()), WS, fetchWith(() => new Response("{}"), []))).rejects.toMatchObject({ code: "OMS_NOT_CONFIGURED" });
  });

  it("api + v1: /api/health بلا توكن ثم /api/v1/products?for=replies&limit=1 بالتوكن — 404 = الباب غير موجود", async () => {
    const db = fake();
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io/", token: "probe-token-1", apiVersion: "v1" });
    const calls: Call[] = [];
    const res = await probeOmsConnection(
      asDb(db),
      WS,
      fetchWith((url) => (url.endsWith("/api/health") ? new Response("{}", { status: 200 }) : new Response("", { status: 404 })), calls)
    );
    expect(res).toMatchObject({ reachable: true, status: 404, doorAvailable: false });
    expect(calls.map((c) => c.url)).toEqual(["https://oms.zaki.io/api/health", "https://oms.zaki.io/api/v1/products?for=replies&limit=1"]);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Bearer probe-token-1");
    for (const c of calls) {
      expect(c.init.method).toBe("GET");
      expect(c.init.redirect).toBe("manual");
    }
  });

  it("api + v1: الباب يرد 200 = متاح ويُسجّل lastOkAt · 401 = الباب موجود والتوكن مرفوض", async () => {
    const db = fake();
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", token: "probe-token-1" });
    const ok = await probeOmsConnection(asDb(db), WS, fetchWith(() => new Response("{}", { status: 200 }), []));
    expect(ok).toMatchObject({ reachable: true, status: 200, doorAvailable: true });
    expect(db._stores.omsConnection[0].lastOkAt).toBeTruthy();
    const denied = await probeOmsConnection(
      asDb(db),
      WS,
      fetchWith((url) => (url.endsWith("/api/health") ? new Response("{}") : new Response("", { status: 401 })), [])
    );
    expect(denied).toMatchObject({ reachable: true, status: 401, doorAvailable: true });
  });

  it("legacy أو يدوي: الصحة فقط (لا نداء بالتوكن) · OMS واقف = غير متاح مع lastError", async () => {
    const db = fake();
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", mode: "manual" });
    const calls: Call[] = [];
    const res = await probeOmsConnection(asDb(db), WS, fetchWith(() => new Response("{}"), calls));
    expect(res).toMatchObject({ reachable: true, doorAvailable: null });
    expect(calls).toHaveLength(1);
    const unhealthy = await probeOmsConnection(asDb(db), WS, fetchWith(() => new Response("", { status: 503 }), []));
    expect(unhealthy).toMatchObject({ reachable: false, status: 503 });
    const down = await probeOmsConnection(
      asDb(db),
      WS,
      (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch
    );
    expect(down).toMatchObject({ reachable: false, status: null });
    expect(db._stores.omsConnection[0].lastError).toBe("probe: UNREACHABLE");
  });

  it("اسم انحفظ سليم ثم صار يشير لعنوان داخلي (DNS rebinding) = لا نداء ولا توكن يطلع", async () => {
    const db = fake();
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.rebind.example", token: "probe-token-1" });
    dns.set("oms.rebind.example", "169.254.169.254");
    const calls: Call[] = [];
    const res = await probeOmsConnection(asDb(db), WS, fetchWith(() => new Response("{}"), calls));
    expect(res).toMatchObject({ reachable: false, doorAvailable: null });
    expect(calls).toHaveLength(0);
  });
});

// ─────────────────────────────── عقد v1 للعميل ───────────────────────────────

describe("P12 OmsClient v1 — جسم الطلب والرؤوس", () => {
  const payload: OmsOrderPayload = {
    idempotencyKey: "draft:dr_1",
    orderNumber: "ORD-KX1-ABC",
    customer: { name: "محمد", phone: "0930000000", address: "المزة", province: "دمشق" },
    items: [
      { sku: "TW-500", name: "ماء الكمأة", unitPrice: 0.1 + 0.2, quantity: 3, subtotal: 1234.5 },
      { sku: "S-1", name: "صابون", unitPrice: 20, quantity: 1, subtotal: 19.999 },
    ],
    totals: { subtotal: 150000, discount: -0.5, deliveryFee: 5000, total: 155000, currency: "SYP" },
    notes: "اتصل قبل التوصيل",
    channel: "whatsapp",
    attribution: {
      method: "AD",
      adId: "120211000000000001",
      adSourceType: "ad",
      ctwaClid: "ARAkLkA8rmlFeiCk",
      refCode: null,
      touchAt: "2026-10-11T06:00:00.000Z",
      wabaId: "waba-1",
      conversationRef: conversationRef("conv-1"),
    },
  };

  it("المبالغ نص عشري بخانتين بلا أخطاء كسور، والإسناد كامل بأسماء العقد", () => {
    const body = toV1OrderBody(payload) as Row;
    expect(body).toMatchObject({ external_ref: "ORD-KX1-ABC", source: "replies", channel: "whatsapp", notes: "اتصل قبل التوصيل" });
    expect(body.customer).toEqual({ name: "محمد", phone: "0930000000", city: "دمشق", address: "المزة" });
    expect(body.items[0]).toEqual({ product_code: "TW-500", name: "ماء الكمأة", quantity: 3, unit_price: "0.30", line_total: "1234.50" });
    expect(body.items[1].line_total).toBe("20.00");
    expect(body.totals).toEqual({ subtotal: "150000.00", discount: "-0.50", delivery_fee: "5000.00", total: "155000.00", currency: "SYP" });
    expect(body.attribution).toEqual({
      method: "AD",
      ad_id: "120211000000000001",
      ad_source_type: "ad",
      ctwa_clid: "ARAkLkA8rmlFeiCk",
      ref_code: null,
      ref_code_at: null,
      touch_at: "2026-10-11T06:00:00.000Z",
      page_id: null,
      psid: null,
      waba_id: "waba-1",
      conversation_ref: conversationRef("conv-1"),
    });
    expect(toV1OrderBody({ ...payload, attribution: null }).attribution).toEqual({ method: "NONE" });
  });

  it("createOrder v1: POST /api/v1/orders · Idempotency-Key · X-Request-Id · Bearer · لا تتبّع للتحويلات", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new OmsClient({
      baseUrl: "https://oms.zaki.io/",
      token: "tok-v1",
      apiVersion: "v1",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ order_id: "cm_oms_77", status: "NEW", order_number: "1077" }, { status: 201 });
      }) as unknown as typeof fetch,
    });
    const res = await client.createOrder(payload);
    expect(res).toEqual({ id: "cm_oms_77", status: "NEW", orderNumber: "1077" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oms.zaki.io/api/v1/orders");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h["idempotency-key"]).toBe("draft:dr_1");
    expect(h["x-request-id"]).toBe("rep_ORD-KX1-ABC");
    expect(h.authorization).toBe("Bearer tok-v1");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("manual");
    expect(JSON.parse(String(calls[0].init.body))).toEqual(toV1OrderBody(payload));
  });

  it("createOrder v1: تحويل 3xx مرفوض · رد بلا order_id = OMS_BAD_RESPONSE · 5xx لا يُعاد (POST)", async () => {
    let n = 0;
    const mk = (r: () => Response) =>
      new OmsClient({
        baseUrl: "https://oms.zaki.io",
        token: "t",
        apiVersion: "v1",
        fetchImpl: (async () => {
          n += 1;
          return r();
        }) as unknown as typeof fetch,
      });
    await expect(mk(() => new Response("", { status: 302, headers: { location: "https://evil.example/" } })).createOrder(payload)).rejects.toMatchObject({
      code: "OMS_REDIRECT_REFUSED",
    });
    await expect(mk(() => Response.json({ status: "NEW" })).createOrder(payload)).rejects.toMatchObject({ code: "OMS_BAD_RESPONSE" });
    n = 0;
    await expect(mk(() => new Response("", { status: 503 })).createOrder(payload)).rejects.toMatchObject({ code: "OMS_ERROR" });
    expect(n).toBe(1);
    await expect(mk(() => new Response("", { status: 401 })).createOrder(payload)).rejects.toMatchObject({ code: "OMS_AUTH_FAILED" });
  });
});

// ─────────────────────── الترحيل (v1) ولقطة الإسناد على الطلب ───────────────────────

type OmsCall = { method: string; path: string; headers: Record<string, string>; body: any };
function installFakeOms(respond: (call: OmsCall) => Response | Promise<Response>): OmsCall[] {
  const calls: OmsCall[] = [];
  setOmsClientFactory(
    (deps) =>
      new OmsClient({
        ...deps,
        fetchImpl: (async (url: string, init: RequestInit) => {
          const u = new URL(String(url));
          const call: OmsCall = {
            method: String(init?.method ?? "GET"),
            path: `${u.pathname}${u.search}`,
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: init?.body ? JSON.parse(String(init.body)) : null,
          };
          calls.push(call);
          return respond(call);
        }) as unknown as typeof fetch,
      })
  );
  return calls;
}

describe("P12 createOrderFromDraft — لقطة الإسناد + الترحيل التلقائي للـ OMS", () => {
  const CLID = "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6";
  let db: FakeDb;
  let world: { productId: string; customerId: string; conversationId: string; channelId: string; draftId: string };

  async function seedWorld(channelType: "WHATSAPP" | "FACEBOOK" = "WHATSAPP") {
    db = fake();
    const product = (await createProduct(asDb(db), ctx, { name: "ماء الكمأة", sku: "TW-500", price: 150000, currency: "SYP" } as never)) as Row;
    const customer = (await db.customer.create({ data: { workspaceId: WS, name: "محمد", phone: "0930000000", status: "INTERESTED" } } as never)) as Row;
    const ch = (await db.channel.create({ data: { workspaceId: WS, type: channelType, status: "CONNECTED", displayName: "Main", externalId: "acct-1" } } as never)) as Row;
    const conv = (await db.conversation.create({
      data: { workspaceId: WS, customerId: customer.id, channelId: ch.id, channelConversationId: "963930000000" },
    } as never)) as Row;
    await updateDraftFromExtraction(asDb(db), {
      workspaceId: WS,
      conversationId: conv.id,
      customerId: customer.id,
      extraction: { productId: product.id, quantity: 3, phone: "0930000000", rawAddress: "دويلعة", province: "دمشق" },
      source: "TEST",
    });
    const draft = db._stores.orderDraft.find((d) => d.conversationId === conv.id)!;
    world = { productId: product.id, customerId: customer.id, conversationId: conv.id, channelId: ch.id, draftId: draft.id };
  }

  async function adTouch(hoursAgo = 1) {
    return captureAttribution(asDb(db), {
      workspaceId: WS,
      customerId: world.customerId,
      conversationId: world.conversationId,
      channelType: "WHATSAPP",
      eventKey: `wamid.${hoursAgo}`,
      referral: { source: "wa_referral", adId: "120211000000000001", adSourceType: "ad", ctwaClid: CLID, wabaId: "waba-1" },
      externalUserId: "963930000000",
      occurredAt: new Date(Date.now() - hoursAgo * 3600_000),
    });
  }

  const jobs = () => db._stores.backgroundJob.filter((j) => j.type === "handoff_order_to_oms");

  it("الطلب يحمل لقطة الإعلان الذي فتح المحادثة (رمز النقرة مشفّر فقط)", async () => {
    await seedWorld();
    const [touch] = await adTouch(2);
    expect(touch.episodeStart).toBe(true);
    const res = await createOrderFromDraft(asDb(db), ctx, { draftId: world.draftId });
    const order = orderRow(db, res.orderId);
    expect(order).toMatchObject({
      channel: "whatsapp",
      attributionMethod: "AD",
      adId: "120211000000000001",
      adSourceType: "ad",
      wabaId: "waba-1",
      refCode: null,
      psidEnc: null,
    });
    expect(decryptSecret(order.ctwaClidEnc)).toBe(CLID);
    expect(new Date(order.touchAt).getTime()).toBe(new Date(db._stores.attributionTouch[0].occurredAt).getTime());
    expect(JSON.stringify(order)).not.toContain(CLID);
  });

  it("بلا أي لمسة: NONE بلا تخمين، والقناة من نوع قناة المحادثة", async () => {
    await seedWorld("FACEBOOK");
    const res = await createOrderFromDraft(asDb(db), ctx, { draftId: world.draftId });
    expect(orderRow(db, res.orderId)).toMatchObject({ channel: "messenger", attributionMethod: "NONE", adId: null, refCode: null, ctwaClidEnc: null });
  });

  it("مهمة handoff_order_to_oms فقط إذا الاتصال فعّال + api + ترحيل تلقائي — ومرة واحدة لكل طلب", async () => {
    await seedWorld();
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", token: "oms-token-1", autoHandoff: true });
    const res = await createOrderFromDraft(asDb(db), ctx, { draftId: world.draftId });
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ workspaceId: WS, payload: { orderId: res.orderId }, idempotencyKey: `oms-handoff:${res.orderId}` });
    // إعادة نفس المسودة = نفس الطلب ولا مهمة ثانية.
    const again = await createOrderFromDraft(asDb(db), ctx, { draftId: world.draftId });
    expect(again.created).toBe(false);
    expect(jobs()).toHaveLength(1);
    expect(await maybeEnqueueAutoHandoff(asDb(db), WS, res.orderId)).toBe(true);
    expect(jobs()).toHaveLength(1); // نفس مفتاح عدم التكرار
  });

  it.each([
    ["الوضع اليدوي", { mode: "manual" }],
    ["الترحيل التلقائي مطفأ", { token: "oms-token-1", autoHandoff: false }],
    ["الاتصال موقوف", { token: "oms-token-1", autoHandoff: true, isActive: false }],
  ] as const)("لا مهمة ترحيل: %s", async (_label, input) => {
    await seedWorld();
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", ...input });
    const res = await createOrderFromDraft(asDb(db), ctx, { draftId: world.draftId });
    expect(res.created).toBe(true);
    expect(jobs()).toHaveLength(0);
  });

  it("لا اتصال OMS أصلًا = الطلب ينحفظ بلا مهمة", async () => {
    await seedWorld();
    const res = await createOrderFromDraft(asDb(db), ctx, { draftId: world.draftId });
    expect(res.created).toBe(true);
    expect(jobs()).toHaveLength(0);
    expect(await maybeEnqueueAutoHandoff(asDb(db), WS, res.orderId)).toBe(false);
  });

  it("مسار كامل: مسودة ← طلب ← مهمة الترحيل ← الـ OMS يستلم الإسناد ← حدث shipped يحرّك المرآة", async () => {
    await seedWorld();
    await adTouch(1);
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", token: "oms-token-1", autoHandoff: true });
    const res = await createOrderFromDraft(asDb(db), ctx, { draftId: world.draftId });
    const calls = installFakeOms(() => Response.json({ order_id: "cm_oms_e2e", status: "NEW", order_number: "3003" }, { status: 201 }));
    const out = await handleAutoHandoffJob(asDb(db), jobs()[0].payload, WS);
    expect(out).toEqual({ success: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/orders" });
    expect(calls[0].headers["idempotency-key"]).toBe(`draft:${world.draftId}`);
    expect(calls[0].body.attribution).toMatchObject({
      method: "AD",
      ad_id: "120211000000000001",
      ctwa_clid: CLID, // يُفك لحظة الإرسال للـ OMS فقط
      waba_id: "waba-1",
      conversation_ref: conversationRef(world.conversationId),
    });
    expect(calls[0].body.attribution.conversation_ref).toMatch(/^cv_[a-p]{12}$/);
    expect(calls[0].body.items[0]).toMatchObject({ product_code: "TW-500", quantity: 3, unit_price: "150000.00", line_total: "450000.00" });
    const order = orderRow(db, res.orderId);
    expect(order).toMatchObject({ omsOrderId: "cm_oms_e2e", omsOrderNumber: "3003", handoffMode: "api", omsStatus: "NEW" });
    expect(audits(db, "oms.order_handed_off")[0].userId).toBe(AUTO_HANDOFF_ACTOR);
    // لا شيء من رمز النقرة بالسجلات.
    expect(JSON.stringify(db._stores.auditLog)).not.toContain(CLID);

    const shipped = await handleOmsAppWebhook(asDb(db), {
      connection: { id: db._stores.omsConnection[0].id, workspaceId: WS },
      envelope: env("order.shipped", { orderId: "cm_oms_e2e", orderNumber: "3003" }),
      deliveryId: "e2e-1",
    });
    expect(shipped).toMatchObject({ outcome: "applied", appliedLocalStatus: "OUT_FOR_DELIVERY" });
    // الترحيل مرة تانية = نجاح بلا نداء (الطلب مرتبط).
    expect(await handleAutoHandoffJob(asDb(db), { orderId: res.orderId }, WS)).toEqual({ success: true });
    expect(calls).toHaveLength(1);
  });
});

describe("P12 handoffOrderToOms / المهمة — رفض نهائي مقابل عابر", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = fake();
  });

  it("الوضع اليدوي = OMS_MANUAL_MODE بلا أي نداء، والمهمة تعتبره نهائيًا (لا إعادة)", async () => {
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", mode: "manual" });
    const o = await seedOrder(db);
    const calls = installFakeOms(() => Response.json({ order_id: "x" }));
    await expect(handoffOrderToOms(asDb(db), ctx, o.id)).rejects.toMatchObject({ code: "OMS_MANUAL_MODE" });
    expect(await handleAutoHandoffJob(asDb(db), { orderId: o.id }, WS)).toEqual({ success: true });
    expect(calls).toHaveLength(0);
  });

  it("قائمة سوداء / غير مؤكد = نهائي · انقطاع الـ OMS = إعادة المهمة بنفس المفتاح", async () => {
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", token: "oms-token-1" });
    const black = await seedOrder(db, { customer: { isBlacklisted: true } });
    const pending = await seedOrder(db, { confirmationStatus: "PENDING", status: "NEW" });
    const calls = installFakeOms(() => {
      throw new Error("ECONNRESET");
    });
    expect(await handleAutoHandoffJob(asDb(db), { orderId: black.id }, WS)).toEqual({ success: true });
    expect(await handleAutoHandoffJob(asDb(db), { orderId: pending.id }, WS)).toEqual({ success: true });
    expect(calls).toHaveLength(0);
    const ok = await seedOrder(db, { idempotencyKey: "draft:dr_77" });
    expect(await handleAutoHandoffJob(asDb(db), { orderId: ok.id }, WS)).toEqual({ success: false, error: "OMS_UNREACHABLE" });
    // نتيجة غامضة = محاولة واحدة إضافية بنفس Idempotency-Key ونفس الجسم.
    expect(calls).toHaveLength(2);
    expect(calls[0].headers["idempotency-key"]).toBe("draft:dr_77");
    expect(calls[1].headers["idempotency-key"]).toBe("draft:dr_77");
    expect(calls[1].body).toEqual(calls[0].body);
    expect(orderRow(db, ok.id).omsOrderId).toBeNull();
    // آخر خطأ يظهر بصفحة الربط — رمز فقط.
    expect(db._stores.omsConnection[0].lastError).toBe("handoff: OMS_UNREACHABLE");
  });

  it("رفض نهائي من الـ OMS (422) لا يُعاد ضمن نفس النداء", async () => {
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", token: "oms-token-1" });
    const o = await seedOrder(db);
    const calls = installFakeOms(() => new Response("{}", { status: 422 }));
    await expect(handoffOrderToOms(asDb(db), ctx, o.id)).rejects.toMatchObject({ code: "OMS_ERROR" });
    expect(calls).toHaveLength(1);
  });

  it("لهجة legacy: /oms/orders بلا إسناد (لا رمز نقرة يطلع لنقطة قديمة)", async () => {
    db._stores.omsConnection.push({
      id: "legacy-1",
      workspaceId: WS,
      baseUrl: "https://oms.zaki.io",
      tokenEncrypted: encryptSecret("old-token"),
      isActive: true,
      mode: "api",
      apiVersion: "legacy",
    });
    const o = await seedOrder(db, { attributionMethod: "AD", adId: "1202", ctwaClidEnc: encryptSecret("CLID-LEGACY") });
    const calls = installFakeOms(() => Response.json({ id: "legacy-oms-1", status: "NEW" }));
    const res = await handoffOrderToOms(asDb(db), ctx, o.id);
    expect(res).toEqual({ omsOrderId: "legacy-oms-1", handedOff: true });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/oms/orders" });
    expect(calls[0].body.attribution).toBeNull();
    expect(JSON.stringify(calls[0].body)).not.toContain("CLID-LEGACY");
  });
});

describe("P12 sync — الوضع اليدوي وDNS وشكل v1", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = fake();
  });

  it("الوضع اليدوي = لا مزامنة (OMS_MANUAL_MODE) بلا نداء", async () => {
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", mode: "manual" });
    const calls = installFakeOms(() => Response.json({ items: [] }));
    await expect(syncProductsFromOms(asDb(db), ctx)).rejects.toMatchObject({ code: "OMS_MANUAL_MODE" });
    expect(calls).toHaveLength(0);
  });

  it("اسم صار يشير لعنوان داخلي = OMS_URL_REJECTED قبل خروج التوكن", async () => {
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.rebind.example", token: "oms-token-1" });
    dns.set("oms.rebind.example", "10.0.0.5");
    await expect(buildOmsClient(asDb(db), WS)).rejects.toMatchObject({ code: "OMS_URL_REJECTED" });
  });

  it("v1: المنتجات من items بمبالغ نصية تتحول لأرقام · شكل غلط = OMS_BAD_RESPONSE قبل أي كتابة", async () => {
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", token: "oms-token-1", apiVersion: "v1" });
    let feed: unknown = {
      items: [
        {
          code: "TW-500",
          name: "ماء الكمأة",
          price: "150000.00",
          currency: "SYP",
          wholesale_price: "90000.00",
          discount_cap: "10000.00",
          offers: [{ title: "عرض 2", quantity: 2, price: "280000.00", saving: "20000.00" }],
          complements: ["S-1"],
        },
      ],
    };
    const calls = installFakeOms(() => Response.json(feed));
    const res = await syncProductsFromOms(asDb(db), ctx);
    expect(res).toMatchObject({ synced: 1, failed: 0 });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/products?for=replies" });
    const p = db._stores.product.find((x) => x.sku === "TW-500")!;
    expect(p).toMatchObject({ price: 150000, wholesalePrice: 90000, discountCap: 10000, syncedFromOms: true, complementarySkus: ["S-1"] });
    expect(p.offers[0]).toMatchObject({ quantity: 2, price: 280000, saving: 20000 });
    feed = { products: [] };
    await expect(syncProductsFromOms(asDb(db), ctx)).rejects.toMatchObject({ code: "OMS_BAD_RESPONSE" });
  });

  it("v1: القائمة السوداء من /api/v1/customers/lookup (exists:false = تجاوز)", async () => {
    await saveOmsConnection(asDb(db), ctx, { baseUrl: "https://oms.zaki.io", token: "oms-token-1", apiVersion: "v1" });
    await db.customer.create({ data: { workspaceId: WS, phone: "0930000001" } } as never);
    await db.customer.create({ data: { workspaceId: WS, phone: "0930000002" } } as never);
    const calls = installFakeOms((c) =>
      Response.json(c.path.includes("0930000001") ? { exists: true, blacklisted: true, orders_count: 3 } : { exists: false })
    );
    const res = await syncCustomersFromOms(asDb(db), ctx, ["0930000001", "0930000002"]);
    expect(res).toEqual({ updated: 1, skipped: 1 });
    expect(calls[0].path).toBe("/api/v1/customers/lookup?phone=0930000001");
    expect(db._stores.customer.find((c) => c.phone === "0930000001")).toMatchObject({ isBlacklisted: true, blacklistSource: "OMS" });
  });
});
