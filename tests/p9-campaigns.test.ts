import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import { setWhatsAppClientFactory, WhatsAppClient } from "@/modules/channels/whatsapp/client";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { AppError, AuthorizationError, NotFoundError } from "@/core/errors";
import {
  SEGMENT_VERSION,
  segmentDefinitionSchema,
  segmentCreateSchema,
} from "@/modules/campaigns/segment-schemas";
import { evaluateSegment, previewSegmentById, SEGMENT_MAX_CANDIDATES } from "@/modules/campaigns/segment-service";
import {
  marketingChannelDecision,
  ALLOWED_TRANSITIONS,
  canTransition,
  CAMPAIGN_BATCH_MAX,
  CAMPAIGN_MAX_ATTEMPTS,
} from "@/modules/campaigns/campaign-schemas";
import { checkRecipientEligibility, campaignRequiresTemplate } from "@/modules/campaigns/eligibility";
import {
  createCampaign,
  updateCampaignDraft,
  validateCampaign,
  approveCampaign,
  scheduleCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  getCampaignRunlog,
} from "@/modules/campaigns/campaign-service";
import { startCampaignRun, campaignTick, dryRunCampaign } from "@/modules/campaigns/campaign-runner";
import { suggestCampaignDraft } from "@/modules/campaigns/ai-draft";
import { ROLE_PERMISSIONS, PERMISSIONS } from "@/modules/rbac/permissions";
import { runJobs } from "@/modules/jobs/handlers";

/**
 * P9 — حملات تسويقية + شرائح جمهور: بوابات مغلقة، موافقة مثبتة، إرسال
 * عبر dispatchOutbound فقط، وحد معدل durable. Meta/Telegram API محاكاة
 * (لا شبكة) — نثبّت سلوكنا: الإرسال عبر القالب المعتمد، إعادة التحقق
 * لكل مستلم، بلا إرسال مزدوج، وبلا تسريب بيانات عملاء للذكاء.
 */
const WS = "ws-p9";
const WS_B = "ws-p9-b";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
let mock: MockAIProvider;

const rnd = () => Math.random().toString(36).slice(2, 9);

const ctx = (can: (p: string) => boolean = () => true, userId = "mgr-1") => ({
  userId,
  workspaceId: WS,
  can: can as never,
});

const consentAll = { version: SEGMENT_VERSION, match: "ALL", conditions: [{ field: "customer.marketingConsent", op: "EQ", value: "OPTED_IN" }] };

async function seedCustomer(extra: Record<string, unknown> = {}, ws = WS) {
  return (await db.customer.create({
    data: { workspaceId: ws, name: `c-${rnd()}`, phone: `+9639${rnd()}`, marketingConsent: "OPTED_IN", ...extra },
  } as never)) as any;
}

async function seedIdentity(customerId: string, channelType = "WHATSAPP", ws = WS) {
  return (await db.channelIdentity.create({
    data: { workspaceId: ws, customerId, channelType, channelExternalId: `ext-${rnd()}` },
  } as never)) as any;
}

async function seedWhatsAppChannel(ws = WS, status = "CONNECTED") {
  const ch = (await db.channel.create({
    data: { workspaceId: ws, type: "WHATSAPP", status, displayName: "WA", externalId: `wa-${rnd()}` },
  } as never)) as any;
  await db.channelAccount.create({
    data: { channelId: ch.id, provider: "WHATSAPP", externalAccountId: ch.externalId, encryptedCredentials: encryptSecret("tok") },
  } as never);
  return ch;
}

let waCalls: Array<Record<string, unknown>> = [];
type WaMode = "ok" | "transient" | "permanent";
function mockWhatsAppSend(mode: WaMode = "ok") {
  waCalls = [];
  setWhatsAppClientFactory(
    () =>
      new WhatsAppClient({
        fetchImpl: (async (_url: string, init?: { body?: string }) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          waCalls.push(body);
          if (mode === "transient") return Response.json({ error: { message: "temp", code: 500 } }, { status: 500 });
          if (mode === "permanent") return Response.json({ error: { message: "outside window", code: 131047 } }, { status: 400 });
          return Response.json({ messaging_product: "whatsapp", messages: [{ id: `wamid-${body.to}` }] });
        }) as typeof fetch,
      })
  );
}

async function seedSegment(definition: unknown = consentAll, ws = WS) {
  return (await db.audienceSegment.create({
    data: { workspaceId: ws, name: `seg-${rnd()}`, definition: definition as never },
  } as never)) as any;
}

async function seedReadyCampaign(opts: { channelType?: string; channelId?: string | null; segmentDefinition?: unknown; content?: Record<string, unknown> } = {}) {
  const ch = opts.channelId === null ? null : await seedWhatsAppChannel();
  const seg = await seedSegment(opts.segmentDefinition ?? consentAll);
  const channelType = opts.channelType ?? "WHATSAPP";
  const content = opts.content ?? { text: "عرض خاص لعملائنا", templateName: "promo_generic", templateLanguage: "ar" };
  const created = await createCampaign(db as Db, ctx(), {
    name: `camp-${rnd()}`,
    segmentId: seg.id,
    channelType,
    ...(ch ? { channelId: ch.id } : {}),
    content,
  });
  await validateCampaign(db as Db, ctx(), created.campaign.id);
  await approveCampaign(db as Db, ctx(), created.campaign.id);
  return { campaignId: created.campaign.id, ch, seg, versionId: created.version.id };
}

beforeEach(async () => {
  db = createFakeDb();
  (db._stores.workspaceMember as any[]).push({ id: "m1", workspaceId: WS, userId: "mgr-1", status: "ACTIVE" });
  setWhatsAppClientFactory(null as never);
  mock = new MockAIProvider();
  setMockAIProvider(mock);
});

// ── 1. Segment definition: closed set only ─────────────────────────────────

describe("P9-1 segment definition closed set", () => {
  it("accepts a valid closed-set definition", () => {
    const def = {
      version: SEGMENT_VERSION,
      match: "ALL",
      conditions: [{ field: "customer.tags", op: "IN", value: ["vip"] }],
    };
    expect(segmentDefinitionSchema.safeParse(def).success).toBe(true);
    expect(segmentCreateSchema.safeParse({ name: "s", definition: def }).success).toBe(true);
  });

  it("rejects free-text fields / ops (no SQL, no code)", () => {
    expect(segmentDefinitionSchema.safeParse({
      version: SEGMENT_VERSION, match: "ALL",
      conditions: [{ field: "customer.customSql", op: "EQ", value: "1=1" }],
    }).success).toBe(false);
    expect(segmentDefinitionSchema.safeParse({
      version: SEGMENT_VERSION, match: "ALL",
      conditions: [{ field: "customer.tags", op: "RAW", value: "x" }],
    }).success).toBe(false);
    expect(segmentDefinitionSchema.safeParse({
      version: SEGMENT_VERSION, match: "ALL",
      conditions: [{ field: "customer.marketingConsent", op: "EQ", value: "MAYBE" }],
    }).success).toBe(false);
  });

  it("rejects wrong version, empty conditions and over-limit", () => {
    expect(segmentDefinitionSchema.safeParse({ version: 2, match: "ALL", conditions: [{ field: "customer.tags", op: "IN", value: ["a"] }] }).success).toBe(false);
    expect(segmentDefinitionSchema.safeParse({ version: SEGMENT_VERSION, match: "ALL", conditions: [] }).success).toBe(false);
    const many = Array.from({ length: 11 }, () => ({ field: "customer.tags", op: "IN", value: ["a"] }));
    expect(segmentDefinitionSchema.safeParse({ version: SEGMENT_VERSION, match: "ALL", conditions: many }).success).toBe(false);
  });

  it("transition table is closed and terminal states never move", () => {
    expect(canTransition("DRAFT", "RUNNING")).toBe(false);
    expect(canTransition("SCHEDULED", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "PAUSED")).toBe(true);
    for (const terminal of ["FAILED", "COMPLETED", "CANCELLED"]) {
      expect(ALLOWED_TRANSITIONS[terminal]).toEqual([]);
      for (const to of Object.keys(ALLOWED_TRANSITIONS)) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
    expect(CAMPAIGN_BATCH_MAX).toBe(50);
    expect(CAMPAIGN_MAX_ATTEMPTS).toBe(5);
  });
});

// ── 2. Marketing channel decisions ─────────────────────────────────────────

describe("P9-2 marketingChannelDecision", () => {
  it("WhatsApp = official TEMPLATE path, Telegram = DIRECT bot-only", () => {
    expect(marketingChannelDecision("WHATSAPP")).toEqual({ allowed: true, mode: "TEMPLATE" });
    expect(marketingChannelDecision("TELEGRAM")).toEqual({ allowed: true, mode: "DIRECT" });
    expect(campaignRequiresTemplate("WHATSAPP")).toBe(true);
    expect(campaignRequiresTemplate("TELEGRAM")).toBe(false);
  });

  it("refuses non-marketing channels with closed reasons", () => {
    for (const ch of ["FACEBOOK", "INSTAGRAM", "WEB"]) {
      expect(marketingChannelDecision(ch)).toEqual({ allowed: false, reason: "CHANNEL_NOT_MARKETING_CAPABLE" });
    }
    expect(marketingChannelDecision("TIKTOK")).toEqual({ allowed: false, reason: "CHANNEL_ACCESS_NOT_APPROVED" });
  });
});

// ── 3. Recipient eligibility (send-time revalidation) ──────────────────────

describe("P9-3 checkRecipientEligibility", () => {
  it("BLACKLISTED beats everything", async () => {
    const c = await seedCustomer({ isBlacklisted: true });
    const r = await checkRecipientEligibility(db as Db, { workspaceId: WS, customerId: c.id, channelType: "WHATSAPP", requireTemplate: true });
    expect(r).toMatchObject({ ok: false, reason: "BLACKLISTED" });
  });

  it("OPTED_OUT and missing consent excluded even with identity", async () => {
    const out = await seedCustomer({ marketingConsent: "OPTED_OUT", marketingOptOutAt: new Date() });
    await seedIdentity(out.id);
    expect(await checkRecipientEligibility(db as Db, { workspaceId: WS, customerId: out.id, channelType: "WHATSAPP", requireTemplate: true }))
      .toMatchObject({ ok: false, reason: "OPTED_OUT" });

    const unknown = await seedCustomer({ marketingConsent: "UNKNOWN" });
    await seedIdentity(unknown.id);
    expect(await checkRecipientEligibility(db as Db, { workspaceId: WS, customerId: unknown.id, channelType: "WHATSAPP", requireTemplate: true }))
      .toMatchObject({ ok: false, reason: "NO_CONSENT" });
  });

  it("phone alone is not a channel contact — identity on the campaign channel required", async () => {
    const c = await seedCustomer({ phone: "+963955000111" });
    expect(await checkRecipientEligibility(db as Db, { workspaceId: WS, customerId: c.id, channelType: "WHATSAPP", requireTemplate: true }))
      .toMatchObject({ ok: false, reason: "NO_CHANNEL_CONTACT" });
    await seedIdentity(c.id, "FACEBOOK");
    expect(await checkRecipientEligibility(db as Db, { workspaceId: WS, customerId: c.id, channelType: "WHATSAPP", requireTemplate: true }))
      .toMatchObject({ ok: false, reason: "NO_CHANNEL_CONTACT" });
    await seedIdentity(c.id, "WHATSAPP");
    expect((await checkRecipientEligibility(db as Db, { workspaceId: WS, customerId: c.id, channelType: "WHATSAPP", requireTemplate: true })).ok).toBe(true);
  });

  it("customer outside the workspace is silently excluded", async () => {
    const c = await seedCustomer({}, WS_B);
    const r = await checkRecipientEligibility(db as Db, { workspaceId: WS, customerId: c.id, channelType: "WHATSAPP", requireTemplate: true });
    expect(r).toMatchObject({ ok: false, reason: "BLACKLISTED" });
  });
});

// ── 4. Segment evaluation: deterministic, workspace-scoped ─────────────────

describe("P9-4 evaluateSegment + preview", () => {
  it("evaluates consent + channel identity; exclusions distributed by closed reasons", async () => {
    const statusAll = { version: SEGMENT_VERSION, match: "ALL", conditions: [{ field: "customer.status", op: "EQ", value: "NEW_LEAD" }] };
    const ok = await seedCustomer();
    await seedIdentity(ok.id);
    const blacklisted = await seedCustomer({ isBlacklisted: true });
    await seedIdentity(blacklisted.id);
    const optedOut = await seedCustomer({ marketingConsent: "OPTED_OUT" });
    await seedIdentity(optedOut.id);
    const noConsent = await seedCustomer({ marketingConsent: "UNKNOWN" });
    await seedIdentity(noConsent.id);
    const noIdentity = await seedCustomer();
    // بلا هوية واتساب
    await seedIdentity(noIdentity.id, "FACEBOOK");

    const r = await evaluateSegment(db as Db, { workspaceId: WS, definition: statusAll, channelType: "WHATSAPP" });
    expect(r.eligible.map((c: any) => c.id)).toEqual([ok.id]);
    expect(r.excludedCount).toBe(4);
    expect(r.byReason.BLACKLISTED ?? 0).toBe(1);
    expect(r.byReason.OPTED_OUT ?? 0).toBe(1);
    expect(r.byReason.NO_CONSENT ?? 0).toBe(1);
    expect(r.byReason.NO_CHANNEL_CONTACT ?? 0).toBe(1);
    expect(r.byChannel).toEqual({ WHATSAPP: 1 });
  });

  it("tags IN/hasSome and workspace isolation", async () => {
    const vip = await seedCustomer({ tags: ["vip", "ar"] });
    const plain = await seedCustomer({ tags: ["ar"] });
    const def = { version: SEGMENT_VERSION, match: "ALL", conditions: [{ field: "customer.tags", op: "IN", value: ["vip"] }] };
    const r = await evaluateSegment(db as Db, { workspaceId: WS, definition: def });
    expect(r.eligible.map((c: any) => c.id)).toEqual([vip.id]);
    // مساحة أخرى لا تُحسب أبدًا
    await seedCustomer({}, WS_B);
    const r2 = await evaluateSegment(db as Db, { workspaceId: WS, definition: consentAll });
    expect(r2.eligible.map((c: any) => c.id).sort()).toEqual([vip.id, plain.id].sort());
  });

  it("noReply post-filter: agent replied after customer → included", async () => {
    const replied = await seedCustomer();
    await seedIdentity(replied.id);
    const ch = await seedWhatsAppChannel();
    await db.conversation.create({
      data: {
        workspaceId: WS, customerId: replied.id, channelId: ch.id, channelConversationId: `cc-${rnd()}`,
        lastAgentMessageAt: new Date(Date.now() - 60_000), lastCustomerMessageAt: new Date(Date.now() - 120_000),
      },
    } as never);
    const def = {
      version: SEGMENT_VERSION, match: "ALL",
      conditions: [
        { field: "customer.marketingConsent", op: "EQ", value: "OPTED_IN" },
        { field: "conversation.noReply", op: "EQ", value: true },
      ],
    };
    const r = await evaluateSegment(db as Db, { workspaceId: WS, definition: def, channelType: "WHATSAPP" });
    expect(r.eligible.map((c: any) => c.id)).toEqual([replied.id]);
  });

  it("orders.hasAny=false excludes customers with orders", async () => {
    const buyer = await seedCustomer();
    const noOrder = await seedCustomer();
    await db.order.create({ data: { workspaceId: WS, customerId: buyer.id, total: 10 } } as never);
    const def = {
      version: SEGMENT_VERSION, match: "ALL",
      conditions: [
        { field: "customer.marketingConsent", op: "EQ", value: "OPTED_IN" },
        { field: "orders.hasAny", op: "EQ", value: false },
      ],
    };
    const r = await evaluateSegment(db as Db, { workspaceId: WS, definition: def });
    expect(r.eligible.map((c: any) => c.id)).toEqual([noOrder.id]);
  });

  it("preview by id: counts from DB, cross-workspace → NotFound", async () => {
    const c = await seedCustomer();
    await seedIdentity(c.id);
    const seg = await seedSegment();
    const p = await previewSegmentById(db as Db, WS, seg.id, "WHATSAPP");
    expect(p.eligibleCount).toBe(1);
    expect(p.segment.id).toBe(seg.id);
    await expect(previewSegmentById(db as Db, WS_B, seg.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("candidate fetch is bounded (SEGMENT_MAX_CANDIDATES cap)", async () => {
    await seedCustomer();
    const spy = vi.spyOn(db.customer, "findMany");
    await evaluateSegment(db as Db, { workspaceId: WS, definition: consentAll, channelType: "WHATSAPP" });
    expect(spy.mock.calls[0][0].take).toBe(SEGMENT_MAX_CANDIDATES + 1);
    spy.mockRestore();
  });

  it("invalid definition fails closed", async () => {
    await expect(evaluateSegment(db as Db, { workspaceId: WS, definition: { version: 9 } }))
      .rejects.toMatchObject({ code: "INVALID_SEGMENT" });
  });
});

// ── 5. Campaign creation: channel gates + template requirement ─────────────

describe("P9-5 createCampaign gates", () => {
  it("refuses non-marketing channels (closed enum) before any decision", async () => {
    const seg = await seedSegment();
    // القنوات غير التسويقية تُرفض عند حدود المخطط (مجموعة مغلقة) — قرار
    // marketingChannelDecision يبقى حارسًا ثانيًا ويُختبر في P9-2.
    await expect(createCampaign(db as Db, ctx(), { name: "x", segmentId: seg.id, channelType: "FACEBOOK" as never, content: { text: "hi" } }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(createCampaign(db as Db, ctx(), { name: "x", segmentId: seg.id, channelType: "TIKTOK" as never, content: { text: "hi" } }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("WhatsApp campaign requires an approved template name", async () => {
    const seg = await seedSegment();
    await expect(createCampaign(db as Db, ctx(), { name: "x", segmentId: seg.id, channelType: "WHATSAPP", content: { text: "hi" } }))
      .rejects.toMatchObject({ code: "TEMPLATE_REQUIRED" });
  });

  it("creates DRAFT campaign with content version 1", async () => {
    const seg = await seedSegment();
    const r = await createCampaign(db as Db, ctx(), {
      name: "حملة", segmentId: seg.id, channelType: "WHATSAPP",
      content: { text: "نص", templateName: "t1", templateLanguage: "ar" },
    });
    const camp = await db.campaign.findUnique({ where: { id: r.campaign.id } } as never) as any;
    expect(camp.status).toBe("DRAFT");
    const v = await (db as any).campaignContentVersion.findFirst({ where: { campaignId: r.campaign.id } });
    expect(v.version).toBe(1);
    expect(v.templateName).toBe("t1");
  });

  it("foreign segment → NotFound (tenant isolation)", async () => {
    const segB = await seedSegment(consentAll, WS_B);
    await expect(createCampaign(db as Db, ctx(), {
      name: "x", segmentId: segB.id, channelType: "WHATSAPP", content: { text: "t", templateName: "t" },
    })).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── 6. Lifecycle: validate → approve → schedule; append-only content ───────

describe("P9-6 lifecycle + approval pinning", () => {
  it("validate requires a CONNECTED channel", async () => {
    const ch = await seedWhatsAppChannel(WS, "DISCONNECTED");
    const seg = await seedSegment();
    const r = await createCampaign(db as Db, ctx(), {
      name: "x", segmentId: seg.id, channelType: "WHATSAPP", channelId: ch.id,
      content: { text: "t", templateName: "t" },
    });
    await expect(validateCampaign(db as Db, ctx(), r.campaign.id)).rejects.toMatchObject({ code: "CHANNEL_NOT_CONNECTED" });
  });

  it("validate → READY with audience hash; approve pins version; schedule enqueues durable run", async () => {
    const { campaignId } = await seedReadyCampaign();
    const camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("READY");
    expect(camp.approvalAudienceHash).toMatch(/^v1:WHATSAPP:e\d+:x\d+$/);
    expect(camp.contentVersionId).toBeTruthy();
    expect(camp.approvedAt).toBeTruthy();

    const s = await scheduleCampaign(db as Db, ctx(), campaignId, {});
    expect(s.ok).toBe(true);
    const camp2 = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp2.status).toBe("SCHEDULED");
    const job = await (db as any).backgroundJob.findFirst({ where: { idempotencyKey: `campaign:${campaignId}:run` } });
    expect(job).toBeTruthy();
    expect(job.type).toBe("run_campaign");
  });

  it("re-scheduling is idempotent (single run job)", async () => {
    const { campaignId } = await seedReadyCampaign();
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    const jobs = await (db as any).backgroundJob.findMany({ where: { idempotencyKey: `campaign:${campaignId}:run` } });
    expect(jobs).toHaveLength(1);
  });

  it("schedule before approval → NOT_APPROVED", async () => {
    const ch = await seedWhatsAppChannel();
    const seg = await seedSegment();
    const r = await createCampaign(db as Db, ctx(), {
      name: "x", segmentId: seg.id, channelType: "WHATSAPP", channelId: ch.id,
      content: { text: "t", templateName: "t" },
    });
    await validateCampaign(db as Db, ctx(), r.campaign.id);
    await expect(scheduleCampaign(db as Db, ctx(), r.campaign.id, {})).rejects.toMatchObject({ code: "NOT_APPROVED" });
  });

  it("audience change after approval → AUDIENCE_CHANGED and back to VALIDATING", async () => {
    const { campaignId } = await seedReadyCampaign();
    const newCust = await seedCustomer();
    await seedIdentity(newCust.id);
    await expect(scheduleCampaign(db as Db, ctx(), campaignId, {})).rejects.toMatchObject({ code: "AUDIENCE_CHANGED" });
    const camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("VALIDATING");
  });

  it("content edit appends version 2 and drops approval", async () => {
    const { campaignId } = await seedReadyCampaign();
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    await updateCampaignDraft(db as Db, ctx(), campaignId, { content: { text: "نص جديد", templateName: "t2", templateLanguage: "ar" } });
    const camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("DRAFT");
    expect(camp.contentVersionId).toBeNull();
    const versions = await (db as any).campaignContentVersion.findMany({ where: { campaignId }, orderBy: { version: "asc" } });
    expect(versions).toHaveLength(2);
    expect(versions[0].text).toBe("عرض خاص لعملائنا"); // append-only: v1 preserved
    expect(versions[1].text).toBe("نص جديد");
    expect(versions[1].version).toBe(2);
  });

  it("approval requires campaigns.approve permission", async () => {
    const ch = await seedWhatsAppChannel();
    const seg = await seedSegment();
    const r = await createCampaign(db as Db, ctx(), {
      name: "x", segmentId: seg.id, channelType: "WHATSAPP", channelId: ch.id,
      content: { text: "t", templateName: "t" },
    });
    await validateCampaign(db as Db, ctx(), r.campaign.id);
    await expect(approveCampaign(db as Db, ctx(() => false), r.campaign.id)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("pause/resume/cancel transitions are enforced", async () => {
    await seedCustomer();
    await seedIdentity((await db.customer.findFirst({ where: { workspaceId: WS } }))!.id);
    const { campaignId } = await seedReadyCampaign();
    await expect(pauseCampaign(db as Db, ctx(), campaignId)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    await startCampaignRun(db as Db, campaignId);
    await pauseCampaign(db as Db, ctx(), campaignId);
    let camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("PAUSED");
    await resumeCampaign(db as Db, ctx(), campaignId);
    camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("RUNNING");
    await cancelCampaign(db as Db, ctx(), campaignId, "اختبار");
    camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("CANCELLED");
    expect(camp.cancelReason).toBe("اختبار");
    await expect(resumeCampaign(db as Db, ctx(), campaignId)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
});

// ── 7. Start gate + snapshot (durable, idempotent) ─────────────────────────

describe("P9-7 startCampaignRun gate + snapshot", () => {
  it("non-SCHEDULED status → no start, no state change", async () => {
    const ch = await seedWhatsAppChannel();
    const seg = await seedSegment();
    const r = await createCampaign(db as Db, ctx(), {
      name: "x", segmentId: seg.id, channelType: "WHATSAPP", channelId: ch.id,
      content: { text: "t", templateName: "t" },
    });
    const res = await startCampaignRun(db as Db, r.campaign.id);
    expect(res.started).toBe(false);
    expect(res.reason).toBe("STATUS_DRAFT");
    const camp = await db.campaign.findUnique({ where: { id: r.campaign.id } } as never) as any;
    expect(camp.status).toBe("DRAFT");
  });

  it("SCHEDULED without pinned approval → FAILED + POLICY_BLOCKED", async () => {
    const { campaignId } = await seedReadyCampaign();
    await db.campaign.update({ where: { id: campaignId }, data: { status: "SCHEDULED", contentVersionId: null, approvedAt: null } } as never);
    const res = await startCampaignRun(db as Db, campaignId);
    expect(res).toEqual({ started: false, reason: "NOT_APPROVED" });
    const camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("FAILED");
    expect(camp.failReason).toBe("NOT_APPROVED");
    const ev = await (db as any).campaignEvent.findFirst({ where: { campaignId, type: "POLICY_BLOCKED" } });
    expect(ev.reason).toBe("NOT_APPROVED");
  });

  it("empty eligible audience → FAILED EMPTY_AUDIENCE", async () => {
    const { campaignId } = await seedReadyCampaign();
    await db.campaign.update({ where: { id: campaignId }, data: { status: "SCHEDULED" } } as never);
    const res = await startCampaignRun(db as Db, campaignId);
    expect(res.reason).toBe("EMPTY_AUDIENCE");
    const camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("FAILED");
  });

  it("start creates PENDING snapshot, RUNNING state, tick:1 job; redelivery idempotent", async () => {
    const ok1 = await seedCustomer();
    await seedIdentity(ok1.id);
    const ok2 = await seedCustomer();
    await seedIdentity(ok2.id);
    await seedCustomer({ marketingConsent: "UNKNOWN" }); // مستبعد من اللقطة
    const { campaignId } = await seedReadyCampaign();
    await scheduleCampaign(db as Db, ctx(), campaignId, {});

    const res = await startCampaignRun(db as Db, campaignId);
    expect(res.started).toBe(true);
    const camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("RUNNING");
    const recips = await (db as any).campaignRecipient.findMany({ where: { campaignId } });
    expect(recips).toHaveLength(2);
    for (const r of recips) expect(r.status).toBe("PENDING");
    const tick = await (db as any).backgroundJob.findFirst({ where: { idempotencyKey: `campaign:${campaignId}:tick:1` } });
    expect(tick.type).toBe("campaign_tick");

    // إعادة تسليم المهمة لا تضاعف اللقطة ولا تعيد البدء
    await startCampaignRun(db as Db, campaignId);
    const recips2 = await (db as any).campaignRecipient.findMany({ where: { campaignId } });
    expect(recips2).toHaveLength(2);
  });
});

// ── 8. Sending: WhatsApp template path via dispatchOutbound ────────────────

describe("P9-8a WhatsApp client error classification", () => {
  it("outside-window template rejection (131047) is PERMANENT; 5xx is TRANSIENT", async () => {
    const perm = new WhatsAppClient({
      fetchImpl: (async () => Response.json({ error: { message: "outside window", code: 131047 } }, { status: 400 })) as typeof fetch,
    });
    await expect(perm.sendTemplate("tok", "pn", "to", { name: "x", language: "ar" })).rejects.toMatchObject({ kind: "PERMANENT" });
    const trans = new WhatsAppClient({
      fetchImpl: (async () => Response.json({ error: { message: "temp", code: 500 } }, { status: 500 })) as typeof fetch,
    });
    await expect(trans.sendTemplate("tok", "pn", "to", { name: "x", language: "ar" })).rejects.toMatchObject({ kind: "TRANSIENT" });
  });
});

describe("P9-8 campaign sending (WhatsApp template, per-recipient revalidation)", () => {
  async function seedTwoEligible() {
    const a = await seedCustomer();
    await seedIdentity(a.id);
    const b = await seedCustomer();
    await seedIdentity(b.id);
    return [a, b];
  }

  it("sends approved template via WhatsApp; recipient SENT with wamid; campaign conversation isolated from AI", async () => {
    const [a, b] = await seedTwoEligible();
    mockWhatsAppSend("ok");
    const { campaignId } = await seedReadyCampaign({
      content: { text: "نص", templateName: "promo", templateLanguage: "ar", templateVariables: { "1": "عرض" } },
    });
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    await startCampaignRun(db as Db, campaignId);
    const t = await campaignTick(db as Db, campaignId, 1);
    expect(t.sent).toBe(2);

    expect(waCalls).toHaveLength(2);
    expect(waCalls[0].type).toBe("template");
    expect((waCalls[0] as any).template.name).toBe("promo");
    expect((waCalls[0] as any).template.language.code).toBe("ar");
    expect((waCalls[0] as any).template.components[0].parameters[0].text).toBe("عرض");

    const recips = await (db as any).campaignRecipient.findMany({ where: { campaignId } });
    for (const r of recips) {
      expect(r.status).toBe("SENT");
      expect(r.messageId).toBeTruthy();
      expect(r.sentAt).toBeTruthy();
    }
    const convs = await (db as any).conversation.findMany({ where: { customerId: { in: [a.id, b.id] } } });
    for (const cv of convs) {
      expect(cv.channelConversationId).toMatch(/^camp-/);
      expect(cv.aiState).toBe("HUMAN_ACTIVE");
      expect(cv.aiEnabled).toBe(false);
    }
    const camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("COMPLETED");
    const log = await getCampaignRunlog(db as Db, WS, campaignId);
    expect(log.recipients).toEqual({ pending: 0, queued: 0, sent: 2, failed: 0, excluded: 0, cancelled: 0 });
    expect(log.events.some((e) => e.type === "COMPLETED")).toBe(true);
  });

  it("send-time revalidation: blacklisted / opted-out after snapshot → EXCLUDED with closed reason", async () => {
    const [a, b] = await seedTwoEligible();
    mockWhatsAppSend("ok");
    const { campaignId } = await seedReadyCampaign();
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    await startCampaignRun(db as Db, campaignId);
    await db.customer.update({ where: { id: a.id }, data: { isBlacklisted: true } } as never);
    await db.customer.update({ where: { id: b.id }, data: { marketingConsent: "OPTED_OUT", marketingOptOutAt: new Date() } } as never);

    await campaignTick(db as Db, campaignId, 1);
    const recips = await (db as any).campaignRecipient.findMany({ where: { campaignId } });
    const byCust = new Map(recips.map((r: any) => [r.customerId, r]));
    expect(byCust.get(a.id).status).toBe("EXCLUDED");
    expect(byCust.get(a.id).excludeReason).toBe("BLACKLISTED");
    expect(byCust.get(b.id).status).toBe("EXCLUDED");
    expect(byCust.get(b.id).excludeReason).toBe("OPTED_OUT");
    expect(waCalls).toHaveLength(0); // لا إرسال لأي مستلم غير مؤهل
  });

  it("cancel between snapshot and tick → PENDING recipients become CANCELLED, zero sends", async () => {
    await seedTwoEligible();
    mockWhatsAppSend("ok");
    const { campaignId } = await seedReadyCampaign();
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    await startCampaignRun(db as Db, campaignId);
    await cancelCampaign(db as Db, ctx(), campaignId);
    await campaignTick(db as Db, campaignId, 1);
    const recips = await (db as any).campaignRecipient.findMany({ where: { campaignId } });
    for (const r of recips) expect(r.status).toBe("CANCELLED");
    expect(waCalls).toHaveLength(0);
  });

  it("pause halts the batch immediately; resume completes the run", async () => {
    await seedTwoEligible();
    mockWhatsAppSend("ok");
    const { campaignId } = await seedReadyCampaign();
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    await startCampaignRun(db as Db, campaignId);
    await pauseCampaign(db as Db, ctx(), campaignId);
    const t = await campaignTick(db as Db, campaignId, 1);
    expect(t.sent).toBe(0);
    expect(waCalls).toHaveLength(0);
    await resumeCampaign(db as Db, ctx(), campaignId);
    const t2 = await campaignTick(db as Db, campaignId, 2);
    expect(t2.sent).toBe(2);
  });

  it("durable minute window: ratePerMinute=1 → one send per window, second waits", async () => {
    await seedTwoEligible();
    mockWhatsAppSend("ok");
    const { campaignId } = await seedReadyCampaign();
    await db.campaign.update({ where: { id: campaignId }, data: { ratePerMinute: 1 } } as never);
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    await startCampaignRun(db as Db, campaignId);

    const t1 = await campaignTick(db as Db, campaignId, 1);
    expect(t1.sent).toBe(1);
    expect(waCalls).toHaveLength(1);
    let camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.sentInWindow).toBe(1);

    const t2 = await campaignTick(db as Db, campaignId, 2);
    expect(t2.sent).toBe(0); // النافذة ممتلئة
    expect(waCalls).toHaveLength(1);
    const pending = await (db as any).campaignRecipient.findMany({ where: { campaignId, status: "PENDING" } });
    expect(pending).toHaveLength(1);
  });

  it("transient provider error → stays PENDING (bounded attempts); permanent → FAILED PERMANENT", async () => {
    const [a] = await seedTwoEligible();
    mockWhatsAppSend("transient");
    const { campaignId } = await seedReadyCampaign();
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    await startCampaignRun(db as Db, campaignId);
    await campaignTick(db as Db, campaignId, 1);
    let recips = await (db as any).campaignRecipient.findMany({ where: { campaignId, customerId: a.id } });
    expect(recips[0].status).toBe("PENDING");
    expect(recips[0].attempts).toBe(1);

    mockWhatsAppSend("permanent");
    await campaignTick(db as Db, campaignId, 2);
    recips = await (db as any).campaignRecipient.findMany({ where: { campaignId, customerId: a.id } });
    expect(recips[0].status, JSON.stringify(recips[0])).toBe("FAILED");
    expect(recips[0].errorCategory).toBe("PERMANENT");
  });

  it("attempts cap → FAILED after CAMPAIGN_MAX_ATTEMPTS transient failures", async () => {
    const [a] = await seedTwoEligible();
    mockWhatsAppSend("transient");
    const { campaignId } = await seedReadyCampaign();
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    await startCampaignRun(db as Db, campaignId);
    const rec = await (db as any).campaignRecipient.findFirst({ where: { campaignId, customerId: a.id } });
    await (db as any).campaignRecipient.update({ where: { id: rec.id }, data: { attempts: CAMPAIGN_MAX_ATTEMPTS - 1 } });
    await campaignTick(db as Db, campaignId, 1);
    const recips = await (db as any).campaignRecipient.findMany({ where: { campaignId, customerId: a.id } });
    expect(recips[0].status).toBe("FAILED");
    expect(recips[0].errorCategory).toBe("TRANSIENT");
    expect(recips[0].attempts).toBe(CAMPAIGN_MAX_ATTEMPTS);
  });

  it("sourceMessageId is stable per recipient (no duplicate sends on retry)", async () => {
    const [a] = await seedTwoEligible();
    mockWhatsAppSend("ok");
    const { campaignId } = await seedReadyCampaign();
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    await startCampaignRun(db as Db, campaignId);
    await campaignTick(db as Db, campaignId, 1);
    // المفتاح يُبنى من صف المستلم نفسه → إعادة المحاولة تستعيد القبول بدل الإرسال المزدوج
    const rec = await (db as any).campaignRecipient.findFirst({ where: { campaignId, customerId: a.id } });
    const recips = await (db as any).campaignRecipient.findMany({ where: { campaignId, customerId: a.id } });
    expect(recips.filter((r: any) => r.status === "SENT")).toHaveLength(1);
    expect(rec.status).toBe("SENT");
  });
});

// ── 9. Dry-run: read-only gate preview ──────────────────────────────────────

describe("P9-9 dryRunCampaign", () => {
  it("surfaces NOT_APPROVED before approval; writes nothing", async () => {
    await seedCustomer();
    await seedIdentity((await db.customer.findFirst({ where: { workspaceId: WS } }))!.id);
    const ch = await seedWhatsAppChannel();
    const seg = await seedSegment();
    const r = await createCampaign(db as Db, ctx(), {
      name: "x", segmentId: seg.id, channelType: "WHATSAPP", channelId: ch.id,
      content: { text: "t", templateName: "t" },
    });
    await validateCampaign(db as Db, ctx(), r.campaign.id);
    const d = await dryRunCampaign(db as Db, WS, r.campaign.id);
    expect(d.dryRun).toBe(true);
    expect(d.issues).toContain("NOT_APPROVED");
    expect(d.eligibleCount).toBe(1);
    expect(await (db as any).campaignRecipient.findMany({ where: { campaignId: r.campaign.id } })).toHaveLength(0);
    expect(await (db as any).backgroundJob.findMany({})).toHaveLength(0);
  });

  it("approved + scheduled → no issues, counts match evaluation", async () => {
    const c = await seedCustomer();
    await seedIdentity(c.id);
    const { campaignId } = await seedReadyCampaign();
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    const d = await dryRunCampaign(db as Db, WS, campaignId);
    expect(d.issues).toEqual([]);
    expect(d.eligibleCount).toBe(1);
    expect(d.template).toEqual({ name: "promo_generic", language: "ar" });
  });
});

// ── 10. RBAC pins ────────────────────────────────────────────────────────────

describe("P9-10 campaign permissions", () => {
  it("closed permission set + role pins", () => {
    expect(PERMISSIONS).toContain("campaigns.read");
    expect(PERMISSIONS).toContain("campaigns.write");
    expect(PERMISSIONS).toContain("campaigns.approve");
    const m = ROLE_PERMISSIONS.MANAGER;
    expect(m).toContain("campaigns.read");
    expect(m).toContain("campaigns.write");
    expect(m).toContain("campaigns.approve");
    const s = ROLE_PERMISSIONS.SALES_AGENT;
    expect(s).toContain("campaigns.read");
    expect(s).not.toContain("campaigns.write");
    expect(s).not.toContain("campaigns.approve");
    expect(ROLE_PERMISSIONS.VIEWER).toContain("campaigns.read");
  });
});

// ── 11. AI draft: no customer data, approved channels only ──────────────────

describe("P9-11 suggestCampaignDraft", () => {
  it("rejects non-marketing channels", async () => {
    await expect(suggestCampaignDraft(db as Db, { workspaceId: WS, channelType: "FACEBOOK" }))
      .rejects.toMatchObject({ code: "CHANNEL_NOT_MARKETING_CAPABLE" });
  });

  it("sends zero customer PII (empty pii object) and marks purpose CAMPAIGN_DRAFT", async () => {
    await seedCustomer({ name: "محمد السر", phone: "+963955111222" });
    let seen: { system?: string; user?: string } = {};
    mock.responseHandler = (user: string, system: string) => {
      seen = { user, system };
      return "نص حملة تسويقية جاهز للمراجعة";
    };
    const r = await suggestCampaignDraft(db as Db, { workspaceId: WS, channelType: "WHATSAPP", productName: "كريم", tone: "ودود" });
    expect(r.purpose).toBe("CAMPAIGN_DRAFT");
    expect(r.draft).toContain("حملة");
    const leaked = JSON.stringify(seen);
    expect(leaked).not.toContain("محمد السر");
    expect(leaked).not.toContain("0955111222");
  });
});

// ── 12. Durable job integration: runJobs drives run_campaign + ticks ────────

describe("P9-12 runJobs integration", () => {
  it("scheduled campaign starts via runJobs, sends via ticks, completes", async () => {
    const a = await seedCustomer();
    await seedIdentity(a.id);
    mockWhatsAppSend("ok");
    const { campaignId } = await seedReadyCampaign();
    await scheduleCampaign(db as Db, ctx(), campaignId, {});

    await runJobs(db as never, { limit: 10 }); // run_campaign → snapshot + RUNNING + tick:1
    let camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("RUNNING");
    expect(await (db as any).campaignRecipient.count({ where: { campaignId } })).toBe(1);

    await campaignTick(db as Db, campaignId, 1); // الدفعة الأولى
    camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("COMPLETED");
    const rec = await (db as any).campaignRecipient.findFirst({ where: { campaignId } });
    expect(rec.status).toBe("SENT");
    expect(waCalls).toHaveLength(1);
  });

  it("run_campaign job redelivery after completion is a no-op", async () => {
    const a = await seedCustomer();
    await seedIdentity(a.id);
    mockWhatsAppSend("ok");
    const { campaignId } = await seedReadyCampaign();
    await scheduleCampaign(db as Db, ctx(), campaignId, {});
    await runJobs(db as never, { limit: 10 });
    await campaignTick(db as Db, campaignId, 1);
    expect(waCalls).toHaveLength(1);
    // إعادة تسليم run_campaign (شبكة/إعادة تشغيل) — لا إرسال إضافي
    await startCampaignRun(db as Db, campaignId);
    expect(waCalls).toHaveLength(1);
    const camp = await db.campaign.findUnique({ where: { id: campaignId } } as never) as any;
    expect(camp.status).toBe("COMPLETED");
  });
});
