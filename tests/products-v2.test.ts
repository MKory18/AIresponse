/**
 * الحزمة 3.4ب — المنتجات: «جاهز للوكيل؟» · فلتر «ناقصة المحتوى» · العدد الكلي · لما الـ OMS مربوط (حقول مقفولة) ·
 * حفظ واحد بالفرق بس · الصفحتان بالواجهة الجديدة · قيود الكود.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { findForbiddenTerms } from "@/lib/glossary";
import { INCOMPLETE_WHERE, productReadiness } from "@/modules/products/readiness";
import { listProducts } from "@/modules/products/service";
import { listParamsSchema, productUpdateSchema } from "@/modules/products/schemas";
import { STATUS_TABS, isLocked, parseStatus, readinessChip, stockChip } from "@/app/(dashboard)/products/v2/model";
import { buildPatch, isDirty, splitLines, toDraft, type ProductDetail } from "@/app/(dashboard)/products/v2/detail/model";

type Db = Prisma.TransactionClient;
const read = (p: string) => readFileSync(p, "utf8");

describe("«جاهز للوكيل؟»", () => {
  it("جاهز = وصف (قصير أو كامل) + صورة وحدة على الأقل، والناقص بيسمّي اللي ناقص", () => {
    expect(productReadiness({ description: "وصف", mediaLinks: [{}] })).toEqual({ ready: true, missing: [] });
    expect(productReadiness({ shortDescription: "قصير", mediaLinks: [{}] }).ready).toBe(true);
    expect(productReadiness({ description: "وصف", mediaLinks: [] })).toEqual({ ready: false, missing: ["image"] });
    expect(productReadiness({ description: "  ", shortDescription: null, mediaLinks: [{}] })).toEqual({ ready: false, missing: ["description"] });
    expect(productReadiness({})).toEqual({ ready: false, missing: ["description", "image"] });
  });
  it("النص: «جاهز» أخضر، والناقص برتقالي بأسماء الناقص", () => {
    expect(readinessChip({ ready: true, missing: [] })).toEqual({ text: "جاهز", tone: "success" });
    expect(readinessChip({ ready: false, missing: ["description", "image"] })).toEqual({ text: "ناقص: وصف · صورة", tone: "warning" });
  });
  it("المخزون شارة متوفر/غير متوفر (مش حالة التفعيل بتسمية المخزون)", () => {
    expect(stockChip("IN_STOCK")).toEqual({ text: "متوفر", tone: "success" });
    expect(stockChip("OUT_OF_STOCK")).toEqual({ text: "غير متوفر", tone: "danger" });
    expect(stockChip("PRE_ORDER").tone).toBe("info");
  });
});

describe("الخادم: فلتر «ناقصة المحتوى» والعدد الكلي", () => {
  const WS = "ws-prod";
  let db: ReturnType<typeof createFakeDb>;
  beforeEach(async () => {
    db = createFakeDb();
    const mk = async (sku: string, extra: Record<string, unknown>) =>
      (await db.product.create({ data: { workspaceId: WS, name: `p-${sku}`, sku, price: 10, currency: "USD", ...extra } } as never)) as { id: string };
    await mk("OK", { description: "وصف" });
    await mk("NODESC", { description: null, shortDescription: null });
    await mk("NOIMG", { description: "وصف" });
    await mk("OTHERWS", { workspaceId: "other", description: null });
    const asset = (await db.mediaAsset.create({ data: { workspaceId: WS, url: "u", type: "IMAGE", category: "PRODUCT" } } as never)) as { id: string };
    const ok = (await db.product.findFirst({ where: { sku: "OK" } } as never)) as { id: string };
    await db.productMedia.create({ data: { productId: ok.id, mediaAssetId: asset.id, isPrimary: true, sortOrder: 0 } } as never);
  });

  it("total كلي (مش حجم الصفحة)، ومعزول بالمساحة", async () => {
    const r = await listProducts(db as unknown as Db, { workspaceId: WS, status: "all", limit: 2 });
    expect(r.items).toHaveLength(2);
    expect(r.nextCursor).not.toBeNull();
    expect(r.total).toBe(3);
  });

  // قاعدة الاختبار بالذاكرة ما بتفهم فلتر العلاقات (none) — فبنفحص الشرط اللي بيوصل لبريزما بدل نتيجته.
  it("incomplete: الشرط = «ناقصة المحتوى» + غير مؤرشف، وبيتجمع مع البحث بـAND (مش OR فوق OR)", async () => {
    const seen: { findMany?: Prisma.ProductWhereInput; count?: Prisma.ProductWhereInput } = {};
    const spy = {
      product: {
        findMany: async (a: { where: Prisma.ProductWhereInput }) => ((seen.findMany = a.where), []),
        count: async (a: { where: Prisma.ProductWhereInput }) => ((seen.count = a.where), 0),
      },
    };
    await listProducts(spy as unknown as Db, { workspaceId: WS, status: "incomplete", q: "عسل" });
    expect(seen.findMany).toBe(seen.count);
    const w = seen.findMany as { workspaceId: string; isArchived: boolean; AND: Prisma.ProductWhereInput[]; OR?: unknown };
    expect(w.workspaceId).toBe(WS);
    expect(w.isArchived).toBe(false);
    expect(w.OR).toBeUndefined();
    expect(w.AND).toHaveLength(2);
    expect(w.AND[1]).toBe(INCOMPLETE_WHERE);
    expect(JSON.stringify(w.AND[0])).toContain("aliases");
  });

  it("بلا فلتر ولا بحث: بلا AND أبدًا", async () => {
    let where: Prisma.ProductWhereInput = {};
    const spy = { product: { findMany: async (a: { where: Prisma.ProductWhereInput }) => ((where = a.where), []), count: async () => 0 } };
    await listProducts(spy as unknown as Db, { workspaceId: WS });
    expect(where.AND).toBeUndefined();
  });

  it("تعريف الفلتر حرفيًا: بلا صور أو (بلا وصف كامل وبلا وصف قصير)", () => {
    expect(JSON.stringify(INCOMPLETE_WHERE)).toContain('"mediaLinks":{"none":{}}');
    expect(JSON.stringify(INCOMPLETE_WHERE)).toContain('"shortDescription":""');
  });

  it("المخطط: status=incomplete مقبول، والأسماء البديلة بتنقبل وبتنقصّ", () => {
    expect(listParamsSchema.parse({ status: "incomplete" }).status).toBe("incomplete");
    expect(() => listParamsSchema.parse({ status: "nope" })).toThrow();
    expect(productUpdateSchema.parse({ aliases: ["عسل", "Honey"] }).aliases).toEqual(["عسل", "Honey"]);
    expect(() => productUpdateSchema.parse({ aliases: Array.from({ length: 21 }, (_, i) => `a${i}`) })).toThrow();
  });
});

describe("الفلاتر والحقول المقفولة", () => {
  it("أربع فلاتر: شغّال · متوقف · مؤرشف · ناقصة المحتوى، وقيمة غريبة = شغّال", () => {
    expect(STATUS_TABS.map((t) => t.label)).toEqual(["شغّال", "متوقف", "مؤرشف", "ناقصة المحتوى"]);
    expect(parseStatus("incomplete")).toBe("incomplete");
    expect(parseStatus("zzz")).toBe("active");
    expect(parseStatus(null)).toBe("active");
  });
  it("لما الـ OMS مربوط: الاسم والرمز والسعر والمخزون مقفولة، والوصف والصور لا", () => {
    for (const f of ["name", "sku", "price", "currency", "stockStatus", "stockQty", "priceTiers"]) expect(isLocked(f, true), f).toBe(true);
    for (const f of ["description", "shortDescription", "benefits", "aliases", "tags", "isActive"]) expect(isLocked(f, true), f).toBe(false);
    expect(isLocked("price", false)).toBe(false);
  });
});

describe("حفظ واحد بالفرق بس", () => {
  const product: ProductDetail = {
    id: "p1", name: "عسل", sku: "H-1", description: "وصف", shortDescription: null, price: "10.00", compareAtPrice: null, currency: "USD",
    stockStatus: "IN_STOCK", stockQty: 5, category: null, tags: ["a"], aliases: [], benefits: ["فائدة"], ingredients: null, usage: null,
    warnings: null, objections: [], salesNotes: null, isActive: true, isArchived: false, syncedFromOms: false,
    priceTiers: [{ id: "t1", label: "جملة", price: "8.00" }], variants: [], mediaLinks: [], faqs: [], oms: { connected: false },
  };
  const base = toDraft(product);

  it("بلا تعديل = ولا حقل، وisDirty=false", () => {
    expect(buildPatch(base, base, false)).toEqual({});
    expect(isDirty(base, base, false)).toBe(false);
  });
  it("بيبعت اللي تغيّر بس بصيغة الخادم (أرقام · قوائم · null للفاضي)", () => {
    const d = { ...base, price: "12.5", description: "", aliases: "عسل\n  Honey \n\n", benefits: "فائدة\nتانية", stockQty: "7", compareAtPrice: "20", isActive: false };
    expect(buildPatch(d, base, false)).toEqual({
      price: 12.5,
      description: null,
      aliases: ["عسل", "Honey"],
      benefits: ["فائدة", "تانية"],
      stockQty: 7,
      compareAtPrice: 20,
      isActive: false,
    });
  });
  it("الأسعار الإضافية: بتنبعت كاملة لما تتغير، ويتجاهل الصف الفاضي، وما بتنبعت إذا ما تغيّرت", () => {
    expect(buildPatch(base, base, false).priceTiers).toBeUndefined();
    const d = { ...base, tiers: [...base.tiers, { label: "", price: "" }, { label: "موزّع", price: "7" }] };
    expect(buildPatch(d, base, false).priceTiers).toEqual([
      { label: "جملة", price: 8 },
      { label: "موزّع", price: 7 },
    ]);
  });
  it("لما الـ OMS مربوط: حقوله ما بتنبعت أبدًا حتى لو اتغيّرت، وحقول الوكيل بتنبعت", () => {
    const d = { ...base, name: "جديد", price: "99", stockQty: "1", tiers: [], description: "وصف جديد" };
    expect(buildPatch(d, base, true)).toEqual({ description: "وصف جديد" });
    expect(isDirty({ ...base, name: "جديد" }, base, true)).toBe(false);
  });
  it("splitLines: يقصّ ويشيل الفاضي", () => {
    expect(splitLines(" أ \n\n ب\n")).toEqual(["أ", "ب"]);
  });
});

describe("الصفحات والمسارات", () => {
  it("/products و/products/[id] بتعرض الشاشات الجديدة بس", () => {
    expect(read("src/app/(dashboard)/products/page.tsx")).toContain("<ProductsView />");
    const d = read("src/app/(dashboard)/products/[id]/page.tsx");
    expect(d).toContain("<ProductDetailView");
    expect(d).not.toContain("GlassCard");
  });
  it("القائمة: readiness + oms من الخادم، والإضافة والاستيراد بيختفوا لما الـ OMS مربوط، والكتابة بالصلاحية", () => {
    const route = read("src/app/api/products/route.ts");
    expect(route).toContain("readiness: productReadiness(p)");
    expect(route).toContain("oms: { connected: Boolean(conn?.isActive)");
    const v = read("src/app/(dashboard)/products/v2/products-view.tsx");
    expect(v).toContain("!oms.connected");
    expect(v).toContain('<Can permission="products.write"');
    expect(v).toContain("data-oms-line");
    expect(v).toContain("RowToggle");
  });
  it("الصفحة: ثلاث تبويبات، شريط حفظ واحد بالصلاحية، تحذير الخروج، والمنتج بـ oms من المسار", () => {
    const v = read("src/app/(dashboard)/products/v2/detail/product-detail-view.tsx");
    expect(v).toContain("beforeunload");
    expect(v).toContain("canWrite && tab !== \"images\"");
    expect(v).toContain("<ConfirmDialog");
    expect(v).toContain("disabled={!canWrite}");
    expect(read("src/app/api/products/[id]/route.ts")).toContain("oms: { connected: Boolean(conn?.isActive) }");
  });
});

describe("قيود الكود", () => {
  const ROOT = join(process.cwd(), "src", "app", "(dashboard)", "products", "v2");
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  it("ولا كلمة ممنوعة ولا ملف فوق 300 سطر", () => {
    expect(existsSync(ROOT)).toBe(true);
    for (const f of walk(ROOT)) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(findForbiddenTerms(code).map((x) => x.word), f).toEqual([]);
      expect(code.split("\n").length, f).toBeLessThanOrEqual(300);
    }
  });
});
