/**
 * كل طلب مؤكد لازم ينزل بالـ OMS ويوصل مجموعة تيليغرام.
 *
 * الحالة اللي كانت بتضيع: الطلب انعمل قبل ما الربط ينعمل، فما انعملتله
 * مهمة ترحيل أبدًا — ولا كنس كان بيرجع ياخده. هون منتأكد إنه الكنس الساعي
 * بياخده بعد ما الربط يصير جاهز، وإنه ما بيكرّر شي أصلًا وصل.
 *
 * ⚠️ قاعدة بالذاكرة — سلوك، مش زمن إنتاج.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import { sweepOrdersMissingOms, sweepOrdersMissingTelegram } from "@/modules/orders/delivery-sweep";

type Db = Prisma.TransactionClient;
const WS = "ws-lands";
let db: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  db = createFakeDb();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ORDER_CHAT_ID;
});

function jobsOfType(type: string) {
  return (db as unknown as { _stores: { backgroundJob: Array<{ type: string; payload: { orderId?: string } }> } })._stores.backgroundJob.filter(
    (j) => j.type === type
  );
}

async function makeOrder(over: Record<string, unknown> = {}) {
  return (await db.order.create({
    data: {
      workspaceId: WS,
      orderNumber: `ZR-${Math.random().toString(36).slice(2, 7)}`,
      customerId: "cust-1",
      status: "CONFIRMED",
      confirmationStatus: "CONFIRMED_BY_CUSTOMER",
      subtotal: 100,
      discount: 0,
      deliveryFee: 0,
      total: 100,
      currency: "SYP",
      source: "AI",
      omsOrderId: null,
      ...over,
    },
  } as never)) as unknown as { id: string };
}

async function connectOms(over: Record<string, unknown> = {}) {
  await (db as unknown as { omsConnection: { create: (a: unknown) => Promise<unknown> } }).omsConnection.create({
    data: { workspaceId: WS, baseUrl: "https://oms.example.com", tokenEnc: encryptSecret("zk1_x"), isActive: true, autoHandoff: true, mode: "api", apiVersion: "v1", ...over },
  } as never);
}

async function enableTelegram() {
  await (db as unknown as { telegramOrderSettings: { create: (a: unknown) => Promise<unknown> } }).telegramOrderSettings.create({
    data: { workspaceId: WS, enabled: true, botTokenEnc: encryptSecret("bot-token"), chatId: "-100123" },
  } as never);
}

describe("الـ OMS: طلب مؤكد ما إله مهمة بياخد وحدة", () => {
  it("طلب انعمل قبل ما الـ OMS ينربط بينزل بعد ما ينربط", async () => {
    const order = await makeOrder();
    // الربط انعمل بعد الطلب — وقت الطلب ما انعملت ولا مهمة.
    expect(jobsOfType("handoff_order_to_oms")).toHaveLength(0);
    await connectOms();

    const queued = await sweepOrdersMissingOms(db as unknown as Db);
    expect(queued).toBe(1);
    expect(jobsOfType("handoff_order_to_oms")[0].payload.orderId).toBe(order.id);
  });

  it("ما بيكرّر: الدورة الجاية ما بتعمل مهمة تانية", async () => {
    await makeOrder();
    await connectOms();
    await sweepOrdersMissingOms(db as unknown as Db);
    await sweepOrdersMissingOms(db as unknown as Db);
    expect(jobsOfType("handoff_order_to_oms")).toHaveLength(1);
  });

  it("طلب نزل بالـ OMS أصلًا ما بينبعت مرة تانية", async () => {
    await makeOrder({ omsOrderId: "oms-1" });
    await connectOms();
    expect(await sweepOrdersMissingOms(db as unknown as Db)).toBe(0);
  });

  it("طلب ملغي ما بينزل", async () => {
    await makeOrder({ status: "CANCELLED" });
    await connectOms();
    expect(await sweepOrdersMissingOms(db as unknown as Db)).toBe(0);
  });

  it("طلب لسا ما تأكد ما بينزل", async () => {
    await makeOrder({ confirmationStatus: "PENDING", status: "CONFIRMATION_PENDING" });
    await connectOms();
    expect(await sweepOrdersMissingOms(db as unknown as Db)).toBe(0);
  });

  it("الإرسال التلقائي مطفي = ما في كنس", async () => {
    await makeOrder();
    await connectOms({ autoHandoff: false });
    expect(await sweepOrdersMissingOms(db as unknown as Db)).toBe(0);
  });

  it("الـ OMS مش مربوط = ما في كنس", async () => {
    await makeOrder();
    expect(await sweepOrdersMissingOms(db as unknown as Db)).toBe(0);
  });

  it("طلب أقدم من نافذة الكنس ما بينسحب", async () => {
    const order = await makeOrder();
    await db.order.update({
      where: { id: order.id },
      data: { createdAt: new Date(Date.now() - 100 * 3600_000) },
    } as never);
    await connectOms();
    expect(await sweepOrdersMissingOms(db as unknown as Db)).toBe(0);
  });
});

describe("تيليغرام: طلب مؤكد ما وصل المجموعة بياخد مهمة", () => {
  it("طلب انعمل قبل ما البوت ينضبط بيوصل بعدها", async () => {
    const order = await makeOrder();
    await enableTelegram();
    const queued = await sweepOrdersMissingTelegram(db as unknown as Db);
    expect(queued).toBe(1);
    expect(jobsOfType("notify_order_telegram")[0].payload.orderId).toBe(order.id);
  });

  it("طلب وصل المجموعة أصلًا ما بينبعت مرة تانية", async () => {
    const order = await makeOrder();
    await enableTelegram();
    await db.auditLog.create({
      data: {
        workspaceId: WS,
        action: "order.telegram_notified",
        entityType: "Order",
        entityId: order.id,
      },
    } as never);
    expect(await sweepOrdersMissingTelegram(db as unknown as Db)).toBe(0);
  });

  it("البوت مش مضبوط = ما في مهام فاضية", async () => {
    await makeOrder();
    expect(await sweepOrdersMissingTelegram(db as unknown as Db)).toBe(0);
  });

  it("ما بيكرّر: الدورة الجاية ما بتعمل مهمة تانية", async () => {
    await makeOrder();
    await enableTelegram();
    await sweepOrdersMissingTelegram(db as unknown as Db);
    await sweepOrdersMissingTelegram(db as unknown as Db);
    expect(jobsOfType("notify_order_telegram")).toHaveLength(1);
  });
});
