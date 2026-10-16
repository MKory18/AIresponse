/**
 * Wave 1 لمواضع الفحص الكامل (docs/CODE-REVIEW-OCR-2026-10-16.md).
 * كل اختبار هون كان بيفشل قبل التصليح، وبينجح بعده — قاعدة المشروع.
 * النطاق: HIGH 1-10 + المتوسطات المثبتة بالدفعة الأولى.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import { AppError } from "@/core/errors";
import { OMS_NO_TOKEN, resolveOmsWebhookSecret } from "@/modules/oms/connection";
import { getWorkspaceProvider } from "@/modules/ai/router";
import { calculatePricing } from "@/modules/orders/pricing";
import { resolveRange } from "@/core/analytics/time";
import { externalEmbeddingAllowed, OpenAIEmbeddingProvider } from "@/modules/knowledge/embeddings";
import { processPendingJobs } from "@/modules/jobs/service";
import { handleChannelInbound } from "@/modules/channels/inbound-job";
import { inviteMember, removeMember, updateMember } from "@/modules/members/service";

type Db = Prisma.TransactionClient;

// ── 1) توقيع ويب هوك الـ OMS — العلامة اليدوية "أبدًا" ما تكون سرًا (HIGH 1) ──
describe("OCR — OMS webhook secret resolution", () => {
  const ws = "ws-ocr-oms";
  it("manual mode with the public placeholder token resolves to NO secret", () => {
    const conn = {
      mode: "manual",
      tokenEncrypted: encryptSecret(OMS_NO_TOKEN),
      webhookSecretEncrypted: null,
    };
    expect(resolveOmsWebhookSecret(conn)).toBeNull();
  });

  it("webhook secret wins over the legacy token when both exist", () => {
    const conn = {
      mode: "api",
      tokenEncrypted: encryptSecret("api-token-value"),
      webhookSecretEncrypted: encryptSecret("webhook-secret-value"),
    };
    expect(resolveOmsWebhookSecret(conn)).toBe("webhook-secret-value");
  });

  it("legacy api row keeps its real token as the signing secret", () => {
    const conn = {
      mode: "api",
      tokenEncrypted: encryptSecret("api-token-value"),
      webhookSecretEncrypted: null,
    };
    expect(resolveOmsWebhookSecret(conn)).toBe("api-token-value");
  });

  it("manual mode never falls back to the token even with a real one", () => {
    const conn = {
      mode: "manual",
      tokenEncrypted: encryptSecret("real-token-value"),
      webhookSecretEncrypted: null,
    };
    expect(resolveOmsWebhookSecret(conn)).toBeNull();
  });
});

// ── 2) متوسطة — مفاتيح المنصة ما تترحل لعناوين مخصصة من مساحة عمل (HIGH 2) ──
describe("OCR — workspace customBaseUrl never leaks platform env keys", () => {
  const env = {
    aiProvider: "openai",
    openaiKey: "sk-platform-secret",
    openrouterKey: undefined,
    hermesBaseUrl: undefined,
    hermesKey: undefined,
    hermesModel: undefined,
    responseModel: "gpt-4o-mini",
    nodeEnv: "test",
    allowMockAi: undefined,
  };

  it("refuses to attach the platform OPENAI key to a workspace URL", () => {
    expect(() =>
      getWorkspaceProvider(
        { provider: "openai", customBaseUrl: "https://evil-gw.example/v1", responseModel: null },
        env
      )
    ).toThrow(/AI_WORKSPACE_GATEWAY_KEYS/);
  });

  it("opt-in flag keeps the documented gateway behavior working", () => {
    const p = getWorkspaceProvider(
      { provider: "openai", customBaseUrl: "https://gateway.ok.example/v1", responseModel: null },
      { ...env, allowWorkspaceGatewayKeys: "1" }
    );
    expect(p.name).toBe("internal");
  });

  it("no platform key → same internal behavior as before", () => {
    const p = getWorkspaceProvider(
      { provider: "openai", customBaseUrl: "https://gateway.ok.example/v1", responseModel: null },
      { ...env, openaiKey: undefined }
    );
    expect(p.name).toBe("internal");
  });

  it("official openai endpoint without customBaseUrl is unchanged", () => {
    const p = getWorkspaceProvider({ provider: "openai", customBaseUrl: null, responseModel: null }, env);
    expect(p.name).toBe("openai");
  });
});

// ── 3) تسعير المبالغ — قرش واحد، لا فواصل عائمة (HIGH 6) ──
describe("OCR — order pricing in cents", () => {
  it("0.1 × 3 is exactly 0.30 — no float dust", async () => {
    const db = createFakeDb();
    const b = await calculatePricing(db as Db, {
      workspaceId: "ws-pr",
      product: { price: 0.1, currency: "USD" },
      quantity: 3,
    });
    expect(b.subtotal).toBe(0.3);
    expect(b.total).toBe(0.3);
  });

  it("19.99 × 3 rounds once — 59.97", async () => {
    const db = createFakeDb();
    const b = await calculatePricing(db as Db, {
      workspaceId: "ws-pr",
      product: { price: 19.99, currency: "USD" },
      quantity: 3,
    });
    expect(b.total).toBe(59.97);
  });

  it("negative discount is clamped to zero", async () => {
    const db = createFakeDb();
    const b = await calculatePricing(db as Db, {
      workspaceId: "ws-pr",
      product: { price: 10, currency: "USD" },
      quantity: 1,
      discount: -5,
    });
    expect(b.discount).toBe(0);
    expect(b.total).toBe(10);
  });

  it("integer money is bit-identical to the old behavior", async () => {
    const db = createFakeDb();
    const b = await calculatePricing(db as Db, {
      workspaceId: "ws-pr",
      product: { price: 150000, currency: "SYP" },
      quantity: 3,
    });
    expect(b.subtotal).toBe(450000);
    expect(b.total).toBe(450000);
  });
});

// ── 4) رسالة فاشلة بتصيب الدفعة (HIGH 8) ──
describe("OCR — partial channel-inbound batch failure is a failed job", () => {
  it("failed > 0 → success:false (full-batch retry contract)", async () => {
    vi.doMock("@/modules/conversations/service", () => ({
      processIncomingMessage: async (db: unknown, input: { externalMessageId: string }) => {
        if (input.externalMessageId === "boom") throw new Error("DB veto");
      },
    }));
    try {
      const db = createFakeDb();
      const base = {
        channelId: "ch-1",
        channelType: "TELEGRAM" as const,
        provider: "telegram",
        externalUserId: "u1",
        externalConversationId: "c1",
        externalEventId: "ev",
        type: "TEXT" as const,
        metadata: {},
      };
      const result = await handleChannelInbound(db as unknown as Db, {
        workspaceId: "ws-in",
        messages: [
          { ...base, externalMessageId: "ok1" },
          { ...base, externalMessageId: "boom" },
          { ...base, externalMessageId: "ok2" },
        ] as never,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/failed/);
    } finally {
      vi.doUnmock("@/modules/conversations/service");
      vi.resetModules();
    }
  });
});

// ── 5) مدى التواريخ المخصص — 422 موثقة، لا 500 (متوسطة) ──
describe("OCR — custom range validation", () => {
  it("missing from → AppError 422 INVALID_RANGE (never a bare Error)", () => {
    try {
      resolveRange({ range: "custom" });
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(422);
      expect((err as AppError).code).toBe("INVALID_RANGE");
    }
  });

  it("reversed range (to before from) is refused", () => {
    try {
      resolveRange({ range: "custom", from: "2026-02-01", to: "2026-01-01" });
      expect.unreachable("must throw");
    } catch (err) {
      expect((err as AppError).code).toBe("INVALID_RANGE");
      expect((err as AppError).statusCode).toBe(422);
    }
  });
});

// ── 6) embed محرم للخارج افتراضيًا (HIGH 4) ──
describe("OCR — external embeddings are fail-closed by policy", () => {
  const KEY = process.env.OPENAI_API_KEY;
  const FLAG = process.env.AI_ALLOW_EXTERNAL_EMBEDDINGS;
  afterEach(() => {
    if (KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = KEY;
    if (FLAG === undefined) delete process.env.AI_ALLOW_EXTERNAL_EMBEDDINGS;
    else process.env.AI_ALLOW_EXTERNAL_EMBEDDINGS = FLAG;
  });

  it("default (no flag) → provider refuses before any network call", async () => {
    process.env.OPENAI_API_KEY = "sk-present";
    delete process.env.AI_ALLOW_EXTERNAL_EMBEDDINGS;
    const p = new OpenAIEmbeddingProvider("text-embedding-3-small", 1536);
    await expect(p.embed("نص زبون")).rejects.toThrow(/EXTERNAL_EMBEDDING_DISABLED/);
  });

  it("flag decision reflects the env explicitly", () => {
    delete process.env.AI_ALLOW_EXTERNAL_EMBEDDINGS;
    expect(externalEmbeddingAllowed()).toBe(false);
    process.env.AI_ALLOW_EXTERNAL_EMBEDDINGS = "1";
    expect(externalEmbeddingAllowed()).toBe(true);
  });
});

// ── 7) مهلة كل مهمة — Worker لا يتجمد أبدًا (HIGH 5) ──
describe("OCR — per-job timeout keeps the worker alive", () => {
  const OLD = process.env.JOB_TIMEOUT_MS;
  beforeEach(() => {
    process.env.JOB_TIMEOUT_MS = "30";
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.JOB_TIMEOUT_MS;
    else process.env.JOB_TIMEOUT_MS = OLD;
  });

  it("a hung handler fails the job instead of freezing the cycle", async () => {
    const db = createFakeDb();
    await (db as any).backgroundJob.create({
      data: { workspaceId: "ws-job", type: "t_hang", payload: {}, runAfter: new Date(0) },
    });
    const res = await processPendingJobs(db as unknown as Prisma.TransactionClient, {
      t_hang: async () => {
        await new Promise((r) => setTimeout(r, 250));
        return { success: true } as const;
      },
    }, { workerId: "ocr-test" });
    expect(res.processed).toBe(0);
    expect(res.failed).toBe(1);
    const row = (db as any)._stores.backgroundJob[0];
    expect(String(row.lastError)).toMatch(/JOB_TIMEOUT/);
    expect(row.status).toBe("PENDING"); // إعادة محاولة مدارة، لا تجميد
  });
});

// ── 8) أعضاء — رتبة OWNER فقط تدير OWNER (HIGH 10) ──
describe("OCR — only OWNER manages OWNER rows", () => {
  let db: ReturnType<typeof createFakeDb>;
  let adminCtx: { userId: string; workspaceId: string };
  let ownerUserId: string;
  let ownerMemberId: string;

  beforeEach(async () => {
    db = createFakeDb();
    const owner = await (db as any).user.create({ data: { email: "o@x.test", name: "مالك", passwordHash: "x" } });
    ownerUserId = owner.id;
    await (db as any).workspace.create({ data: { id: "ws-mem", name: "W", slug: "wm-ocr" } });
    const om = await (db as any).workspaceMember.create({
      data: { workspaceId: "ws-mem", userId: owner.id, role: "OWNER", status: "ACTIVE" },
    });
    ownerMemberId = om.id;
    const admin = await (db as any).user.create({ data: { email: "a@x.test", name: "مدير", passwordHash: "x" } });
    await (db as any).workspaceMember.create({
      data: { workspaceId: "ws-mem", userId: admin.id, role: "ADMIN", status: "ACTIVE" },
    });
    adminCtx = { userId: admin.id, workspaceId: "ws-mem" };
  });

  it("ADMIN cannot invite an OWNER", async () => {
    await expect(inviteMember(db as Db, adminCtx, { email: "new@x.test", role: "OWNER" })).rejects.toMatchObject({
      code: "OWNER_ROLE_REQUIRED",
    });
  });

  it("ADMIN cannot suspend or demote an OWNER", async () => {
    // مالك تاني نشيط — كي لا يشتغل حارس المالك الأخير ويخفي حارس الرتبة.
    const backup = await (db as any).user.create({ data: { email: "o2@x.test", name: "مالك2", passwordHash: "x" } });
    await (db as any).workspaceMember.create({
      data: { workspaceId: "ws-mem", userId: backup.id, role: "OWNER", status: "ACTIVE" },
    });
    await expect(updateMember(db as Db, adminCtx, ownerMemberId, { status: "SUSPENDED" })).rejects.toMatchObject({
      code: "OWNER_ROLE_REQUIRED",
    });
    await expect(updateMember(db as Db, adminCtx, ownerMemberId, { role: "VIEWER" as never })).rejects.toMatchObject({
      code: "OWNER_ROLE_REQUIRED",
    });
  });

  it("ADMIN cannot remove an OWNER (rank guard, beyond the last-owner floor)", async () => {
    // مالك تاني نشيط: الحذف ما بيمس حارس الأرضية — الرتبة هي اللي بترفض.
    const backup = await (db as any).user.create({ data: { email: "o3@x.test", name: "مالك3", passwordHash: "x" } });
    await (db as any).workspaceMember.create({
      data: { workspaceId: "ws-mem", userId: backup.id, role: "OWNER", status: "ACTIVE" },
    });
    await expect(removeMember(db as Db, adminCtx, ownerMemberId)).rejects.toMatchObject({
      code: "OWNER_ROLE_REQUIRED",
    });
    expect(ownerUserId).toBeTruthy();
  });

  it("lower-role management below OWNER stays allowed for admins", async () => {
    const agent = await (db as any).user.create({ data: { email: "ag@x.test", name: "موظف", passwordHash: "x" } });
    const am = await (db as any).workspaceMember.create({
      data: { workspaceId: "ws-mem", userId: agent.id, role: "VIEWER", status: "ACTIVE" },
    });
    const upd = await updateMember(db as Db, adminCtx, am.id, { role: "MANAGER" });
    expect((upd as any).role).toBe("MANAGER");
  });
});

// ── 9) الكاتولج — وسائط الزبون الواردة ما تطلع (HIGH 7) — يغطى بمسارات الخدمة ──
describe("OCR — page product context excludes inbound media (unit at query seam)", () => {
  it("excludeCustomerInbound contract shape is stable", async () => {
    const { excludeCustomerInbound } = await import("@/modules/media/service");
    expect(excludeCustomerInbound()).toEqual({ category: { not: "CUSTOMER_INBOUND" } });
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
