import { z } from "zod";
import { AppError, NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import { PROVINCES_BY_MARKET } from "@/modules/orders/primitives";

/**
 * مناطق التوصيل (3.4، 03 §5.4): رسم وتوفّر كل محافظة. كانت `DeliveryRule` بلا واجهة أبدًا.
 *
 * ⚠️ مهم (سلوك موجود بـ`orders/delivery.ts`): أول ما تنضاف منطقة وحدة، أي محافظة **بلا قاعدة** بتصير «غير متاحة»
 * (`NO_DELIVERY_RULE`) — مش توصيل مجاني. 🔧 لهيك الواجهة بتبيّن المحافظات الناقصة وبتعرض «اضبط كل المحافظات برسم واحد».
 */

export const ALL_PROVINCES: readonly string[] = [...new Set(Object.values(PROVINCES_BY_MARKET).flat())];

const money = z.coerce.number().min(0).max(1_000_000_000);
export const ruleInputSchema = z
  .object({
    provinces: z.array(z.string().trim().min(1).max(60)).min(1).max(40),
    fee: money,
    isAvailable: z.boolean().default(true),
    /** توصيل مجاني فوق هالمبلغ؛ `null` = ما في حد. */
    freeOver: money.nullable().optional(),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable().optional(),
  })
  .strict();
export type RuleInput = z.infer<typeof ruleInputSchema>;

export interface RuleView {
  id: string;
  province: string;
  fee: number;
  isAvailable: boolean;
  freeOver: number | null;
  currency: string | null;
}

type Rows = Array<Record<string, unknown>>;
type Delegate = {
  findMany(a: unknown): Promise<Rows>;
  findFirst(a: unknown): Promise<Record<string, unknown> | null>;
  create(a: unknown): Promise<Record<string, unknown>>;
  update(a: unknown): Promise<Record<string, unknown>>;
  delete(a: unknown): Promise<unknown>;
};
type Db = { deliveryRule: Delegate } & Record<string, unknown>;

const toView = (r: Record<string, unknown>): RuleView => ({
  id: String(r.id),
  province: String(r.province),
  fee: Number(r.fee ?? 0),
  isAvailable: r.isAvailable !== false,
  freeOver: r.freeOver === null || r.freeOver === undefined ? null : Number(r.freeOver),
  currency: typeof r.currency === "string" ? r.currency : null,
});

/** القواعد + المحافظات الناقصة + تحذير «الباقي غير متاح» لما تكون القائمة جزئية. */
export async function listRules(dbIn: unknown, workspaceId: string) {
  const db = dbIn as Db;
  const rules = (await db.deliveryRule.findMany({ where: { workspaceId }, orderBy: { province: "asc" } })).map(toView);
  const have = new Set(rules.map((r) => r.province));
  const missing = ALL_PROVINCES.filter((p) => !have.has(p));
  return { rules, missing, partial: rules.length > 0 && missing.length > 0 };
}

/** ينشئ أو يحدّث قاعدة لكل محافظة بالطلب (بنفس القيم). محافظة مجهولة = رفض واضح (الاسم لازم يطابق قائمة السوق). */
export async function saveRules(dbIn: unknown, ctx: { userId: string; workspaceId: string }, input: RuleInput): Promise<RuleView[]> {
  const db = dbIn as Db;
  const unknown = input.provinces.filter((p) => !ALL_PROVINCES.includes(p));
  if (unknown.length > 0) throw new AppError(`محافظة غير معروفة: ${unknown.join("، ")}`, 422, "VALIDATION_ERROR");
  const out: RuleView[] = [];
  for (const province of [...new Set(input.provinces)]) {
    const data = { fee: input.fee, isAvailable: input.isAvailable, freeOver: input.freeOver ?? null, currency: input.currency ?? null };
    const existing = await db.deliveryRule.findFirst({ where: { workspaceId: ctx.workspaceId, province } });
    out.push(
      toView(existing ? await db.deliveryRule.update({ where: { id: existing.id }, data }) : await db.deliveryRule.create({ data: { workspaceId: ctx.workspaceId, province, ...data } }))
    );
  }
  await recordAudit(db as never, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "delivery_rules.saved",
    entityType: "DeliveryRule",
    metadata: { provinces: out.map((r) => r.province), fee: input.fee, isAvailable: input.isAvailable },
  });
  return out;
}

export async function deleteRule(dbIn: unknown, ctx: { userId: string; workspaceId: string }, id: string): Promise<void> {
  const db = dbIn as Db;
  const rule = await db.deliveryRule.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
  if (!rule) throw new NotFoundError("Delivery rule");
  await db.deliveryRule.delete({ where: { id } });
  await recordAudit(db as never, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "delivery_rules.deleted",
    entityType: "DeliveryRule",
    entityId: id,
    metadata: { province: String(rule.province) },
  });
}
