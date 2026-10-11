import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { AppError } from "@/core/errors";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { getProductCompliance, refreshProductCompliance, setProductS1Ref } from "@/modules/integrations/compliance";

const bodySchema = z
  .object({
    s1ProductRef: z.string().max(64).nullable().optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

async function ownedProduct(workspaceId: string, id: string) {
  const p = await prisma.product.findUnique({ where: { id }, select: { id: true, workspaceId: true, s1ProductRef: true } });
  if (!p || p.workspaceId !== workspaceId) throw new AppError("Product not found", 404, "NOT_FOUND");
  return p;
}

/** P12 — قواعد الادعاءات من سيستم 1 لهالمنتج (المسموح · الممنوع · آخر قراءة). */
export const GET = createHandler({ permission: "products.read" }, async ({ auth, params }) => {
  const p = await ownedProduct(auth!.workspaceId, String(params.id ?? ""));
  return ok({ s1ProductRef: p.s1ProductRef, compliance: await getProductCompliance(prisma as unknown as Db, p.id) });
});

/** ربط المنتج بمرجعه بسيستم 1 و/أو قراءة القواعد الآن. */
export const POST = createHandler({ body: bodySchema, permission: "products.write" }, async ({ auth, params, body }) => {
  const db = prisma as unknown as Db;
  const p = await ownedProduct(auth!.workspaceId, String(params.id ?? ""));
  const ctx = { userId: auth!.userId, workspaceId: auth!.workspaceId };
  let refreshError: string | null = null;
  if (body.s1ProductRef !== undefined) {
    await setProductS1Ref(db, ctx, p.id, body.s1ProductRef);
  } else if (body.refresh) {
    const r = await refreshProductCompliance(db, auth!.workspaceId, p.id);
    if (!r.ok) refreshError = r.error ?? "REFRESH_FAILED";
  }
  const fresh = await ownedProduct(auth!.workspaceId, p.id);
  return ok({ s1ProductRef: fresh.s1ProductRef, compliance: await getProductCompliance(db, p.id), refreshError });
});
