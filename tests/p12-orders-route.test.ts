import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encryptSecret } from "@/core/crypto";
import { GET as orderGET, PATCH as orderPATCH } from "@/app/api/orders/[id]/route";

/**
 * P12 — مسار تفاصيل الطلب (GET/PATCH /api/orders/[id]) فوق قاعدة بالذاكرة:
 * معرّفات الإسناد المشفّرة (رمز النقرة · PSID) ما بتطلع بأي رد · تعديل
 * الملاحظات بيتحقق من مساحة الطلب · حالة الترحيل وصلاحية الكتابة للبطاقة.
 */

const WS = "ws-orders-route";
const OTHER = "ws-orders-route-other";
let canWrite = true;

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb } = await import("./helpers/inmemory-db");
  const db = createFakeDb();
  (globalThis as Record<string, unknown>).__ordersRouteDb = db;
  return { prisma: db };
});
vi.mock("@/modules/auth/context", async () => {
  const { AuthorizationError } = await import("@/core/errors");
  return {
    getAuthContext: async () => ({
      userId: "agent-1",
      workspaceId: WS,
      role: "SALES_AGENT",
      memberPermissions: [],
      can: (p: string) => (p === "orders.write" ? canWrite : p === "orders.read"),
      require: (p: string) => {
        if (p === "orders.read" || (p === "orders.write" && canWrite)) return;
        throw new AuthorizationError(`Missing permission: ${p}`);
      },
    }),
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

type Row = Record<string, any>;
type FakeDb = ReturnType<typeof import("./helpers/inmemory-db").createFakeDb>;
const db = () => (globalThis as Record<string, unknown>).__ordersRouteDb as FakeDb;

function req(url: string, init: { method?: string; body?: string } = {}) {
  return new NextRequest(`http://localhost${url}`, { method: init.method ?? "GET", body: init.body, headers: init.body ? { "content-type": "application/json" } : undefined });
}
async function json(res: Response): Promise<Row> {
  return (await res.json()) as Row;
}

async function seed(workspaceId = WS, o: Row = {}): Promise<Row> {
  const cu = (await db().customer.create({ data: { workspaceId, name: "زبون", phone: `09${Math.floor(Math.random() * 1e8)}` } } as never)) as Row;
  return (await db().order.create({
    data: {
      workspaceId,
      orderNumber: `ORD-${Math.random()}`,
      customerId: cu.id,
      status: "CONFIRMED",
      confirmationStatus: "CONFIRMED_BY_CUSTOMER",
      notes: "قديم",
      ctwaClidEnc: encryptSecret("CLID-SECRET-1"),
      psidEnc: encryptSecret("PSID-SECRET-1"),
      ...o,
    },
  } as never)) as Row;
}

beforeEach(() => {
  const stores = db()._stores as Record<string, unknown[]>;
  for (const k of Object.keys(stores)) stores[k].length = 0;
  canWrite = true;
});

describe("P12 GET/PATCH /api/orders/[id]", () => {
  it("GET: بلا ctwaClidEnc/psidEnc · فيه صلاحية الكتابة وبلا OMS", async () => {
    const o = await seed();
    const res = await orderGET(req(`/api/orders/${o.id}`), { params: { id: o.id } });
    expect(res.status).toBe(200);
    const body = await json(res);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("ctwaClidEnc");
    expect(raw).not.toContain("psidEnc");
    expect(raw).not.toMatch(/[Oo]ms/);
    expect(body).toMatchObject({ id: o.id, canWrite: true });
    canWrite = false;
    expect((await json(await orderGET(req(`/api/orders/${o.id}`), { params: { id: o.id } }))).canWrite).toBe(false);
  });

  it("PATCH ملاحظات: الرد بلا المعرّفات المشفّرة · طلب مساحة تانية = 404 بلا أي كتابة", async () => {
    const mine = await seed();
    const res = await orderPATCH(req(`/api/orders/${mine.id}`, { method: "PATCH", body: JSON.stringify({ notes: "جديد" }) }), { params: { id: mine.id } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.notes).toBe("جديد");
    expect(JSON.stringify(body)).not.toMatch(/ctwaClidEnc|psidEnc/);

    const foreign = await seed(OTHER);
    const cross = await orderPATCH(req(`/api/orders/${foreign.id}`, { method: "PATCH", body: JSON.stringify({ notes: "اختراق" }) }), { params: { id: foreign.id } });
    expect(cross.status).toBe(404);
    expect(db()._stores.order.find((r) => r.id === foreign.id)!.notes).toBe("قديم");
  });

  it("PATCH حالة: الرد بلا المعرّفات المشفّرة", async () => {
    const o = await seed();
    const res = await orderPATCH(req(`/api/orders/${o.id}`, { method: "PATCH", body: JSON.stringify({ status: "PROCESSING" }) }), { params: { id: o.id } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("PROCESSING");
    expect(JSON.stringify(body)).not.toMatch(/ctwaClidEnc|psidEnc/);
  });
});
