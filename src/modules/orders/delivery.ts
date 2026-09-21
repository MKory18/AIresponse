import type { Prisma } from "@prisma/client";
import { NotFoundError } from "@/core/errors";
import type { Db } from "@/modules/customers/service";

export interface DeliveryQuote {
  available: boolean;
  fee: number;
  reason?: string;
}

/**
 * DeliveryRulesService — per-workspace, DB-backed, deterministic.
 * AI never invents fees; unknown provinces fall back to workspace default.
 */
export async function quoteDelivery(
  db: Db,
  params: {
    workspaceId: string;
    province?: string | null;
    subtotal: number;
    defaultFee?: number;
  }
): Promise<DeliveryQuote> {
  if (!params.province) {
    return { available: true, fee: params.defaultFee ?? 0, reason: "NO_PROVINCE_DEFAULT_FEE" };
  }
  const rule = await db.deliveryRule.findFirst({
    where: { workspaceId: params.workspaceId, province: params.province },
  });
  if (!rule) {
    // Unconfigured province: available with default fee rather than a hard
    // reject — the workspace can tighten this by adding rules.
    return { available: true, fee: params.defaultFee ?? 0, reason: "NO_RULE_DEFAULT_FEE" };
  }
  if (!rule.isAvailable) {
    return { available: false, fee: 0, reason: "PROVINCE_NOT_SERVED" };
  }
  const fee = Number(rule.fee);
  const freeOver = rule.freeOver ? Number(rule.freeOver) : null;
  if (freeOver !== null && params.subtotal >= freeOver) {
    return { available: true, fee: 0, reason: "FREE_OVER_THRESHOLD" };
  }
  return { available: true, fee, reason: "RULE" };
}

export async function upsertDeliveryRule(
  db: Db,
  workspaceId: string,
  input: { province: string; fee: number; isAvailable?: boolean; freeOver?: number | null }
) {
  const existing = await db.deliveryRule.findFirst({
    where: { workspaceId, province: input.province },
  });
  if (existing) {
    return db.deliveryRule.update({
      where: { id: existing.id },
      data: {
        fee: input.fee,
        ...(input.isAvailable !== undefined ? { isAvailable: input.isAvailable } : {}),
        ...(input.freeOver !== undefined ? { freeOver: input.freeOver } : {}),
      },
    });
  }
  return db.deliveryRule.create({
    data: {
      workspaceId,
      province: input.province,
      fee: input.fee,
      isAvailable: input.isAvailable ?? true,
      freeOver: input.freeOver ?? null,
    } as Prisma.DeliveryRuleUncheckedCreateInput,
  });
}

export function assertWorkspaceScope(workspaceId: string, rowWorkspaceId: string) {
  if (workspaceId !== rowWorkspaceId) throw new NotFoundError("Resource");
}
