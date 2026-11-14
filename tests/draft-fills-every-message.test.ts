/**
 * المسودة تتعبّى من كل رسالة فيها معلومة طلب.
 *
 * ⚠️ النظام كان يستخرج المنتج والكمية والرقم والعنوان من كل رسالة، وبعدين
 * **يرميهم** إلا إذا الموديل سمّى الرسالة «طلب» (`ORDER_CREATE`/`ORDER_UPDATE`).
 * بمحادثة حقيقية (٢٠٢٦-١١-١٤) انعبّت المسودة مرة وحدة بس، وكل اللي بعدها —
 * الكمية والرقم والعنوان — انحكى بالرد وما انكتب بالمسودة. فلا طلب انسجّل،
 * ولا شي وصل الـ OMS، والبوت قال «ثبّتنا الطلب».
 * 🔧 ثلاث قواعد: المسودة تتعبّى من كل رسالة فيها بيانات طلب · «اي» لحالها
 * تأكيد · وما نقول «ثبّتنا» بلا رقم طلب.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeDb } from "./helpers/inmemory-db";
import { handleOrderIntent, hasOrderData } from "@/modules/orders/intelligence";
import { parseConfirmation } from "@/modules/orders/primitives";
import { redactSummaryContacts } from "@/modules/orders/draft-service";
import { validateResponse } from "@/modules/ai/guardrails";
import { createProduct } from "@/modules/products/service";

const WS = "ws-draft";
const AGENT = { userId: "agent-1", workspaceId: WS };
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let productId: string;
let conversationId: string;
let customerId: string;

const EMPTY = { confidence: 0.9, language: "ar", missingFields: [], memories: [] } as const;

async function seed() {
  db = createFakeDb();
  const product = await createProduct(db as Db, AGENT, {
    name: "ماء الكمأ",
    sku: "TW-500",
    price: 15,
    currency: "USD",
  });
  productId = product.id;
  const customer = await db.customer.create({
    data: { workspaceId: WS, name: "أحمد", phone: null, status: "INTERESTED" },
  } as never);
  customerId = customer.id;
  const conv = await db.conversation.create({
    data: { workspaceId: WS, customerId, channelId: "ch-1", channelConversationId: "fb-1" },
  } as never);
  conversationId = conv.id;
}

async function openDraft() {
  const rows = (await db.orderDraft.findMany({ where: { conversationId } })) as Array<{
    state: string;
    productId: string | null;
    quantity: number | null;
    phone: string | null;
    rawAddress: string | null;
    sequence?: number;
  }>;
  return rows
    .filter((d) => d.state !== "CONVERTED" && d.state !== "CANCELLED")
    .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0];
}

beforeEach(seed);

describe("بيانات الطلب بأي رسالة", () => {
  it("كمية بلا منتج مع مسودة مفتوحة = بيانات طلب", () => {
    expect(hasOrderData({ intent: "PRICE_QUESTION", entities: { quantity: 2 }, ...EMPTY })).toBe(true);
  });

  it("رقم أو عنوان = بيانات طلب", () => {
    expect(hasOrderData({ intent: "PRICE_QUESTION", entities: { phone: "0790000000" }, ...EMPTY })).toBe(true);
    expect(hasOrderData({ intent: "GREETING", entities: { address: "شارع نيلسون" }, ...EMPTY })).toBe(true);
  });

  it("سؤال سعر بلا أي بيانات ما بيفتح طلب", () => {
    expect(hasOrderData({ intent: "PRICE_QUESTION", entities: { product: "ماء الكمأ" }, ...EMPTY })).toBe(false);
    expect(hasOrderData({ intent: "GREETING", entities: {}, ...EMPTY })).toBe(false);
  });
});

describe("المسودة بتكمل مهما كان تصنيف الرسالة", () => {
  async function startDraft() {
    const res = await handleOrderIntent(db as Db, {
      workspaceId: WS,
      conversationId,
      customerId,
      extraction: { intent: "ORDER_CREATE", entities: { product: "ماء الكمأ" }, requestedAction: "CREATE_ORDER", ...EMPTY },
      customerText: "بدي اطلب",
    });
    expect(res.handled).toBe(true);
    return res;
  }

  it("كمية برسالة مصنّفة سؤال بتنكتب بالمسودة", async () => {
    await startDraft();
    await handleOrderIntent(db as Db, {
      workspaceId: WS,
      conversationId,
      customerId,
      extraction: { intent: "PRICE_QUESTION", entities: { quantity: 2 }, requestedAction: "NONE", ...EMPTY },
      customerText: "بدي وحدتين",
    });
    expect((await openDraft()).quantity).toBe(2);
  });

  it("الرقم والعنوان برسالة مصنّفة سؤال بينكتبوا بالمسودة", async () => {
    await startDraft();
    const res = await handleOrderIntent(db as Db, {
      workspaceId: WS,
      conversationId,
      customerId,
      extraction: {
        intent: "PRODUCT_QUESTION",
        entities: { quantity: 1, phone: "0790000000", address: "شارع نيلسون", province: "عمان", customer_name: "أحمد" },
        requestedAction: "NONE",
        ...EMPTY,
      },
      customerText: "أحمد ٠٧٩٠٠٠٠٠٠٠ شارع نيلسون",
    });
    const draft = await openDraft();
    expect(draft.phone).toContain("790000000");
    expect(draft.rawAddress).toBe("شارع نيلسون");
    expect(draft.productId).toBe(productId);
    expect(res.action).toBe("REQUEST_CONFIRMATION");
  });

  it("بيانات الطلب بتوصل المسودة حتى لو ما في مسودة مفتوحة قبلها", async () => {
    await handleOrderIntent(db as Db, {
      workspaceId: WS,
      conversationId,
      customerId,
      extraction: {
        intent: "PRICE_QUESTION",
        entities: { product: "ماء الكمأ", quantity: 1, phone: "0790000000", address: "شارع نيلسون" },
        requestedAction: "NONE",
        ...EMPTY,
      },
      customerText: "بكم ماء الكما؟ رقمي ٠٧٩٠٠٠٠٠٠٠ وعنواني شارع نيلسون",
    });
    const draft = await openDraft();
    expect(draft).toBeTruthy();
    expect(draft.productId).toBe(productId);
  });

  it("رسالة بلا أي بيانات طلب ما بتفتح مسودة", async () => {
    const res = await handleOrderIntent(db as Db, {
      workspaceId: WS,
      conversationId,
      customerId,
      extraction: { intent: "GREETING", entities: {}, requestedAction: "NONE", ...EMPTY },
      customerText: "مرحبا",
    });
    expect(res.handled).toBe(false);
    expect(await openDraft()).toBeUndefined();
  });

  it("الطلب بيتأكد بـ«اي» بعد ما تكتمل المسودة من رسائل مصنّفة أسئلة", async () => {
    await startDraft();
    await handleOrderIntent(db as Db, {
      workspaceId: WS,
      conversationId,
      customerId,
      extraction: {
        intent: "PRODUCT_QUESTION",
        entities: { quantity: 1, phone: "0790000000", address: "شارع نيلسون", province: "عمان", customer_name: "أحمد" },
        requestedAction: "NONE",
        ...EMPTY,
      },
      customerText: "أحمد ٠٧٩٠٠٠٠٠٠٠ شارع نيلسون",
    });
    const confirmed = await handleOrderIntent(db as Db, {
      workspaceId: WS,
      conversationId,
      customerId,
      extraction: { intent: "UNKNOWN", entities: {}, requestedAction: "NONE", ...EMPTY },
      customerText: "اي",
    });
    expect(confirmed.action).toBe("ORDER_CONFIRMED");
    expect(confirmed.orderNumber).toBeTruthy();
  });
});

describe("«اي» لحالها تأكيد", () => {
  it("«اي» و«أي» لحالهم = موافقة", () => {
    expect(parseConfirmation("اي").signal).toBe("YES");
    expect(parseConfirmation("أي").signal).toBe("YES");
    expect(parseConfirmation("اي ").signal).toBe("YES");
  });

  it("«أي» جوّا سؤال بتضل «which» مش موافقة", () => {
    expect(parseConfirmation("أي لون عندكم؟").signal).toBe("UNKNOWN");
    expect(parseConfirmation("اي واحد").signal).toBe("UNKNOWN");
  });
});

describe("ما نقول «ثبّتنا الطلب» بلا رقم طلب", () => {
  it("ادعاء التثبيت بلا طلب = رفض", () => {
    const res = validateResponse({ response: "تمام، ثبّتنا الطلب ✅", orderPlaced: false });
    expect(res.valid).toBe(false);
    expect(res.violations).toContain("UNCONFIRMED_ORDER_CLAIM");
  });

  it("صيغ تانية للادعاء كمان مرفوضة", () => {
    for (const text of ["تم تأكيد طلبك", "سجّلنا طلبك", "تم تسجيل الطلب", "أكدنا الطلب"]) {
      expect(validateResponse({ response: text, orderPlaced: false }).violations).toContain("UNCONFIRMED_ORDER_CLAIM");
    }
  });

  it("مع طلب فعلي الادعاء مسموح", () => {
    expect(validateResponse({ response: "تم تأكيد طلبك ✅", orderPlaced: true }).valid).toBe(true);
  });

  it("بلا القاعدة السلوك القديم ما بيتغيّر", () => {
    expect(validateResponse({ response: "تم تأكيد طلبك ✅" }).valid).toBe(true);
  });

  it("سؤال عن الناقص مسموح وهي بتجمع", () => {
    expect(validateResponse({ response: "بعتلي عنوانك لأثبّت الطلب 🌹", orderPlaced: false }).valid).toBe(true);
  });
});

describe("رقم الزبون وعنوانه ما بيوصلوا الموديل", () => {
  it("ملخص المسودة بينشال منه الرقم والعنوان قبل الموديل", () => {
    const summary = "المنتج: ماء الكمأ\nالكمية: 1\nالهاتف: 0790000000\nالعنوان: عمان - شارع نيلسون\nينقص: لا شي";
    const out = redactSummaryContacts(summary);
    expect(out).not.toContain("0790000000");
    expect(out).not.toContain("شارع نيلسون");
    expect(out).toContain("الهاتف: محفوظ");
    expect(out).toContain("العنوان: محفوظ");
    expect(out).toContain("المنتج: ماء الكمأ");
    expect(out).toContain("الكمية: 1");
  });

  it("مسار الرد بيستعمل النسخة المنقّاة", () => {
    const src = readFileSync(join(process.cwd(), "src/modules/ai/stages/response.ts"), "utf8");
    expect(src).toMatch(/orderSummary:\s*orderResult\?\.summaryText\s*\?\s*redactSummaryContacts/);
  });
});

describe("مسار الذكاء بينادي منطق الطلب", () => {
  it("بوابة النداء بتعتمد على بيانات الطلب مش بس على التصنيف", () => {
    const src = readFileSync(join(process.cwd(), "src/modules/ai/stages/extraction.ts"), "utf8");
    expect(src).toMatch(/hasOrderData\(extraction\)/);
  });

  it("الحارس بياخد حالة الطلب من منطق الطلب", () => {
    const src = readFileSync(join(process.cwd(), "src/modules/ai/stages/response.ts"), "utf8");
    expect(src).toMatch(/orderPlaced/);
  });
});
