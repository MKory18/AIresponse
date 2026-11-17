import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createFakeDb } from "./helpers/inmemory-db";
import { canTransitionOrder } from "@/modules/orders/state-machine";
import {
  DEFAULT_INTEGRATION_SETTINGS,
  integrationSettingsSchema,
  resolveIntegrationSettings,
} from "@/modules/integrations/settings";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@/modules/rbac/permissions";

/**
 * الحزمة 1.1 — مخطط قارئ الطلب والإعدادات والصلاحيات (02-ORDER-FLOW §6).
 * ولا سلوك بتغيّر: ولا كود بيستعمل الجداول لسا.
 */

describe("المخزنين الجداد بالقاعدة الوهمية", () => {
  it("conversationReading: القيم الافتراضية + فريد على conversationId", async () => {
    const db = createFakeDb();
    const row = (await db.conversationReading.create({ data: { workspaceId: "w", conversationId: "c1" } } as never)) as any;
    expect(row).toMatchObject({ version: 0, stage: "NONE", status: "IDLE", attempts: 0, missing: [], flags: [], data: {} });
    await expect(db.conversationReading.create({ data: { workspaceId: "w", conversationId: "c1" } } as never)).rejects.toMatchObject({ code: "P2002" });
    await db.conversationReading.create({ data: { workspaceId: "w", conversationId: "c2" } } as never);
  });

  it("orderRevision: فريد على (orderId, version)", async () => {
    const db = createFakeDb();
    const base = { workspaceId: "w", orderId: "o1", kind: "READ", snapshot: {}, actor: "reader" };
    await db.orderRevision.create({ data: { ...base, version: 1 } } as never);
    await db.orderRevision.create({ data: { ...base, version: 2 } } as never);
    await db.orderRevision.create({ data: { ...base, orderId: "o2", version: 1 } } as never);
    await expect(db.orderRevision.create({ data: { ...base, version: 1 } } as never)).rejects.toMatchObject({ code: "P2002" });
    const r = (await db.orderRevision.findMany({ where: { orderId: "o1" } })) as any[];
    expect(r[0]).toMatchObject({ diff: [], evidence: [], omsState: null });
  });

  it("order: أعمدة القارئ الإضافية بقيمها الافتراضية", async () => {
    const db = createFakeDb();
    const o = (await db.order.create({ data: { workspaceId: "w", orderNumber: "N1", customerId: "c" } } as never)) as any;
    expect(o).toMatchObject({ settleAt: null, sealedAt: null, readVersion: 0, reviewReasons: [], agreement: null, heldBy: null });
  });
});

describe("آلة حالات الطلب", () => {
  it("CONFIRMATION_PENDING → NEW انضاف، والباقي ما تغيّر", () => {
    expect(canTransitionOrder("CONFIRMATION_PENDING", "NEW")).toBe(true);
    expect(canTransitionOrder("CONFIRMATION_PENDING", "CONFIRMED")).toBe(true);
    expect(canTransitionOrder("NEW", "CONFIRMATION_PENDING")).toBe(true);
    // ما انفتح شي زيادة:
    expect(canTransitionOrder("CONFIRMED", "NEW")).toBe(false);
    expect(canTransitionOrder("CANCELLED", "NEW")).toBe(false);
    expect(canTransitionOrder("DELIVERED", "NEW")).toBe(false);
  });
});

describe("إعدادات القارئ (بلا ترحيل)", () => {
  it("الافتراضات: المسودة القديمة شغّالة والمهلة 10 دقايق", () => {
    expect(DEFAULT_INTEGRATION_SETTINGS).toMatchObject({
      orderMode: "LEGACY_DRAFT",
      orderSettleMinutes: 10,
      orderAutoSeal: true,
      orderAgreementPolicy: "EXPLICIT_OR_IMPLICIT",
      orderConfirmMessage: true,
    });
  });
  it("القيمة التالفة بتسقط وحدها", () => {
    const r = resolveIntegrationSettings({ orderMode: "READER", orderSettleMinutes: 1, orderAutoSeal: "yes" });
    expect(r.orderMode).toBe("READER");
    expect(r.orderSettleMinutes).toBe(10); // أقل من 2 ← الافتراضي
    expect(r.orderAutoSeal).toBe(true);
  });
  it("الحدود: 2..120", () => {
    const base = DEFAULT_INTEGRATION_SETTINGS;
    expect(integrationSettingsSchema.safeParse({ ...base, orderSettleMinutes: 2 }).success).toBe(true);
    expect(integrationSettingsSchema.safeParse({ ...base, orderSettleMinutes: 120 }).success).toBe(true);
    expect(integrationSettingsSchema.safeParse({ ...base, orderSettleMinutes: 121 }).success).toBe(false);
    expect(integrationSettingsSchema.safeParse({ ...base, orderMode: "OTHER" }).success).toBe(false);
  });
});

describe("صلاحيات الطلب الجديدة (04-PERMISSIONS §4.1)", () => {
  it("موجودة ومتوزعة: seal/cancel مالك·شريك·مشرف·مبيعات — amend مالك·شريك·مشرف", () => {
    for (const p of ["orders.seal", "orders.cancel", "orders.amend"] as const) expect(PERMISSIONS).toContain(p);
    for (const role of ["OWNER", "ADMIN", "MANAGER", "SALES_AGENT"]) {
      expect(ROLE_PERMISSIONS[role], role).toContain("orders.seal");
      expect(ROLE_PERMISSIONS[role], role).toContain("orders.cancel");
    }
    for (const role of ["OWNER", "ADMIN", "MANAGER"]) expect(ROLE_PERMISSIONS[role]).toContain("orders.amend");
    expect(ROLE_PERMISSIONS.SALES_AGENT).not.toContain("orders.amend");
    for (const role of ["SUPPORT_AGENT", "VIEWER"]) {
      for (const p of ["orders.seal", "orders.cancel", "orders.amend"]) expect(ROLE_PERMISSIONS[role]).not.toContain(p);
    }
  });
});

describe("الترحيل إضافي بس", () => {
  it("ملف order_reader ما فيه DROP/ALTER COLUMN/RENAME/DELETE", () => {
    const dir = readdirSync("prisma/migrations").filter((d) => d.endsWith("_order_reader"));
    expect(dir.length).toBe(1);
    const sql = readFileSync(`prisma/migrations/${dir[0]}/migration.sql`, "utf8");
    expect(sql).not.toMatch(/\b(DROP|RENAME|DELETE|TRUNCATE)\b|ALTER COLUMN/i);
    expect(sql).toContain('ADD VALUE \'ORDER_CHANGE_REQUEST\'');
  });
});
