import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import nodeCrypto from "node:crypto";
import { encryptSecret } from "@/core/crypto";

/**
 * P2 OMS routes: permission pins + webhook trust model (HMAC / mismatch /
 * replay through the real route with a mocked database — zero network, zero
 * real secrets; the "token" below is a test-only fixture).
 */

const seenPermissions: string[] = [];

vi.mock("@/modules/auth/context", async () => {
  const { AuthorizationError } = await import("@/core/errors");
  return {
    getAuthContext: async () => ({
      userId: "agent-1",
      workspaceId: "ws-p2r",
      role: "SALES_AGENT",
      memberPermissions: [],
      can: () => false,
      require: (p: string) => {
        seenPermissions.push(p);
        throw new AuthorizationError(`Missing permission: ${p}`);
      },
    }),
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

type MockDb = {
  order: { findUnique: (a: unknown) => Promise<unknown>; update: (a: unknown) => Promise<unknown> };
  omsConnection: { findUnique: (a: unknown) => Promise<unknown> };
  webhookEvent: { create: (a: unknown) => Promise<unknown> };
  auditLog: { create: (a: unknown) => Promise<unknown> };
};

const holder: {
  db: MockDb;
  order: Record<string, unknown> | null;
  conn: Record<string, unknown> | null;
  seenEvents: Set<string>;
  updates: unknown[];
} = {
  db: null as unknown as MockDb,
  order: null,
  conn: null,
  seenEvents: new Set(),
  updates: [],
};

vi.mock("@/core/db/prisma", () => {
  holder.db = {
    order: {
      findUnique: async () => holder.order,
      update: async (a: unknown) => {
        holder.updates.push(a);
        return holder.order;
      },
    },
    omsConnection: {
      findUnique: async () => holder.conn,
    },
    webhookEvent: {
      create: async (a: unknown) => {
        const key = `${(a as { data: { source: string; externalEventId: string } }).data.source}|${
          (a as { data: { source: string; externalEventId: string } }).data.externalEventId
        }`;
        if (holder.seenEvents.has(key)) {
          const err = new Error("unique") as Error & { code?: string };
          err.code = "P2002";
          throw err;
        }
        holder.seenEvents.add(key);
        return { id: "we-1" };
      },
    },
    auditLog: { create: async () => ({}) },
  };
  return { prisma: holder.db };
});

function sign(body: string, secret: string): string {
  return `sha256=${nodeCrypto.createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  seenPermissions.length = 0;
  holder.order = null;
  holder.conn = null;
  holder.seenEvents = new Set();
  holder.updates = [];
});

describe("P2 OMS route permissions (pinned, never weakened silently)", () => {
  it("connection requires settings.manage", async () => {
    const { POST } = await import("@/app/api/oms/connection/route");
    const res = await POST(post("/api/oms/connection", { baseUrl: "https://oms.example", token: "tokentoken123" }));
    expect(res.status).toBe(403);
    expect(seenPermissions).toEqual(["settings.manage"]);
  });

  it("sync requires products.write", async () => {
    const { POST } = await import("@/app/api/oms/sync/route");
    const res = await POST(post("/api/oms/sync", {}));
    expect(res.status).toBe(403);
    expect(seenPermissions).toEqual(["products.write"]);
  });

  it("handoff requires orders.write", async () => {
    const { POST } = await import("@/app/api/oms/handoff/route");
    const res = await POST(post("/api/oms/handoff", { orderId: "c".repeat(25) }));
    expect(res.status).toBe(403);
    expect(seenPermissions).toEqual(["orders.write"]);
  });
});

describe("P2 OMS webhook route — trust model (mocked DB, fixture token)", () => {
  const SECRET = "fixture-oms-secret";

  function seedOrder(status = "PROCESSING", workspaceId = "ws-p2r") {
    holder.order = {
      id: "ord-1", workspaceId, status, customerId: "cus-1",
      omsOrderId: "OMS-W", omsStatus: "PROCESSING", omsStatusAt: null,
    };
    holder.conn = { id: "c1", workspaceId, baseUrl: "https://oms.example", tokenEncrypted: encryptSecret(SECRET), isActive: true };
  }

  it("valid HMAC applies the event (200, order derived, no payload trust)", async () => {
    seedOrder();
    const { POST } = await import("@/app/api/webhooks/oms/route");
    const body = { event: "order-status-changed", workspaceId: "ws-p2r", omsOrderId: "OMS-W", status: "SHIPPED", eventId: "e-1" };
    const raw = JSON.stringify(body);
    const res = await POST(post("/api/webhooks/oms", body, { "x-oms-signature": sign(raw, SECRET) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; appliedLocalStatus: string | null; duplicate: boolean };
    expect(json.ok).toBe(true);
    expect(json.duplicate).toBe(false);
    expect(json.appliedLocalStatus).toBe("OUT_FOR_DELIVERY");
    expect(holder.updates.length).toBe(1);
  });

  it("wrong HMAC is rejected with zero side effects", async () => {
    seedOrder();
    const { POST } = await import("@/app/api/webhooks/oms/route");
    const body = { event: "order-status-changed", omsOrderId: "OMS-W", status: "SHIPPED", eventId: "e-2" };
    const res = await POST(post("/api/webhooks/oms", body, { "x-oms-signature": sign(JSON.stringify(body), "wrong") }));
    expect(res.status).toBe(401);
    expect(holder.updates).toHaveLength(0);
    expect(holder.seenEvents.size).toBe(0);
  });

  it("missing signature is rejected with zero side effects", async () => {
    seedOrder();
    const { POST } = await import("@/app/api/webhooks/oms/route");
    const res = await POST(post("/api/webhooks/oms", { event: "order-status-changed", omsOrderId: "OMS-W", status: "SHIPPED" }));
    expect(res.status).toBe(401);
    expect(holder.updates).toHaveLength(0);
  });

  it("unknown orders 404 without touching state", async () => {
    holder.order = null;
    holder.conn = null;
    const { POST } = await import("@/app/api/webhooks/oms/route");
    const body = { event: "order-status-changed", omsOrderId: "OMS-GHOST", status: "SHIPPED" };
    const res = await POST(post("/api/webhooks/oms", body, { "x-oms-signature": sign(JSON.stringify(body), SECRET) }));
    expect(res.status).toBe(404);
    expect(holder.updates).toHaveLength(0);
  });

  it("payload workspace hint contradicting the order row is rejected", async () => {
    seedOrder("CONFIRMED", "ws-p2r");
    const { POST } = await import("@/app/api/webhooks/oms/route");
    const body = { event: "order-status-changed", workspaceId: "ws-evil", omsOrderId: "OMS-W", status: "SHIPPED" };
    const res = await POST(post("/api/webhooks/oms", body, { "x-oms-signature": sign(JSON.stringify(body), SECRET) }));
    expect(res.status).toBe(404);
    expect(holder.updates).toHaveLength(0);
  });

  it("eventId replay through the route applies once", async () => {
    seedOrder();
    const { POST } = await import("@/app/api/webhooks/oms/route");
    const body = { event: "order-status-changed", omsOrderId: "OMS-W", status: "SHIPPED", eventId: "e-replay" };
    const raw = JSON.stringify(body);
    const sig = sign(raw, SECRET);
    const r1 = await POST(post("/api/webhooks/oms", body, { "x-oms-signature": sig }));
    expect(r1.status).toBe(200);
    const r2 = await POST(post("/api/webhooks/oms", body, { "x-oms-signature": sig }));
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as { duplicate: boolean };
    expect(j2.duplicate).toBe(true);
    expect(holder.updates).toHaveLength(1);
  });
});
