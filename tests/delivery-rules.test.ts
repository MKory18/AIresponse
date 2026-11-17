/**
 * الحزمة 3.4أ — مناطق التوصيل: CRUD بصلاحيات وعزل مساحات، تحذير «الباقي غير متاح»، وتوافق مع حاسبة الرسم.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { ALL_PROVINCES, deleteRule, listRules, ruleInputSchema, saveRules } from "@/modules/delivery-rules/service";
import { quoteDelivery } from "@/modules/orders/delivery";
import { KNOWN_PROVINCES, PROVINCES_BY_MARKET } from "@/modules/orders/primitives";

type Db = Prisma.TransactionClient;
const WS = "ws-del";
const ctx = { userId: "u1", workspaceId: WS };
let db: ReturnType<typeof createFakeDb>;

beforeEach(async () => {
  db = createFakeDb();
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
});

describe("القائمة والتحذير", () => {
  it("مساحة بلا قواعد: الكل ناقص، وما في تحذير «جزئي» (السلوك الافتراضي القديم)", async () => {
    const r = await listRules(db, WS);
    expect(r.rules).toEqual([]);
    expect(r.missing).toEqual([...ALL_PROVINCES]);
    expect(r.partial).toBe(false);
  });

  it("قاعدة وحدة = جزئي (الباقي «غير متاح») — بنفس سلوك حاسبة الرسم", async () => {
    await saveRules(db, ctx, ruleInputSchema.parse({ provinces: ["دمشق"], fee: 3 }));
    const r = await listRules(db, WS);
    expect(r.partial).toBe(true);
    expect(r.missing).not.toContain("دمشق");
    // المحافظة الناقصة فعلًا بتنرفض عند الحساب:
    const q = await quoteDelivery(db as unknown as Db, { workspaceId: WS, province: "حلب", subtotal: 10 });
    expect(q).toMatchObject({ available: false, reason: "NO_DELIVERY_RULE" });
  });

  it("تغطية كل المحافظات = مش جزئي", async () => {
    await saveRules(db, ctx, ruleInputSchema.parse({ provinces: [...ALL_PROVINCES], fee: 2 }));
    expect((await listRules(db, WS)).partial).toBe(false);
  });

  it("قائمة المحافظات = كل أسواق النظام (سوريا والأردن)", () => {
    for (const p of KNOWN_PROVINCES) expect(ALL_PROVINCES).toContain(p);
    for (const p of PROVINCES_BY_MARKET.JO!) expect(ALL_PROVINCES).toContain(p);
  });
});

describe("الحفظ", () => {
  it("إنشاء ثم تحديث لنفس المحافظة (بلا تكرار)، والحفظ الجماعي لمحافظات متعددة", async () => {
    await saveRules(db, ctx, ruleInputSchema.parse({ provinces: ["دمشق", "حلب"], fee: 3, currency: "usd" }));
    await saveRules(db, ctx, ruleInputSchema.parse({ provinces: ["دمشق"], fee: 5, freeOver: 100, isAvailable: false }));
    const r = await listRules(db, WS);
    expect(r.rules).toHaveLength(2);
    expect(r.rules.find((x) => x.province === "دمشق")).toMatchObject({ fee: 5, freeOver: 100, isAvailable: false, currency: null });
    expect(r.rules.find((x) => x.province === "حلب")).toMatchObject({ fee: 3, currency: "USD" });
  });

  it("الحاسبة بتستعمل الرسم والتوفر والحد المجاني", async () => {
    await saveRules(db, ctx, ruleInputSchema.parse({ provinces: ["دمشق"], fee: 5, freeOver: 100 }));
    await saveRules(db, ctx, ruleInputSchema.parse({ provinces: ["حلب"], fee: 4, isAvailable: false }));
    const at = (province: string, subtotal: number) => quoteDelivery(db as unknown as Db, { workspaceId: WS, province, subtotal });
    expect(await at("دمشق", 50)).toMatchObject({ available: true, fee: 5 });
    expect(await at("دمشق", 120)).toMatchObject({ available: true, fee: 0, reason: "FREE_OVER_THRESHOLD" });
    expect(await at("حلب", 50)).toMatchObject({ available: false, reason: "PROVINCE_NOT_SERVED" });
  });

  it("محافظة مجهولة = رفض واضح، والقيم السالبة والعملة الغلط ما بتعدّي", async () => {
    await expect(saveRules(db, ctx, ruleInputSchema.parse({ provinces: ["مدينة وهمية"], fee: 1 }))).rejects.toMatchObject({ statusCode: 422 });
    expect(() => ruleInputSchema.parse({ provinces: ["دمشق"], fee: -1 })).toThrow();
    expect(() => ruleInputSchema.parse({ provinces: ["دمشق"], fee: 1, currency: "DOLLAR" })).toThrow();
    expect(() => ruleInputSchema.parse({ provinces: [], fee: 1 })).toThrow();
    expect(() => ruleInputSchema.parse({ provinces: ["دمشق"], fee: 1, extra: true })).toThrow();
  });

  it("سجل تدقيق بكل حفظ وحذف", async () => {
    const [saved] = await saveRules(db, ctx, ruleInputSchema.parse({ provinces: ["دمشق"], fee: 3 }));
    await deleteRule(db, ctx, saved!.id);
    const actions = (db as unknown as { _stores: { auditLog: Array<{ action: string }> } })._stores.auditLog.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["delivery_rules.saved", "delivery_rules.deleted"]));
  });
});

describe("العزل والحذف", () => {
  it("حذف قاعدة مساحة تانية = غير موجود (بلا تسريب)", async () => {
    await db.deliveryRule.create({ data: { id: "r-other", workspaceId: "other", province: "دمشق", fee: 3, isAvailable: true } } as never);
    await expect(deleteRule(db, ctx, "r-other")).rejects.toMatchObject({ statusCode: 404 });
    expect((await listRules(db, "other")).rules).toHaveLength(1);
  });

  it("قواعد مساحة تانية ما بتظهر", async () => {
    await db.deliveryRule.create({ data: { id: "r2", workspaceId: "other", province: "حلب", fee: 3, isAvailable: true } } as never);
    expect((await listRules(db, WS)).rules).toEqual([]);
  });
});

describe("المسار والصفحة", () => {
  const src = (p: string) => readFileSync(p, "utf8");
  it("القراءة products.read والكتابة products.write مع حد سرعة", () => {
    const r = src("src/app/api/delivery-rules/route.ts");
    expect(r).toContain('permission: "products.read"');
    expect(r.match(/permission: "products.write"/g)).toHaveLength(2);
    expect(r.match(/rateLimit/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("الصفحة: تحذير أحمر + حل برتقالي، وأزرار الكتابة بـ<Can>، وبالهيكل الجديد بالمتجر", () => {
    const p = src("src/app/(dashboard)/delivery/page.tsx");
    expect(p).toContain("<Callout risk=");
    expect(p.match(/<Can permission="products.write">/g)!.length).toBeGreaterThanOrEqual(3);
    expect(src("src/lib/nav-model.ts")).toContain('{ href: "/delivery", label: "التوصيل", permission: "products.read" }');
  });
});
