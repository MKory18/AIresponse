import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { deleteOrder } from "@/modules/orders/order-service";
import { NotFoundError } from "@/core/errors";

/**
 * حذف الطلبات — صلاحية المالك فقط:
 * - المالك (OWNER) يحذف: صف الطلب وبنوده يختفوا، وسجل التدقيق يحفظ العملية
 *   بلقطة (رقم الطلب · المجموع · الحالة) — الأثر يبقى بلا صف.
 * - أي رتبة تانية (ADMIN/موظف) محجوبة بكود ثابت OWNER_ONLY_ORDERS
 *   حتى لو عندها orders.write — ما بيتحذف ولا صف.
 * - عبر المساحات: طلب مساحة تانية = غير موجود (لا تسريب وجود).
 */

const WS = "ws-order-del";
const OTHER = "ws-order-del-other";
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
const ids: Record<string, string> = {};

async function seedRole(role: string, email: string) {
  const user = (await db.user.create({
    data: { email, name: role, passwordHash: "x" },
  })) as unknown as { id: string };
  await db.workspaceMember.create({
    data: { workspaceId: WS, userId: user.id, role, status: "ACTIVE" },
  } as never);
  return user.id;
}

async function seedOrder(workspaceId = WS, orderNumber = "SY-2026-0148") {
  const order = (await db.order.create({
    data: {
      workspaceId,
      orderNumber,
      status: "CONFIRMED",
      total: "37.50",
      currency: "JOD",
      customerId: "cust-1",
    },
  } as never)) as unknown as { id: string };
  await db.orderItem.create({
    data: {
      orderId: order.id,
      productId: "prod-1",
      productNameSnapshot: "عسل زعتر",
      skuSnapshot: "SKU-1",
      unitPrice: "12.50",
      quantity: 3,
      subtotal: "37.50",
    },
  } as never);
  return order.id;
}

function stores() {
  return (db as unknown as { _stores: Record<string, Array<Record<string, unknown>>> })._stores;
}

beforeEach(async () => {
  db = createFakeDb();
  await db.workspace.create({ data: { id: WS, name: "W", slug: "w" } } as never);
  await db.workspace.create({ data: { id: OTHER, name: "O", slug: "o" } } as never);
  ids.owner = await seedRole("OWNER", "owner@x.test");
  ids.admin = await seedRole("ADMIN", "admin@x.test");
  ids.agent = await seedRole("SALES_AGENT", "agent@x.test");
});

describe("deleteOrder — المالك فقط", () => {
  it("المالك يحذف: الطلب وبنوده يختفوا وسجل التدقيق بيحفظ اللقطة", async () => {
    const orderId = await seedOrder();
    const result = (await deleteOrder(db as Db, { userId: ids.owner, workspaceId: WS }, orderId)) as unknown as {
      deleted: boolean;
      orderNumber: string;
    };

    expect(result.deleted).toBe(true);
    expect(result.orderNumber).toBe("SY-2026-0148");
    expect(stores().order.some((o) => o.id === orderId)).toBe(false);
    expect(stores().orderItem.some((i) => i.orderId === orderId)).toBe(false);

    const audits = stores().auditLog.filter((a) => a.action === "order.deleted");
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(orderId);
    expect(JSON.stringify(audits[0])).toContain("SY-2026-0148");
  });

  it("ADMIN محجوب رغم orders.write — ولا صف بينحذف", async () => {
    const orderId = await seedOrder();
    await expect(
      deleteOrder(db as Db, { userId: ids.admin, workspaceId: WS }, orderId)
    ).rejects.toMatchObject({ code: "OWNER_ONLY_ORDERS" });
    expect(stores().order.some((o) => o.id === orderId)).toBe(true);
    expect(stores().orderItem.some((i) => i.orderId === orderId)).toBe(true);
  });

  it("موظف مبيعات محجوب بنفس الكود", async () => {
    const orderId = await seedOrder();
    await expect(
      deleteOrder(db as Db, { userId: ids.agent, workspaceId: WS }, orderId)
    ).rejects.toMatchObject({ code: "OWNER_ONLY_ORDERS" });
  });

  it("طلب مساحة تانية = غير موجود (ولا انكشاف وجوده)", async () => {
    const foreign = await seedOrder(OTHER, "SY-OTHER-1");
    await expect(
      deleteOrder(db as Db, { userId: ids.owner, workspaceId: WS }, foreign)
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(stores().order.some((o) => o.id === foreign)).toBe(true);
  });

  it("طلب غير موجود = NotFound", async () => {
    await expect(
      deleteOrder(db as Db, { userId: ids.owner, workspaceId: WS }, "nope-1")
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("عضوية موقوفة = المالك غير فاعل (الرتبة تُقرأ طازجة من القاعدة)", async () => {
    const orderId = await seedOrder();
    // علّق عضوية المالك: الرتبة تبقى OWNER لكن الحالة SUSPENDED
    const row = stores().workspaceMember.find((m) => m.userId === ids.owner)!;
    row.status = "SUSPENDED";
    await expect(
      deleteOrder(db as Db, { userId: ids.owner, workspaceId: WS }, orderId)
    ).rejects.toMatchObject({ code: "OWNER_ONLY_ORDERS" });
  });
});
