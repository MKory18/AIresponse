import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";
import { recordSalesEvent, offerShownCount, hasOfferDeclined } from "./metrics";
import {
  MAX_CROSS_SELL,
  MAX_OFFER_PRESSES,
  SALES_PLAN_VERSION,
  productOfferSchema,
  salesPlanSchema,
  type ObjectionTopic,
  type ProductOffer,
  type SalesPlan,
  type NoOfferReason,
} from "./plan-schemas";

const log = childLogger("sales-plan");

/**
 * P8 — buildSalesPlan: محرك قواعد حتمي بالكامل. كل رقم من قاعدة البيانات
 * (سعر المنتج المتزامن من OMS، عروض OMS، حالة التوفر). النموذج يستقبل
 * الخطة ليصيغ لغتها فقط — لا يقرر أبدًا سعرًا أو عرضًا أو توفيرًا.
 */

// ── عرض OMS: فك ترميز آمن ────────────────────────────────────────────────

export function parseOffers(raw: unknown, now = new Date()): ProductOffer[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductOffer[] = [];
  for (const row of raw) {
    const parsed = productOfferSchema.safeParse(row);
    if (parsed.success) {
      // العرض المنتهي يُهمل هنا (لا يُقترح أبدًا) — لكن نُبقي التمييز للاختبار.
      if (parsed.data.expiresAt && new Date(parsed.data.expiresAt).getTime() <= now.getTime()) continue;
      out.push(parsed.data);
    } else {
      log.warn({ invalid: true }, "sales_offer_row_dropped");
    }
  }
  return out;
}

/** التوفير حتمي: سعر الوحدة × كمية العرض − سعر العرض. لا يُستخدم حقل `saving` الخام إلا بعد التحقق. */
export function computeOfferSaving(unitPrice: number, offer: ProductOffer): number | null {
  const base = unitPrice * offer.quantity;
  const saving = Math.round((base - offer.price) * 100) / 100;
  // عرض بلا توفير حقيقي أو سعر فاسد لا يُقترح أبدًا.
  if (!Number.isFinite(saving) || saving <= 0) return null;
  return saving;
}

// ── توفر المنتج ──────────────────────────────────────────────────────────

export type StockLike = { stockStatus?: string | null; stockQty?: number | null };

/** التوفر وفق المصدر المعتمد فقط — لا ادعاء ندرة بلا بيانات. */
export function isProductAvailable(p: { isActive?: boolean | null; isArchived?: boolean | null; stockStatus?: string | null }): boolean {
  if (p.isActive === false || p.isArchived === true) return false;
  return p.stockStatus !== "OUT_OF_STOCK" && p.stockStatus !== "DISCONTINUED";
}

// ── تصنيف الاعتراض (حتمي — كلمات مفتاحية عربية) ──────────────────────────

const OBJECTION_KEYWORDS: Array<[ObjectionTopic, RegExp]> = [
  ["PRICE_HIGH", /غالي|مبلغ كبير|مرتفع|أرخص|ارخص|تخفيض|خصم|بكم\b|سعر مرتفع/],
  ["HESITANT", /متردد|فكر|بفكر|بعدين|مش متأكد|مو متأكد|ليش هلق/],
  ["COMPARISON", /الفرق|أفضل من|مقارنة|ليش هذا|ايهما|أيهما/],
  ["QUANTITY", /كمية|قطعة|حبة وحدة|واحدة بس|أكثر من/],
  ["WANT_DIFFERENT", /بدي غير|عندي من|أبحث|ابحث عن|نوع آخر|ماركة ثانية/],
  ["NOT_READY", /مش هلأ|مو هلأ|لسه مش|ما زلت أفكر|غير مستعد|مش جاهز/],
];

export function classifyObjection(text: string): ObjectionTopic | null {
  if (!text) return null;
  for (const [topic, re] of OBJECTION_KEYWORDS) {
    if (re.test(text)) return topic;
  }
  return null;
}

/** رفض صريح للعرض — يوقف الإلحاح نهائيًا لهذا المنتج (سياسة). */
export function isOfferDecline(text: string): boolean {
  if (!text) return false;
  return /لا شكرا|لا شكرًا|مش بدّي|مو بدّي|ما بدّي|ما بدي|مش حابب|مو حابب|بدّي هلق|ما بغيت|لا بدي/.test(text);
}

/** نية شراء — هل تستدعي المحادثة خطة بيع إطلاقًا؟ */
export function isBuyingContext(intent: string, requestedAction?: string | null): boolean {
  return (
    requestedAction === "CREATE_ORDER" ||
    ["ORDER_CREATE", "PRICE_QUESTION", "PRODUCT_QUESTION", "AVAILABILITY", "PRODUCT_COMPARISON"].includes(intent)
  );
}

// ── البناء المركزي ───────────────────────────────────────────────────────

export interface BuildSalesPlanInput {
  workspaceId: string;
  intent: string;
  requestedAction?: string | null;
  /** المنتج الأساسي (صف DB كامل — مع حقول OMS المتزامنة). */
  product?: Record<string, unknown> | null;
  /** نص العميل الموثوق (للاعتراض + رفض العرض). */
  customerText?: string | null;
  customerId?: string | null;
  conversationId?: string | null;
  /** مسودة طلب جاهزة؟ (لتثبيت الكمية في الحساب). */
  quantity?: number | null;
  /** تسجيل أحداث المقياس (يُعطَّل في المحاكاة). */
  recordEvents?: boolean;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

export async function buildSalesPlan(
  db: Db,
  input: BuildSalesPlanInput
): Promise<SalesPlan> {
  const record = input.recordEvents !== false;
  const constraints: string[] = [];
  let primary: SalesPlan["primary"] = null;
  let upsell: SalesPlan["upsell"] = null;
  let crossSell: SalesPlan["crossSell"] = [];
  let noOfferReason: NoOfferReason | null = null;

  const p = input.product;
  if (p) {
    const price = num(p.price);
    const sku = String(p.sku ?? "");
    const currency = String(p.currency ?? "USD");
    if (!sku || price === null || price <= 0) {
      noOfferReason = "PRICE_UNAVAILABLE";
    } else if (!isProductAvailable(p)) {
      noOfferReason = "PRODUCT_UNAVAILABLE";
      constraints.push("PRODUCT_UNAVAILABLE");
    } else {
      const quantity = Math.max(1, Math.min(1000, Math.floor(input.quantity ?? 1)));
      primary = {
        productId: String(p.id),
        sku,
        name: String(p.name ?? sku),
        unitPrice: price,
        currency,
        quantity,
        subtotal: Math.round(price * quantity * 100) / 100,
        stockStatus: String(p.stockStatus ?? "IN_STOCK"),
        source: p.syncedFromOms === true ? "OMS_SYNC" : "PRODUCT_DB",
      };
    }
  } else {
    noOfferReason = "NO_PRODUCT";
  }

  // ── Upsell: أكبر عرض صالح من عروض OMS المتزامنة فقط ────────────────────
  if (primary) {
    const sku = primary.sku;
    const offers = parseOffers(p!.offers, new Date());
    if (offers.length === 0) {
      noOfferReason = noOfferReason ?? "NO_VALID_OFFERS";
    } else if (input.conversationId && (await hasOfferDeclined(db, input.workspaceId, input.conversationId, sku))) {
      noOfferReason = "OFFER_DECLINED_BY_CUSTOMER";
      constraints.push("OFFER_DECLINE_RESPECTED");
    } else if (input.conversationId) {
      const shown = await offerShownCount(db, input.workspaceId, input.conversationId, sku);
      if (shown >= MAX_OFFER_PRESSES) {
        noOfferReason = "OFFER_PRESSED_OUT";
        constraints.push("OFFER_PRESS_CAP");
      }
    }
    if (!noOfferReason) {
      // أفضل عرض: أكبر توفير محسوب حتميًا (سعر العرض من البيانات).
      let best: { offer: ProductOffer; saving: number } | null = null;
      for (const offer of offers) {
        const saving = computeOfferSaving(primary.unitPrice, offer);
        if (saving === null) continue;
        if (!best || saving > best.saving) best = { offer, saving };
      }
      if (best) {
        upsell = {
          productId: primary.productId,
          sku,
          title: best.offer.title,
          quantity: best.offer.quantity,
          price: best.offer.price,
          saving: best.saving,
          currency: primary.currency,
          remainingQty: best.offer.remainingQty ?? null,
        };
        noOfferReason = null;
        if (record) {
          await recordSalesEvent(db, {
            workspaceId: input.workspaceId,
            type: "OFFER_QUALIFIED",
            conversationId: input.conversationId ?? null,
            customerId: input.customerId ?? null,
            productId: primary.productId,
            sku,
            value: best.saving,
            payload: { title: best.offer.title, quantity: best.offer.quantity, price: best.offer.price },
          });
        }
      } else {
        noOfferReason = "OFFER_NOT_WORTHWHILE";
      }
    }
  }

  // ── Cross-sell: من complementarySkus الموثوقة فقط (المصدر المعتمد) ─────
  if (primary && p!.complementarySkus && Array.isArray(p!.complementarySkus) && p!.complementarySkus.length) {
    const skus = p!.complementarySkus.map(String).filter((s) => s && s !== primary!.sku).slice(0, 10);
    if (skus.length) {
      const rows = await (db as unknown as {
        product: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> };
      }).product.findMany({
        where: { workspaceId: input.workspaceId, sku: { in: skus }, isActive: true, isArchived: false },
      });
      for (const row of rows) {
        if (crossSell.length >= MAX_CROSS_SELL) break;
        if (!isProductAvailable(row)) continue;
        const cPrice = num(row.price);
        if (cPrice === null || cPrice <= 0) continue; // بيانات ناقصة → يُهمل ولا يُخترع
        const sku = String(row.sku);
        if (crossSell.some((c) => c.sku === sku)) continue;
        crossSell.push({
          productId: String(row.id),
          sku,
          name: String(row.name ?? sku),
          unitPrice: cPrice,
          currency: String(row.currency ?? "USD"),
          source: row.syncedFromOms === true ? "OMS_SYNC" : "PRODUCT_DB",
        });
      }
      if (record && crossSell.length) {
        for (const c of crossSell) {
          await recordSalesEvent(db, {
            workspaceId: input.workspaceId,
            type: "CROSS_SELL_SHOWN",
            conversationId: input.conversationId ?? null,
            customerId: input.customerId ?? null,
            productId: c.productId,
            sku: c.sku,
            value: c.unitPrice,
            payload: {},
          }).catch(() => {});
        }
      }
    }
  }

  // ── الاعتراض: تصنيف حتمي + توفر رد موثوق من بيانات المنتج المحلية ──────
  const text = input.customerText ?? "";
  const topic = classifyObjection(text);
  let objection: SalesPlan["objection"] = null;
  if (topic) {
    const localAnswers = Array.isArray(p?.objections) ? (p!.objections as string[]).filter((s) => typeof s === "string" && s.trim().length > 3) : [];
    objection = { topic, trustedAnswerAvailable: localAnswers.length > 0 };
  }

  const plan: SalesPlan = {
    version: SALES_PLAN_VERSION,
    intent: input.intent,
    primary,
    upsell,
    crossSell,
    objection,
    discount: null, // يُملأ فقط عبر مسار الموظف/الموافقات — ليس للذكاء
    noOfferReason: noOfferReason ?? (primary ? null : "NO_PRODUCT"),
    constraints,
    internalOnly: false,
  };
  return salesPlanSchema.parse(plan);
}

/** نص الجملة المعتمد للاعتراضات بلا رد موثوق — صياغة آمنة بلا اختراع. */
export function safeObjectionFallback(topic: ObjectionTopic): string {
  switch (topic) {
    case "PRICE_HIGH":
      return "أفهم وجهة نظرك؛ الأسعار لدينا رسمية وثابتة، ويمكنني شرح الفوائد التي تحصل عليها مقابل هذا السعر.";
    case "HESITANT":
      return "خذ وقتك — يمكنني توضيح أي تفاصيل تساعدك في القرار.";
    default:
      return "يسعدني توضيح أي تفاصيل إضافية تحتاجها.";
  }
}
