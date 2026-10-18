import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import ExcelJS from "exceljs";
import type { AIProvider, TextRequest, StructuredRequest } from "@/modules/ai/provider";
import { importProductsFromSheet, readSheet } from "@/modules/products/import-service";

/**
 * استيراد منتجات من اكسل: تحليل أعمدة بالذكاء (واحتياطه الحتمي) + إدراج
 * تلقائي بنفس مسار المنتج اليدوي، وأسعار إضافية (سعر الجملة …) لكل منتج.
 */
const WS = "ws-excel-import";
const ctx = { userId: "agent-imp", workspaceId: WS };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
const stores = () => (db as unknown as { _stores: Record<string, unknown[]> })._stores;

/** مزوّد وهمي: خريطة أعمدة جاهزة بدون أي شبكة. */
function fakeProvider(mapping: Record<string, unknown>): AIProvider {
  return {
    name: "fake",
    delivery: "local",
    async generateText(_req: TextRequest) {
      return { text: "?", promptTokens: 1, completionTokens: 1, latencyMs: 1 };
    },
    async generateStructured<T>(req: StructuredRequest<T>) {
      const raw = { mapping, extraPriceColumns: (mapping as { extraPriceColumns?: unknown }).extraPriceColumns ?? [] };
      const v = req.validate(raw);
      if (!v.ok) throw new Error(v.error);
      return { text: JSON.stringify(raw), promptTokens: 1, completionTokens: 1, latencyMs: 1, value: v.value };
    },
  } as AIProvider;
}

/** مزوّد فاشل — يثبت أن الميزة ما بتتوقف بلا ذكاء. */
function failingProvider(): AIProvider {
  return {
    name: "failing",
    delivery: "local",
    async generateText() { throw new Error("down"); },
    async generateStructured() { throw new Error("down"); },
  } as AIProvider;
}

async function workbookBuffer(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("منتجات");
  for (const r of rows) ws.addRow(r);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

beforeEach(() => {
  db = createFakeDb();
  stores().workspaceMember.push({ id: "m1", workspaceId: WS, userId: ctx.userId, status: "ACTIVE" });
});

describe("readSheet — محلل xlsx/csv مشترك", () => {
  it("يقرأ عناوين وصفوف من ملف xlsx حقيقي ويتجاهل الصفوف الفاضية", async () => {
    const buf = await workbookBuffer([
      ["اسم", "سعر", "سعر الجملة"],
      ["عسل صافي", "12.50", "10"],
      [],
      ["زيت زيتون", "9", "7.5"],
    ]);
    const t = await readSheet({ buffer: buf, filename: "منتجات.xlsx" });
    expect(t.headers).toEqual(["اسم", "سعر", "سعر الجملة"]);
    expect(t.rows.map((r) => r["اسم"])).toEqual(["عسل صافي", "زيت زيتون"]);
    // كل صف يبقى فيه كامل الأعمدة حتى الخلي الفاضية (منظم — ما فيه انزياح).
    expect(Object.keys(t.rows[0])).toEqual(t.headers);
  });

  it("يرفض xls القديمة برسالة صريحة — ما في فشل صامت", async () => {
    await expect(readSheet({ buffer: Buffer.from("x"), filename: "a.xls" })).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
  });
});

describe("importProductsFromSheet — إدراج تلقائي", () => {
  it("خريطة الذكاء تحدد الأعمدة، والسعر الإضافي ينحفظ كـ priceTiers، وSKU يتولد تلقائيًا", async () => {
    const provider = fakeProvider({
      name: "اسم",
      price: "سعر",
      extraPriceColumns: ["سعر الجملة"],
      category: "تصنيف",
      currency: "العملة",
    });
    const buf = await workbookBuffer([
      ["اسم", "سعر", "سعر الجملة", "تصنيف", "العملة"],
      ["عسل صافي", "12.50", "10", "غذاء", "USD"],
      ["زيت زيتون", "", "7.5", "", ""], // بلا سعر → يتخطى
    ]);
    const s = await importProductsFromSheet(db, ctx, { buffer: buf, filename: "قائمة.xlsx" }, { provider });
    expect(s.created).toHaveLength(1);
    const p = stores().product[0] as Record<string, unknown>;
    expect(p.name).toBe("عسل صافي");
    expect(String(p.price)).toBe("12.5");
    expect(p.category).toBe("غذاء");
    expect(String(s.created[0].sku)).toMatch(/^IMP-2$/); // رقم الصف بالملف
    expect(stores().productPrice).toHaveLength(1);
    expect(stores().productPrice[0]).toMatchObject({ productId: p.id, label: "سعر الجملة", price: "10" });
    expect(s.skipped).toEqual([{ row: 3, reason: "الصف ما فيه سعر رقمي" }]);
    expect(s.usedAI).toBe(true);
    expect(s.mapping.price).toBe("سعر");
  });

  it("فشل الذكاء = التحليل الحتمي يشتغل فورًا (الميزة ما بتتوقف)", async () => {
    const buf = await workbookBuffer([
      ["اسم المنتج", "سعر", "سعر الجملة", "الكمية"],
      ["شامبو عسلي", "5.25", "4", "20"],
      ["كريم الصبار", "3", "2.5", ""],
    ]);
    const s = await importProductsFromSheet(db, ctx, { buffer: buf, filename: "منتجات.xlsx" }, { provider: failingProvider() });
    expect(s.usedAI).toBe(false);
    expect(s.aiError).toBeTruthy();
    expect(stores().product).toHaveLength(2);
    expect(stores().product[0].price.toString()).toBe("5.25");
    expect(stores().product.map((p: Record<string, unknown>) => p.name).join()).toContain("شامبو عسلي");
    const tiers = stores().productPrice as Array<Record<string, unknown>>;
    expect(tiers.map((t) => t.label)).toEqual(["سعر الجملة", "سعر الجملة"]);
  });

  it("أرقام عربية ونصوص مخلوطة («١٥٠» · «JD 12.5») تحلل للأعلى رقميًا", async () => {
    const buf = await workbookBuffer([
      ["المنتج", "السعر"],
      ["قاملة", "١٥٠"],
      ["عقار صابون", "JD 12.5"],
    ]);
    await importProductsFromSheet(db, ctx, { buffer: buf, filename: "b.xlsx" }, { provider: failingProvider() });
    expect(stores().product.map((p: Record<string, unknown>) => p.price.toString()).sort()).toEqual(["12.5", "150"]);
  });

  it("استيراد الملف نفسه مرتين = منتجان وSKU مختلف تلقائيًا (بلا تعارض)", async () => {
    const buf = await workbookBuffer([
      ["المنتج", "السعر"],
      ["عنبر عربي", "30"],
    ]);
    await importProductsFromSheet(db, ctx, { buffer: buf, filename: "a.xlsx" }, { provider: null });
    const second = await importProductsFromSheet(db, ctx, { buffer: buf, filename: "a.xlsx" }, { provider: null });
    expect(stores().product).toHaveLength(2);
    expect(second.created[0].sku).not.toBe((stores().product[0] as Record<string, unknown>).sku);
  });
});

