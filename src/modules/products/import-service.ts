/**
 * استيراد المنتجات من ملف اكسل — تحليل الأعمدة بالذكاء ثم إدراج تلقائي.
 *
 * القاعدة: الذكاء يحلل «شكل» الجدول (أي عمود اسم · أي عمود سعر) ويرجّع
 * خريطة أعمدة فقط — والسجلات نفسها تُحوَّل وتُدخل بكود حتمي محلي. فشل
 * الذكاء (بلا مفاتيح · خطأ شبكة · رد سيئ) ما يوقف الميزة: خريطة تقريبية
 * جاهزة (مترادفات عربي/إنجليزي) تشتغل حالًا بنفس المخرجات.
 *
 * الإدراج بنفس الدالة اليدوية `createProduct` — بلا مسار إنشاء موازٍ:
 * نفس التدقيق · نفس الحدث ProductCreated · نفس سَبْل كتالوج/قنوات.
 */
import { createProduct, parsePriceAmount, type ProductPriceTierInput } from "./service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { AppError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import { AIProviderError, type AIProvider } from "@/modules/ai/provider";
import { validateStructured } from "@/modules/ai/structured";
import { z } from "zod";
import ExcelJS from "exceljs";

const log = childLogger("products.import");

/** حدود صريحة: ملف صغير يعالج مباشرة — ما في جدولة وظائف بالخلفية هون. */
export const IMPORT_MAX_ROWS = 300;
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_TIERS = 8;

// ── 1) قراءة الجدول (xlsx · csv) ────────────────────────────────────────────

type Row = Record<string, unknown>;

export interface SheetTable {
  headers: string[];
  rows: Row[];
  totalRows: number;
}

function normalizeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") return String((v as { text?: unknown }).text ?? ""); // RichText/Formula
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  return v;
}

function readCsv(buffer: Buffer): string[][] {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const out: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = ""; out.push(row); row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.length > 1 || (row[0] ?? "") !== "") out.push(row);
  return out;
}

function tableFromMatrix(matrix: string[][]): SheetTable {
  let headerIdx = matrix.findIndex((r) => r.some((c) => c.trim() !== ""));
  if (headerIdx < 0) return { headers: [], rows: [], totalRows: 0 };
  const rawHeaders = matrix[headerIdx];
  const headers: string[] = [];
  const used = new Set<string>();
  rawHeaders.forEach((h, i) => {
    let name = h.trim() || `Column${i + 1}`;
    while (used.has(name)) name = `${name}·`;
    used.add(name);
    headers.push(name);
  });
  const rows: Row[] = [];
  for (const cells of matrix.slice(headerIdx + 1)) {
    if (!cells.some((c) => c.trim() !== "")) continue; // شرطة فاصلة/صف فارغ ما بيتحسب
    const row: Row = {};
    headers.forEach((h, i) => { row[h] = normalizeCell(cells[i]); });
    rows.push(row);
  }
  return { headers, rows, totalRows: rows.length };
}

/** xlsx (exceljs) · csv — أنواع تانية برسالة صريحة بدل فشل صامت. */
export async function readSheet(file: { buffer: Buffer; filename: string }): Promise<SheetTable> {
  const name = file.filename.toLowerCase();
  if (name.endsWith(".csv")) return tableFromMatrix(readCsv(file.buffer));
  if (name.endsWith(".xls")) {
    throw new AppError("صيغة xls القديمة ما بتتدعم — احفظ الملف بصيغة xlsx أو csv وحاول مرة ثانية", 422, "UNSUPPORTED_FILE_TYPE");
  }
  if (!name.endsWith(".xlsx")) {
    throw new AppError("الملف لازم اكسل (.xlsx) أو CSV (.csv)", 422, "UNSUPPORTED_FILE_TYPE");
  }
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    if (!ws) return { headers: [], rows: [], totalRows: 0 };
    const matrix: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(String(normalizeCell(cell.value) ?? "")));
      matrix.push(cells);
    });
    return tableFromMatrix(matrix);
  } catch {
    throw new AppError("تعذر قراءة ملف الاكسل — تأكد إنه ملف xlsx سليم ومحفوظ تزهو", 422, "WORKBOOK_CORRUPT");
  }
}

// ── 2) تحليل الأعمدة: خريطة بالذكاء (اختياري) · تقريب حتمي (احتياطي) ─────────

const TARGET_FIELDS = [
  "name", "sku", "price", "compareAtPrice", "currency",
  "category", "shortDescription", "description", "stockQty", "stockStatus",
] as const;
type TargetField = (typeof TARGET_FIELDS)[number];

const columnMapSchema = z.object({
  mapping: z.object(
    Object.fromEntries(TARGET_FIELDS.map((f) => [f, z.string().max(120).nullish()]))
  ),
  extraPriceColumns: z.array(z.string().max(120)).max(IMPORT_MAX_TIERS).default([]),
});
type ColumnMap = z.infer<typeof columnMapSchema>;

/** مترادفات جاهزة — مسار الذكاء يوسّعها، وهون النسخة الاحتياطية. */
const SYNONYMS: Record<TargetField, string[]> = {
  name: ["اسم", "المنتج", "منتج", "اسم المنتج", "الصنف", "سلسلة", "name", "product", "title", "product name"],
  sku: ["sku", "code", "كود", "الكود", "رمز", "باركود", "barcode"],
  price: ["price", "سعر", "السعر", "سعر البيع", "سعر القطعة", "unit price", "retail"],
  compareAtPrice: ["compare at price", "old price", "السعر قبل", "قبل الخصم", "السعر القديم", "قديم"],
  currency: ["currency", "عملة", "العملة"],
  category: ["category", "تصنيف", "التصنيف", "فئة", "الفئة", "صنف", "النوع", "type"],
  shortDescription: ["short description", "وصف قصير", "وصف", "الوصف", "شرح", "description"],
  description: ["description", "وصف كامل", "التفاصيل", "details", "الوصف الكامل"],
  stockQty: ["qty", "stock", "كمية", "الكمية", "مخزون", "المخزون", "quantity"],
  stockStatus: ["stock status", "حالة", "الحالة", "متوفر", "availability", "الحالة المخزنية"],
};

/** أول عمود متشابه بسعر = السعر الأساسي؛ كل عمود سعر ثاني = سعر إضافي (تسميته = عنوان العمود). */
function heuristicMapping(headers: string[]): ColumnMap {
  const norm = (h: string) => h.toLowerCase().replace(/\s+/g, " ").trim();
  const mapping: Partial<Record<TargetField, string>> = {};
  const extraPriceColumns: string[] = [];
  const consumed = new Set<string>();
  const priceSyn = ["price", "سعر", "السعر", "جملة", "wholesale", "موزع", "خاص"];
  const priceLike = headers.filter((h) => priceSyn.some((s) => norm(h).includes(s)));

  for (const field of TARGET_FIELDS) {
    const syn = SYNONYMS[field].map(norm);
    const hit =
      headers.find((h) => !consumed.has(h) && syn.includes(norm(h))) ??
      headers.find((h) => !consumed.has(h) && syn.some((s) => norm(h).includes(s)));
    if (hit) { mapping[field] = hit; consumed.add(hit); }
  }

  // عمود السعر الأساسي = أول عمود شبيه بسعر (بعد ما الأعمدة الأوضع مثل compareAtPrice تُحزم).
  if (!mapping.price && priceLike.length > 0) {
    mapping.price = priceLike.find((h) => !consumed.has(h)) ?? priceLike[0];
    consumed.add(mapping.price);
  }
  const main = mapping.price;
  for (const h of priceLike) {
    if (consumed.has(h) || h === main || h === mapping.compareAtPrice) continue;
    extraPriceColumns.push(h);
    consumed.add(h);
  }
  return columnMapSchema.parse({ mapping, extraPriceColumns: extraPriceColumns.slice(0, IMPORT_MAX_TIERS) });
}

/** نداء واحد للذكاء: العناوين + عينة صفوف → خريطة. رد سيئ = فشل مؤقت. */
async function analyzeWithAI(provider: AIProvider, headers: string[], samples: Row[]): Promise<ColumnMap> {
  const fields = TARGET_FIELDS.join(", ");
  const system = [
    "أنت محلل جداول منتجات. تحصل على عناوين أعمدة من ملف اكسل (بالعربية أو الإنجليزية) وعينة صفوف.",
    'ترجّع JSON واحد فقط: {"mapping": حقل→اسم العمود, "extraPriceColumns": [...]}',
    `الحقول المتاحة فقط: ${fields}.`,
    "القواعد:",
    "- mapping: كل حقل يوافق اسم عمود واحد فقط من العناوين، أو null إذا ما في عمود مناسب.",
    "- name و price لازم يتعرّفوا إذا موجودين بالجدول.",
    '- extraPriceColumns: أعمدة أسعار إضافية (مثل "سعر الجملة" أو "سعر الموزع" أو "عرض خاص") — أسماؤها حرفيًا من العناوين، ولا تشمل عمود السعر الأساسي.',
    "- لا تخترع عمود غير موجود. لا شرح. JSON فقط.",
  ].join("\n");
  const user = JSON.stringify({ headers, samples });
  const res = await provider.generateStructured({
    system,
    user,
    temperature: 0,
    maxTokens: 500,
    validate: (raw) => validateStructured(columnMapSchema, raw),
  });
  return columnMapSchema.parse(res.value);
}

// ── 3) تحويل + إدراج (نفس مسار المنتج اليدوي) ──────────────────────────────

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const toAsciiDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));

const STOCK_MAP: { re: RegExp; status: "IN_STOCK" | "OUT_OF_STOCK" | "PRE_ORDER" | "DISCONTINUED" }[] = [
  { re: /غير\s*متوف|نفذ|منتهي|out\s*of\s*stock|unavailable|sold\s*out/i, status: "OUT_OF_STOCK" },
  { re: /طلب\s*مسبق|pre\s*order/i, status: "PRE_ORDER" },
  { re: /متوقف|توقف|منسوخ|موقوف|discontinued/i, status: "DISCONTINUED" },
  { re: /متوف|موجود|نعم|in\s*stock|available|yes|true|\b1\b/i, status: "IN_STOCK" },
];

function stockStatusOf(v: unknown): "IN_STOCK" | "OUT_OF_STOCK" | "PRE_ORDER" | "DISCONTINUED" | null {
  if (v === null || v === undefined) return null;
  const s = toAsciiDigits(String(v));
  if (s.trim() === "") return null;
  for (const m of STOCK_MAP) if (m.re.test(s)) return m.status;
  return null;
}

export interface ImportSummaryProduct {
  id: string;
  name: string;
  sku: string;
  price: string;
  priceTiers: ProductPriceTierInput[];
}

export interface ImportSummary {
  usedAI: boolean;
  aiError: string | null;
  mapping: Record<string, string | null>;
  extraPriceColumns: string[];
  created: ImportSummaryProduct[];
  /** صفوف ما انعملت + السبب نصيًا — يعود بوضوح للمالك. */
  skipped: { row: number; reason: string }[];
}

/** SKU حتمي غير متعارض داخل المساحة: IMP-<row#> ثم ملحقات تصادم نادرة. */
async function nextSku(db: Db, workspaceId: string, rowNo: number): Promise<string> {  const base = `IMP-${rowNo}`;
  for (const c of [base, `${base}-${Math.random().toString(36).slice(2, 5)}`]) {
    const clash = await db.product.findFirst({ where: { workspaceId, sku: c }, select: { id: true } });
    if (!clash) return c;
  }
  for (let i = 0; i < 20; i++) {
    const c = `IMP-${Math.random().toString(36).slice(2, 10)}`;
    const clash = await db.product.findFirst({ where: { workspaceId, sku: c }, select: { id: true } });
    if (!clash) return c;
  }
  throw new AppError("تعذر توليد كود (SKU) غير متعارض", 500, "SKU_GENERATION_FAILED");
}

export async function importProductsFromSheet(
  db: Db,
  ctx: ActorContext,
  file: { buffer: Buffer; filename: string },
  opts: { provider: AIProvider | null; currency?: string }
): Promise<ImportSummary> {
  const table = await readSheet(file);
  if (table.headers.length === 0) {
    throw new AppError("الملف فاضي — لازم صف عناوين أعمدة وصفوف منتجات تحت", 422, "EMPTY_SHEET");
  }

  // خريطة الأعمدة: الذكاء أولًا، وفشله = التقريب الحتمي فورًا (نفس النتيجة شكلًا).
  let mapping = heuristicMapping(table.headers);
  let usedAI = false;
  let aiError: string | null = null;
  if (opts.provider) {
    try {
      mapping = await analyzeWithAI(opts.provider, table.headers, table.rows.slice(0, 3));
      // تحقق صحي بسيط: خريطة ذكاء فعّالة لازم تحدّد اسم وسعر متل التقريب.
      if (mapping.mapping.name && mapping.mapping.price) usedAI = true;
      else {
        aiError = "رد الذكاء ما حدّد الأعمدة المطلوبة — استعملنا التحليل التلقائي";
        mapping = heuristicMapping(table.headers);
      }
    } catch (e) {
      aiError = e instanceof AppError || e instanceof AIProviderError ? e.message : "فشل اتصال الذكاء — استعملنا التحليل التلقائي";
      log.warn({ err: (e as Error)?.message }, "import_ai_mapping_failed");
      mapping = heuristicMapping(table.headers);
    }
  }

  const created: ImportSummaryProduct[] = [];
  const skipped: { row: number; reason: string }[] = [];
  const rows = table.rows.slice(0, IMPORT_MAX_ROWS);
  if (table.rows.length > IMPORT_MAX_ROWS) {
    skipped.push({ row: IMPORT_MAX_ROWS + 2, reason: `تم تجاوز الحد (${IMPORT_MAX_ROWS} صف كحد أقصى بالاستيراد الواحد) — الخاصية المتبقية (بقي ${table.rows.length - IMPORT_MAX_ROWS} صف) ما انعملت` });
  }

  for (let i = 0; i < rows.length; i++) {
    const rowNo = i + 2; // 1 = صف العناوين بالملف
    const r = rows[i];
    try {
      const name = String(r[mapping.mapping.name ?? ""] ?? "").trim().slice(0, 200);
      if (!name) { skipped.push({ row: rowNo, reason: "الصف ما فيه اسم منتج" }); continue; }

      const price = mapping.mapping.price ? parsePriceAmount(r[mapping.mapping.price]) : null;
      if (price === null) { skipped.push({ row: rowNo, reason: "الصف ما فيه سعر رقمي" }); continue; }

      const compareAtPrice = mapping.mapping.compareAtPrice ? parsePriceAmount(r[mapping.mapping.compareAtPrice]) : null;

      const currencyRaw = mapping.mapping.currency ? String(r[mapping.mapping.currency] ?? "").trim() : "";
      const currency = (currencyRaw.match(/[A-Za-z]{3}/)?.[0] ?? opts.currency ?? "USD").toUpperCase();

      const stockQtyRaw = mapping.mapping.stockQty ? String(r[mapping.mapping.stockQty] ?? "") : "";
      const qtyDigits = toAsciiDigits(stockQtyRaw).match(/\d+/);
      const stockQty = qtyDigits ? Math.min(Number(qtyDigits[0]), 1_000_000) : null;

      const stockStatus = mapping.mapping.stockStatus ? stockStatusOf(r[mapping.mapping.stockStatus]) : null;

      // أسعار إضافية (جملة · موزع · عرض …): تسميتها حرفيًا من عنوان العمود.
      const priceTiers: ProductPriceTierInput[] = [];
      for (const col of mapping.extraPriceColumns) {
        if (col === mapping.mapping.price || col === mapping.mapping.compareAtPrice) continue;
        const amount = parsePriceAmount(r[col]);
        if (amount !== null) priceTiers.push({ label: col.slice(0, 60), price: amount });
      }

      const skuRaw = mapping.mapping.sku ? String(r[mapping.mapping.sku] ?? "").trim() : "";
      const sku = skuRaw && skuRaw.length <= 64
        ? skuRaw
        : await nextSku(db, ctx.workspaceId, rowNo);

      const product = await createProduct(db, ctx, {
        name,
        sku,
        price,
        compareAtPrice,
        currency,
        stockStatus: stockStatus ?? "IN_STOCK",
        stockQty: stockQty ?? undefined,
        category: mapping.mapping.category ? (String(r[mapping.mapping.category] ?? "").trim().slice(0, 100) || null) : null,
        shortDescription: mapping.mapping.shortDescription
          ? (String(r[mapping.mapping.shortDescription] ?? "").trim().slice(0, 500) || null)
          : null,
        description: mapping.mapping.description
          ? (String(r[mapping.mapping.description] ?? "").trim().slice(0, 10000) || null)
          : null,
        priceTiers,
      });
      created.push({
        id: product.id,
        name: product.name,
        sku: product.sku,
        price: String(product.price),
        priceTiers,
      });
    } catch (e) {
      const reason = e instanceof AppError ? e.message : "خطأ غير متوقع بالصف";
      log.warn({ row: rowNo, err: (e as Error)?.message }, "import_row_failed");
      skipped.push({ row: rowNo, reason });
    }
  }

  return {
    usedAI,
    aiError,
    mapping: Object.fromEntries(TARGET_FIELDS.map((f) => [f, mapping.mapping[f] ?? null])),
    extraPriceColumns: mapping.extraPriceColumns,
    created,
    skipped,
  };
}
