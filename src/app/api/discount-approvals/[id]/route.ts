import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { decideDiscountApproval } from "@/modules/sales/pricing-policy";

type Params = { id: string };

/** P8 — قرار المشرف على طلب الخصم (orders.discount.approve) — مفصول عن المُصدِر. */
export const POST = createHandler(
  {
    body: z.object({ decision: z.enum(["APPROVED", "REJECTED"]) }).strict(),
    permission: "orders.discount.approve",
  },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const row = await decideDiscountApproval(prisma, auth!, id, body.decision);
    return ok(row);
  }
);
