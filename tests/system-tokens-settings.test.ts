/**
 * R1 — «الإعدادات ← توكنات الأنظمة»: التوكن بيتصنع من الموقع (مرة وحدة · مجزّأ) وبيدخل فيه الميديا باير على
 * GET /api/v1/capacity. توكن غلط/منتهي/موقوف = 401 · صلاحية `integrations.manage` على كل مسار الإدارة.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { clearRateLimitMemory } from "@/core/api/rate-limit";
import { hashToken } from "@/modules/integrations/tokens";
import { NAV_GROUPS } from "@/lib/nav-model";
import { guideForPath } from "@/lib/page-guides";
import { GET as listGET, POST as createPOST } from "@/app/api/settings/system-tokens/route";
import { POST as revokePOST } from "@/app/api/settings/system-tokens/[id]/revoke/route";
import { GET as capacityGET } from "@/app/api/v1/capacity/route";

const WS = "ws-systok-1";
const WS_B = "ws-systok-b";

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb } = await import("./helpers/inmemory-db");
  const db = createFakeDb();
  (globalThis as Record<string, unknown>).__sysTokDb = db;
  return { prisma: db };
});
vi.mock("@/modules/auth/context", async () => {
  const { AuthorizationError } = await import("@/core/errors");
  return {
    getAuthContext: async () => {
      const g = globalThis as Record<string, unknown>;
      const perms = (g.__sysTokPerms as string[]) ?? [];
      return {
        userId: "u-owner",
        workspaceId: (g.__sysTokWs as string) ?? "ws-systok-1",
        role: "OWNER",
        memberPermissions: [],
        can: (p: string) => perms.includes(p),
        require: (p: string) => {
          if (!perms.includes(p)) throw new AuthorizationError(`Missing permission: ${p}`);
        },
      };
    },
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

type FakeDb = ReturnType<typeof import("./helpers/inmemory-db").createFakeDb>;
type Row = Record<string, any>;
const db = () => (globalThis as Record<string, unknown>).__sysTokDb as FakeDb;
const as = (perms: string[], ws = WS) => {
  const g = globalThis as Record<string, unknown>;
  g.__sysTokPerms = perms;
  g.__sysTokWs = ws;
};
const MANAGE = ["integrations.manage"];

const req = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const json = async (r: Response): Promise<Row> => (await r.json()) as Row;
const create = (body: Row) => createPOST(req("/api/settings/system-tokens", { method: "POST", body }));
const capacity = (token: string) => capacityGET(req("/api/v1/capacity", { headers: { authorization: `Bearer ${token}` } }));

beforeEach(() => {
  const stores = db()._stores as Record<string, unknown[]>;
  for (const k of Object.keys(stores)) stores[k].length = 0;
  stores.workspace.push(
    { id: WS, name: "Zaki", slug: "zaki", timezone: "Asia/Amman", integrationSettings: {} },
    { id: WS_B, name: "Other", slug: "other", timezone: "UTC", integrationSettings: {} }
  );
  clearRateLimitMemory();
  as(MANAGE);
});

describe("الإنشاء: الميديا باير بصلاحية capacity.read، مرة وحدة، ومجزّأ", () => {
  it("201 + no-store + التوكن بالرد بس، والمخزّن تجزئة، والاستجابة بلا تجزئة", async () => {
    const res = await create({ system: "mediabuyer" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json(res);
    expect(body.token).toMatch(/^zr_mb_[A-Za-z0-9_-]{20,}$/);
    expect(body.view).toMatchObject({ system: "mediabuyer", name: "الميديا باير", scopes: ["capacity.read"], status: "active" });
    expect(body.view.tokenHash).toBeUndefined();

    const stored = db()._stores.integrationToken as Row[];
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).toBe(hashToken(body.token));
    expect(JSON.stringify(stored[0])).not.toContain(body.token);
    expect(stored[0].workspaceId).toBe(WS);
  });

  it("القائمة ما بترجّع التوكن ولا التجزئة، وبتعرض آخر استخدام وتاريخ الانتهاء", async () => {
    const { token } = await json(await create({ system: "mediabuyer", name: "ميديا باير الأردن" }));
    expect((await capacity(token)).status).toBe(200);
    const list = await json(await listGET(req("/api/settings/system-tokens")));
    expect(list.systems.map((s: Row) => s.key)).toEqual(expect.arrayContaining(["mediabuyer", "clipper"]));
    expect(list.systems.find((s: Row) => s.key === "mediabuyer")).toMatchObject({ scopes: ["capacity.read"], optionalScopes: ["ads.read"] });
    expect(list.tokens).toHaveLength(1);
    const t = list.tokens[0];
    expect(t.name).toBe("ميديا باير الأردن");
    expect(t.lastUsedAt).toBeTruthy();
    expect(t.expiresAt).toBeTruthy();
    const dump = JSON.stringify(list);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain("tokenHash");
  });

  it("الصلاحية لازم تكون ضمن حدود النظام، والنظام معروف", async () => {
    expect((await create({ system: "mediabuyer", scopes: ["retarget.create"] })).status).toBe(422);
    expect((await create({ system: "unknown-system" })).status).toBe(422);
    expect((await create({ system: "mediabuyer", expiresInDays: 9999 })).status).toBe(422);
    expect((db()._stores.integrationToken as Row[]).length).toBe(0);
  });
});

describe("التوكن على /api/v1/capacity: غلط/منتهي/موقوف = 401", () => {
  it("بيشتغل (200) والرد بلا بيانات عملاء", async () => {
    const { token } = await json(await create({ system: "mediabuyer" }));
    const res = await capacity(token);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(["at", "by_channel", "first_response_p50_min", "unanswered"]);
  });

  it("توكن غلط = 401", async () => {
    await create({ system: "mediabuyer" });
    expect((await capacity(`zr_mb_${"x".repeat(32)}`)).status).toBe(401);
    expect((await capacity("garbage")).status).toBe(401);
    const noHeader = await capacityGET(req("/api/v1/capacity"));
    expect(noHeader.status).toBe(401);
  });

  it("توكن منتهي = 401", async () => {
    const { token } = await json(await create({ system: "mediabuyer", expiresInDays: 30 }));
    expect((await capacity(token)).status).toBe(200);
    (db()._stores.integrationToken as Row[])[0].expiresAt = new Date(Date.now() - 1000);
    expect((await capacity(token)).status).toBe(401);
  });

  it("توكن موقوف من الشاشة = 401 من أول طلب، وبيضل بالقائمة «موقوف»", async () => {
    const created = await json(await create({ system: "mediabuyer" }));
    expect((await capacity(created.token)).status).toBe(200);
    const rev = await revokePOST(req(`/api/settings/system-tokens/${created.view.id}/revoke`, { method: "POST" }), {
      params: { id: created.view.id },
    });
    expect(rev.status).toBe(200);
    expect((await json(rev)).view.status).toBe("revoked");
    expect((await capacity(created.token)).status).toBe(401);
    const list = await json(await listGET(req("/api/settings/system-tokens")));
    expect(list.tokens[0].status).toBe("revoked");
  });

  it("توكن الكليبر ما بيقرأ القدرة (403)", async () => {
    const { token } = await json(await create({ system: "clipper" }));
    expect((await capacity(token)).status).toBe(403);
  });
});

describe("الصلاحيات والعزل", () => {
  it("بلا integrations.manage = 403 على القائمة والإنشاء والإيقاف", async () => {
    const { view } = await json(await create({ system: "mediabuyer" }));
    as(["analytics.read", "orders.read"]);
    expect((await listGET(req("/api/settings/system-tokens"))).status).toBe(403);
    expect((await create({ system: "mediabuyer" })).status).toBe(403);
    const rev = await revokePOST(req(`/api/settings/system-tokens/${view.id}/revoke`, { method: "POST" }), { params: { id: view.id } });
    expect(rev.status).toBe(403);
    expect((db()._stores.integrationToken as Row[])[0].revokedAt ?? null).toBeNull();
  });

  it("مساحة ثانية ما بتشوف ولا بتوقف توكناتك", async () => {
    const { view } = await json(await create({ system: "mediabuyer" }));
    as(MANAGE, WS_B);
    const list = await json(await listGET(req("/api/settings/system-tokens")));
    expect(list.tokens).toEqual([]);
    const rev = await revokePOST(req(`/api/settings/system-tokens/${view.id}/revoke`, { method: "POST" }), { params: { id: view.id } });
    expect(rev.status).toBe(404);
  });
});

describe("الصفحة بالتنقل والدليل", () => {
  it("بمجموعة الإعدادات وبصلاحية integrations.manage، وإلها شرح", () => {
    for (const groups of [NAV_GROUPS]) {
      const page = groups.flatMap((g) => g.pages).find((p) => p.href === "/settings/system-tokens");
      expect(page?.permission).toBe("integrations.manage");
    }
    expect(guideForPath("/settings/system-tokens")?.guide.what).toContain("الميديا باير");
  });
});
