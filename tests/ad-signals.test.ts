/**
 * R2 — GET /api/v1/ad-signals: أعداد بس لكل إعلان ولكل يوم، خلية < 5 محذوفة، بلا بيانات عميل،
 * توكن بصلاحية ads.read (توكن الميديا باير الافتراضي ما عنده)، وتحقق الاستعلام = 400.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { clearRateLimitMemory } from "@/core/api/rate-limit";
import type { Db } from "@/modules/customers/service";
import { createIntegrationToken, revokeIntegrationToken } from "@/modules/integrations/tokens";
import { computeAdSignals, parseAdSignalsQuery, AD_SIGNALS_MIN_BUCKET } from "@/modules/integrations/ad-signals";
import { GET as adSignalsGET } from "@/app/api/v1/ad-signals/route";

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb } = await import("./helpers/inmemory-db");
  const db = createFakeDb();
  (globalThis as Record<string, unknown>).__adSigDb = db;
  return { prisma: db };
});

type FakeDb = ReturnType<typeof import("./helpers/inmemory-db").createFakeDb>;
type Row = Record<string, any>;
const db = () => (globalThis as Record<string, unknown>).__adSigDb as FakeDb;
const asDb = () => db() as unknown as Db;
const stores = () => db()._stores as Record<string, Row[]>;

const WS = "ws-adsig-1";
const WS_B = "ws-adsig-b";
const ctx = { userId: "owner-1", workspaceId: WS };
const NOW = new Date("2026-11-18T10:00:00Z");
const AD_A = "120211000000000001";
const AD_B = "120211000000000002";
const AD_OLD = "120211000000000009";
const T = (iso: string) => new Date(iso);
let seq = 0;

/** محادثة من إعلان (لمسة AD بداية حلقة) + رسالة عميل أولى + رد اختياري بعد `replyMin` دقيقة. */
function conv(opts: { ws?: string; ad: string; at?: string; replyMin?: number | null; status?: string; touches?: Array<{ ad: string; at: string }> }) {
  const id = `c${++seq}`;
  const ws = opts.ws ?? WS;
  const at = T(opts.at ?? "2026-11-17T08:00:00Z");
  stores().conversation.push({ id, workspaceId: ws, customerId: `cu${seq}`, channelId: "ch", status: opts.status ?? "OPEN", lastCustomerMessageAt: at, lastAgentMessageAt: null });
  for (const t of [{ ad: opts.ad, at: at.toISOString() }, ...(opts.touches ?? [])]) {
    stores().attributionTouch.push({
      id: `t${++seq}`, workspaceId: ws, customerId: `cu${seq}`, conversationId: id, channel: "messenger", kind: "AD", source: "fb_referral",
      adId: t.ad, episodeStart: true, dedupeKey: `d${seq}`, occurredAt: T(t.at),
    });
  }
  stores().message.push({ id: `m${++seq}`, workspaceId: ws, conversationId: id, senderType: "CUSTOMER", senderId: null, direction: "INBOUND", isNote: false, deletedAt: null, createdAt: at });
  if (opts.replyMin !== undefined && opts.replyMin !== null) {
    stores().message.push({ id: `m${++seq}`, workspaceId: ws, conversationId: id, senderType: "AI", senderId: null, direction: "OUTBOUND", isNote: false, deletedAt: null, createdAt: new Date(at.getTime() + opts.replyMin * 60_000) });
    (stores().conversation.find((c) => c.id === id) as Row).lastAgentMessageAt = new Date(at.getTime() + opts.replyMin * 60_000);
  }
  return id;
}

const req = (url: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${url}`, { headers });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, qs = "since=2026-11-10") => adSignalsGET(req(`/api/v1/ad-signals?${qs}`, bearer(t)));
const json = async (r: Response): Promise<Row> => (await r.json()) as Row;

beforeEach(() => {
  seq = 0;
  for (const k of Object.keys(stores())) stores()[k].length = 0;
  stores().workspace.push(
    { id: WS, name: "Zaki", slug: "zaki", timezone: "Asia/Amman", integrationSettings: {} },
    { id: WS_B, name: "Other", slug: "other", timezone: "UTC", integrationSettings: {} }
  );
  clearRateLimitMemory();
});

describe("الحساب: أعداد لكل إعلان ولكل يوم", () => {
  it("خلية بـ6 محادثات: أول رد · بلا رد · تحويلات · مسودات ومثبّت", async () => {
    const ids = [conv({ ad: AD_A, replyMin: 2 }), conv({ ad: AD_A, replyMin: 4 }), conv({ ad: AD_A, replyMin: 10 }), conv({ ad: AD_A, replyMin: null }), conv({ ad: AD_A, replyMin: null, status: "RESOLVED" }), conv({ ad: AD_A, replyMin: 6 })];
    stores().humanHandoff.push(
      { id: "h1", workspaceId: WS, conversationId: ids[0], reason: "LOW_CONFIDENCE" },
      { id: "h2", workspaceId: WS, conversationId: ids[1], reason: "LOW_CONFIDENCE" },
      { id: "h3", workspaceId: WS, conversationId: ids[2], reason: "COMPLAINT" }
    );
    stores().order.push(
      { id: "o1", workspaceId: WS, conversationId: ids[0], status: "CONFIRMED", sealedAt: null },
      { id: "o2", workspaceId: WS, conversationId: ids[1], status: "CONFIRMATION_PENDING", sealedAt: T("2026-11-17T09:00:00Z") },
      { id: "o3", workspaceId: WS, conversationId: ids[2], status: "NEW", sealedAt: null }
    );
    stores().orderDraft.push({ id: "d1", workspaceId: WS, conversationId: ids[3], state: "COLLECTING", orderId: null });
    const r = await computeAdSignals(asDb(), WS, { since: "2026-11-10" }, NOW);
    expect(r.next_cursor).toBeNull();
    expect(r.items).toEqual([
      {
        ad_id: AD_A,
        date: "2026-11-17",
        conversations_started: 6,
        first_response_p50_min: 5, // وسيط {2,4,6,10}
        unanswered: 1, // المفتوحة بلا رد (الـRESOLVED ما بتنحسب)
        handoffs_by_reason: { LOW_CONFIDENCE: 2, COMPLAINT: 1 },
        orders_drafted: 4, // 3 طلبات + مسودة مفتوحة
        orders_confirmed: 2, // CONFIRMED + المثبّت
      },
    ]);
  });

  it("خلية أقل من 5 بتنحذف (خصوصية)، والحد بالضبط 5 بيظهر", async () => {
    for (let i = 0; i < 4; i++) conv({ ad: AD_B }); // العقد: أقل من 5 = محذوفة
    for (let i = 0; i < 5; i++) conv({ ad: AD_A });
    expect(AD_SIGNALS_MIN_BUCKET).toBe(5);
    const r = await computeAdSignals(asDb(), WS, { since: "2026-11-10" }, NOW);
    expect(r.items.map((i) => i.ad_id)).toEqual([AD_A]);
  });

  it("«بداية المحادثة بتحكم»: محادثة فتحها إعلان قديم ما بتنحسب على إعلان لحقها", async () => {
    for (let i = 0; i < 5; i++) conv({ ad: AD_A });
    // 5 محادثات أول إعلان إلها AD_OLD (قبل النافذة) ثم لمسة AD_B باليوم
    for (let i = 0; i < 5; i++) conv({ ad: AD_OLD, at: "2026-09-01T08:00:00Z", touches: [{ ad: AD_B, at: "2026-11-17T08:00:00Z" }] });
    const r = await computeAdSignals(asDb(), WS, { since: "2026-11-10" }, NOW);
    expect(r.items.map((i) => i.ad_id)).toEqual([AD_A]);
  });

  it("اليوم بتوقيت المساحة (عمّان): لمسة 22:30 UTC = اليوم اللي بعده", async () => {
    for (let i = 0; i < 5; i++) conv({ ad: AD_A, at: "2026-11-16T22:30:00Z" });
    const r = await computeAdSignals(asDb(), WS, { since: "2026-11-10" }, NOW);
    expect(r.items[0].date).toBe("2026-11-17");
  });

  it("مرقّم: limit + cursor بلا تكرار ولا نقص، والمساحة الثانية معزولة", async () => {
    for (const ad of [AD_A, AD_B, "120211000000000003"]) for (let i = 0; i < 5; i++) conv({ ad });
    for (let i = 0; i < 9; i++) conv({ ws: WS_B, ad: "120211000000000077" });
    const p1 = await computeAdSignals(asDb(), WS, { since: "2026-11-10", limit: 2 }, NOW);
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await computeAdSignals(asDb(), WS, { since: "2026-11-10", limit: 2, cursor: p1.next_cursor }, NOW);
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    const all = [...p1.items, ...p2.items].map((i) => i.ad_id);
    expect(new Set(all).size).toBe(3);
    expect(all).not.toContain("120211000000000077");
  });

  it("ما في أي حقل بيانات عميل: مفاتيح العنصر حرفيًا من العقد", async () => {
    for (let i = 0; i < 5; i++) conv({ ad: AD_A, replyMin: 3 });
    stores().customer.push({ id: "cu1", workspaceId: WS, name: "أحمد الاختبار", phone: "0791234567" });
    const r = await computeAdSignals(asDb(), WS, { since: "2026-11-10" }, NOW);
    expect(Object.keys(r.items[0]).sort()).toEqual(
      ["ad_id", "conversations_started", "date", "first_response_p50_min", "handoffs_by_reason", "orders_confirmed", "orders_drafted", "unanswered"]
    );
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("أحمد");
    expect(dump).not.toContain("0791234567");
    expect(dump).not.toMatch(/cu\d|"c\d+"/); // لا معرّف محادثة ولا عميل
  });
});

describe("تحقق الاستعلام = 400 VALIDATION_FAILED", () => {
  const today = "2026-11-18";
  it("since مطلوب وصيغته وعمره ≤ 31 يوم، و until ≥ since، و limit 1..200، و cursor صالح", () => {
    const code = (q: Parameters<typeof parseAdSignalsQuery>[0]) => {
      try {
        parseAdSignalsQuery(q, today);
        return "ok";
      } catch (e) {
        return `${(e as { statusCode: number }).statusCode}:${(e as { code: string }).code}`;
      }
    };
    expect(code({ since: null })).toBe("400:VALIDATION_FAILED");
    expect(code({ since: "2026-13-40" })).toBe("400:VALIDATION_FAILED");
    expect(code({ since: "2026-10-01" })).toBe("400:VALIDATION_FAILED"); // أقدم من 31 يوم
    expect(code({ since: "2026-10-18" })).toBe("ok"); // بالضبط 31
    expect(code({ since: "2026-11-10", until: "2026-11-09" })).toBe("400:VALIDATION_FAILED");
    expect(code({ since: "2026-11-10", limit: 0 })).toBe("400:VALIDATION_FAILED");
    expect(code({ since: "2026-11-10", limit: 201 })).toBe("400:VALIDATION_FAILED");
    expect(code({ since: "2026-11-10", limit: 200 })).toBe("ok");
    expect(code({ since: "2026-11-10", cursor: "bad" })).toBe("400:VALIDATION_FAILED");
  });
});

describe("المسار: التوكن والصلاحية", () => {
  const mint = async (scopes: string[]) => (await createIntegrationToken(asDb(), ctx, { system: "mediabuyer", scopes: scopes as never })).token;

  it("بلا توكن / غلط = 401 · توكن بلا ads.read (الافتراضي) = 403 · الكليبر ما بيقدر ينصنع له ads.read", async () => {
    expect((await adSignalsGET(req("/api/v1/ad-signals?since=2026-11-10"))).status).toBe(401);
    expect((await call(`zr_mb_${"x".repeat(32)}`)).status).toBe(401);
    const def = (await createIntegrationToken(asDb(), ctx, { system: "mediabuyer" })).token;
    const res = await call(def);
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("SCOPE_NOT_ALLOWED");
    await expect(createIntegrationToken(asDb(), ctx, { system: "clipper", scopes: ["ads.read"] })).rejects.toMatchObject({ code: "SCOPE_NOT_ALLOWED" });
  });

  it("توكن capacity.read + ads.read: 200 بالشكل حرفيًا، ويظل يقرأ capacity", async () => {
    for (let i = 0; i < 5; i++) conv({ ad: AD_A, replyMin: 3 });
    const t = await mint(["capacity.read", "ads.read"]);
    const res = await call(t, "since=2026-11-01&until=2026-11-30&limit=50");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(["items", "next_cursor"]);
    expect(body.items[0]).toMatchObject({ ad_id: AD_A, conversations_started: 5 });
  });

  it("منتهي / موقوف = 401، وسياق since غلط = 400 بخطأ موحّد", async () => {
    const created = await createIntegrationToken(asDb(), ctx, { system: "mediabuyer", scopes: ["ads.read"] as never });
    const bad = await call(created.token, "since=nope");
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ error: { code: "VALIDATION_FAILED" }, request_id: expect.any(String) });
    stores().integrationToken[0].expiresAt = new Date(Date.now() - 1000);
    expect((await call(created.token)).status).toBe(401);
    stores().integrationToken[0].expiresAt = new Date(Date.now() + 86_400_000);
    expect((await call(created.token)).status).toBe(200);
    await revokeIntegrationToken(asDb(), ctx, created.view.id);
    expect((await call(created.token)).status).toBe(401);
  });
});
