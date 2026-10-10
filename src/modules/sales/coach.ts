import { AuthorizationError, NotFoundError } from "@/core/errors";
import type { ActorContext, Db } from "@/modules/customers/service";
import { recordSalesEvent } from "./metrics";
import { buildSalesPlan, safeObjectionFallback, type BuildSalesPlanInput } from "./plan-builder";
import {
  DISCOUNT_PERMISSION,
  WHOLESALE_PERMISSION,
  discountedPrice,
  evaluateDiscountPolicy,
  type PolicyCtx,
} from "./pricing-policy";
import type { SalesPlan } from "./plan-schemas";

/**
 * P8 — Sales Coach: مساعد الموظف داخل صندوق الوارد.
 *
 * قواعد صارمة:
 * - الاقتراحات للموظف فقط (internalOnly) — لا تُرسل تلقائيًا أبدًا؛ الإرسال
 *   يمر حصرًا عبر مسار الرد الصريح الموجود (conversations.reply) مع إعادة
 *   فحص الأسعار والصلاحيات لحظة التنفيذ.
 * - سعر الجملة يظهر فقط لمن يملك `products.wholesale` (فحص خادمي).
 * - البيانات الناقصة تعرض سببًا صريحًا — لا تخمين ولا اختراع.
 * - الملاحظات الداخلية (salesNotes) لا تغادر للعميل — تبقى سياقًا خادميًا
 *   ولا تدخل نص الاقتراح المُرسل.
 */

export interface CoachSuggestion {
  kind: "REPLY_HINT" | "OFFER" | "CROSS_SELL" | "OBJECTION" | "DISCOUNT";
  title: string;
  detail: string;
  /** نص جاهز يضعه الموظف في الرد — إجراء صريح منه فقط. */
  draftText?: string;
  requiresApproval?: boolean;
}

export interface CoachResult {
  internalOnly: true;
  suggestions: CoachSuggestion[];
  salesPlan: SalesPlan;
  /** سعر الجملة — يظهر فقط للمخول بـ products.wholesale. */
  wholesalePrice: number | null;
  productUpdatedAt: string | null;
}

export async function buildCoachSuggestions(
  db: Db,
  ctx: PolicyCtx,
  input: { conversationId: string; productId?: string | null; discountPercent?: number | null }
): Promise<CoachResult> {
  const conversation = await db.conversation.findUnique({ where: { id: input.conversationId } });
  if (!conversation || conversation.workspaceId !== ctx.workspaceId) throw new NotFoundError("Conversation");

  const canSeeWholesale = typeof ctx.can === "function" ? ctx.can(WHOLESALE_PERMISSION) : false;
  const hasDiscount = typeof ctx.can === "function" ? ctx.can(DISCOUNT_PERMISSION) : false;

  // آخر نص عميل موثوق (للاعتراض/رفض العرض).
  const recent = await db.message.findMany({
    where: { conversationId: input.conversationId, direction: "INBOUND" },
    orderBy: { createdAt: "desc" },
    take: 3,
  } as never);
  const lastCustomerText = recent.map((m) => (m as { text?: string | null }).text ?? "").find((t) => t.trim()) ?? null;

  // المنتج: صريحًا من الطلب، وإلا من المسودة الجارية، وإلا لا منتج.
  let product: Record<string, unknown> | null = null;
  if (input.productId) {
    const row = await db.product.findUnique({ where: { id: input.productId } });
    if (!row || row.workspaceId !== ctx.workspaceId) throw new NotFoundError("Product");
    product = row as unknown as Record<string, unknown>;
  } else {
    const draft = await (db as unknown as {
      orderDraft: { findFirst: (a: unknown) => Promise<Record<string, unknown> | null> };
    }).orderDraft.findFirst({
      where: { workspaceId: ctx.workspaceId, conversationId: input.conversationId },
      orderBy: { updatedAt: "desc" },
    });
    if (draft?.productId) {
      const row = await db.product.findUnique({ where: { id: String(draft.productId) } });
      if (row && row.workspaceId === ctx.workspaceId) product = row as unknown as Record<string, unknown>;
    }
  }

  const planInput: BuildSalesPlanInput = {
    workspaceId: ctx.workspaceId,
    intent: "PRODUCT_QUESTION",
    product,
    customerText: lastCustomerText,
    customerId: conversation.customerId,
    conversationId: input.conversationId,
    recordEvents: true,
  };
  const salesPlan = await buildSalesPlan(db, planInput);

  const suggestions: CoachSuggestion[] = [];
  if (salesPlan.primary) {
    suggestions.push({
      kind: "REPLY_HINT",
      title: `المنتج الحالي: ${salesPlan.primary.name}`,
      detail: `السعر الرسمي ${salesPlan.primary.unitPrice} ${salesPlan.primary.currency} — التوفر ${salesPlan.primary.stockStatus}`,
      draftText: `${salesPlan.primary.name} بسعر ${salesPlan.primary.unitPrice} ${salesPlan.primary.currency}.`,
    });
  }
  if (salesPlan.upsell) {
    suggestions.push({
      kind: "OFFER",
      title: salesPlan.upsell.title,
      detail: `${salesPlan.upsell.quantity} وحدة بـ ${salesPlan.upsell.price} ${salesPlan.upsell.currency} — توفير ${salesPlan.upsell.saving}`,
      draftText: `لدينا عرض: ${salesPlan.upsell.title} — ${salesPlan.upsell.quantity} وحدة بسعر ${salesPlan.upsell.price} ${salesPlan.upsell.currency} (توفير ${salesPlan.upsell.saving}). هل يناسبك؟`,
    });
  }
  for (const c of salesPlan.crossSell) {
    suggestions.push({
      kind: "CROSS_SELL",
      title: c.name,
      detail: `منتج مكمل — السعر ${c.unitPrice} ${c.currency}`,
      draftText: `يمكن أن يكمل تجربتك ${c.name} بسعر ${c.unitPrice} ${c.currency}. هل أضيفه؟`,
    });
  }
  if (salesPlan.objection) {
    const { topic, trustedAnswerAvailable } = salesPlan.objection;
    suggestions.push({
      kind: "OBJECTION",
      title: `اعتراض مرصود: ${topic}`,
      detail: trustedAnswerAvailable
        ? "يوجد رد موثق في بيانات المنتج — استخدمه دون تغيير الحقائق."
        : `لا يوجد رد موثق لهذا الاعتراض — اقتراح آمن بلا اختراع: ${safeObjectionFallback(topic)}`,
      draftText: trustedAnswerAvailable ? undefined : safeObjectionFallback(topic),
    });
  }

  // الخصم: قرار حتمي من سياسة السقف — بلا صلاحية لا يُعرض أصلًا.
  if (product && input.discountPercent && hasDiscount) {
    const decision = evaluateDiscountPolicy(product, input.discountPercent);
    if (decision.reason !== "INVALID_DISCOUNT") {
      const unitPrice = Number(product.price);
      const { price, amount } = discountedPrice(unitPrice, input.discountPercent);
      salesPlan.discount = {
        percent: input.discountPercent,
        basePrice: unitPrice,
        discountedPrice: price,
        amount,
        capPercent: decision.capPercent,
        requiresApproval: decision.requiresApproval,
      };
      suggestions.push({
        kind: "DISCOUNT",
        title: `خصم ${input.discountPercent}%`,
        detail: decision.requiresApproval
          ? `فوق السقف (${decision.capPercent ?? "بلا سقف مهيأ"}) — يتطلب موافقة مشرف`
          : `ضمن السقف (${decision.capPercent}%) — السعر بعد الخصم ${price}`,
        draftText: `يمكنني تقديم خصم ${input.discountPercent}% — يصبح السعر ${price} ${String(product.currency ?? "USD")}.`,
        requiresApproval: decision.requiresApproval,
      });
    }
  }
  if (!hasDiscount && input.discountPercent) {
    // ممنوع حتى حساب تفاصيل الخصم لمستخدم بلا صلاحية.
    throw new AuthorizationError("صلاحية الخصم مطلوبة");
  }

  await recordSalesEvent(db, {
    workspaceId: ctx.workspaceId,
    type: "COACH_USED",
    conversationId: input.conversationId,
    customerId: conversation.customerId,
    productId: salesPlan.primary?.productId ?? null,
    sku: salesPlan.primary?.sku ?? null,
  }).catch(() => {});

  return {
    internalOnly: true,
    suggestions,
    salesPlan,
    wholesalePrice: canSeeWholesale && product ? Number(product.wholesalePrice ?? null) || null : null,
    productUpdatedAt: product?.updatedAt ? new Date(product.updatedAt as string | Date).toISOString() : null,
  };
}

/** تحقق خادمي أن أي نص صيغ للعميل لا يحمل سعر الجملة (حماية نهائية). */
export function assertNoWholesaleLeak(text: string, wholesalePrice: number | null): void {
  if (wholesalePrice === null || !Number.isFinite(wholesalePrice)) return;
  if (text.includes(String(wholesalePrice))) {
    throw new AuthorizationError("نص الرد يحتوي سعر الجملة — ممنوع الإرسال");
  }
}
