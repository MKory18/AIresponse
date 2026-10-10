import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSessionToken } from "@/modules/auth/session";
import { getAuthContext } from "@/modules/auth/context";

/**
 * P3 authorization gates — REAL routes + REAL getAuthContext + REAL signed
 * cookies against the in-memory DB boundary (mocked @/core/db/prisma backed
 * by createFakeDb). Proves: suspension lockout, workspace tamper-proofing,
 * per-route permission pins, and leak-free error bodies — over HTTP.
 */

const holder: { token: string | null } = { token: null };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (holder.token ? { value: holder.token } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb } = await import("./helpers/inmemory-db");
  const db = createFakeDb();
  (globalThis as Record<string, unknown>).__p3db = db;
  return { prisma: db };
});

function db(): ReturnType<typeof import("./helpers/inmemory-db").createFakeDb> {
  return (globalThis as Record<string, unknown>).__p3db as ReturnType<
    typeof import("./helpers/inmemory-db").createFakeDb
  >;
}

function req(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function loginAs(userId: string, workspaceId: string | null) {
  holder.token = await createSessionToken({ userId, workspaceId });
}

async function seedTeam(): Promise<{ owner: any; agent: any; ws: string }> {
  const d = db();
  const ws = `c${"p".repeat(24)}`;
  const owner = (await d.user.create({ data: { email: "owner@p3.test", name: "Owner", passwordHash: "x" } })) as any;
  const agent = (await d.user.create({ data: { email: "agent@p3.test", name: "Agent", passwordHash: "x" } })) as any;
  await d.workspace.create({ data: { id: ws, name: "W", slug: "w" } } as never);
  await d.workspaceMember.create({ data: { workspaceId: ws, userId: owner.id, role: "OWNER", status: "ACTIVE" } } as never);
  await d.workspaceMember.create({ data: { workspaceId: ws, userId: agent.id, role: "SALES_AGENT", status: "ACTIVE" } } as never);
  return { owner, agent, ws };
}

beforeEach(() => {
  holder.token = null;
  const d = db();
  for (const k of Object.keys((d as { _stores: Record<string, unknown[]> })._stores)) {
    ((d as { _stores: Record<string, unknown[]> })._stores[k] as unknown[]).length = 0;
  }
});

describe("P3 session gates (real getAuthContext)", () => {
  it("suspended members are locked out immediately", async () => {
    const { agent, ws } = await seedTeam();
    await loginAs(agent.id, ws);
    expect((await getAuthContext()).userId).toBe(agent.id);
    const d = db();
    const row = (d._stores.workspaceMember as any[]).find((m) => m.userId === agent.id);
    row.status = "SUSPENDED";
    await expect(getAuthContext()).rejects.toThrow();
  });

  it("cookie workspaceId without membership is rejected", async () => {
    const { agent } = await seedTeam();
    await loginAs(agent.id, "ws-evil");
    await expect(getAuthContext()).rejects.toThrow();
  });

  it("auth errors leak no identifiers", async () => {
    await loginAs("ghost", "ws-a");
    try {
      await getAuthContext();
      expect.unreachable();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("ghost");
      expect(msg).not.toContain("ws-a");
    }
  });
});

describe("P3 member-route permission pins (real HTTP)", () => {
  it("invite/list/update/delete/workspace-update all require their permission (403, leak-free)", async () => {
    const { agent, ws } = await seedTeam();
    await loginAs(agent.id, ws);
    const membersMod = await import("@/app/api/workspaces/members/route");
    const memberMod = await import("@/app/api/workspaces/members/[id]/route");
    const wsMod = await import("@/app/api/workspaces/route");
    const cases: Array<{ run: () => Promise<Response> }> = [
      { run: () => membersMod.GET(req("/api/workspaces/members", "GET")) },
      { run: () => membersMod.POST(req("/api/workspaces/members", "POST", { email: "new@p3.test", role: "VIEWER" })) },
      { run: () => memberMod.PATCH(req("/api/workspaces/members/xxx", "PATCH", { role: "VIEWER" })) },
      { run: () => memberMod.DELETE(req("/api/workspaces/members/xxx", "DELETE")) },
      { run: () => wsMod.PUT(req("/api/workspaces", "PUT", { name: "Hacked" })) },
    ];
    for (const c of cases) {
      const res = await c.run();
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain("new@p3.test");
      expect(text).not.toContain("passwordHash");
    }
  });

  it("owner invite → invitee accept round-trip works over HTTP", async () => {
    const { owner, ws } = await seedTeam();
    const d = db();
    const newcomer = (await d.user.create({ data: { email: "new@p3.test", name: "New", passwordHash: "x" } })) as any;
    await loginAs(owner.id, ws);
    const inviteMod = await import("@/app/api/workspaces/members/route");
    const inv = await inviteMod.POST(req("/api/workspaces/members", "POST", { email: "new@p3.test", role: "VIEWER" }));
    expect(inv.status).toBe(201);
    const list = await inviteMod.GET(req("/api/workspaces/members", "GET"));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { members: { status: string }[] }).members.some((m) => m.status === "INVITED")).toBe(true);
    await loginAs(newcomer.id, null);
    const acceptMod = await import("@/app/api/workspaces/members/accept/route");
    const acc = await acceptMod.POST(req("/api/workspaces/members/accept", "POST", { workspaceId: ws }));
    expect(acc.status).toBe(200);
  });

  it("suspended admins cannot reach member APIs", async () => {
    const { owner, ws } = await seedTeam();
    const d = db();
    const row = (d._stores.workspaceMember as any[]).find((m) => m.userId === owner.id);
    row.status = "SUSPENDED";
    await loginAs(owner.id, ws);
    const mod = await import("@/app/api/workspaces/members/route");
    const res = await mod.GET(req("/api/workspaces/members", "GET"));
    expect(res.status).toBe(403);
  });
});
