import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { productUpdateSchema } from "@/modules/products/schemas";
import { getOwnedProduct, redactProductForActor, updateProduct } from "@/modules/products/service";

type Params = { id: string };

export const GET = createHandler(
  { permission: "products.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const product = await getOwnedProduct(prisma, auth!.workspaceId, id);
    // لما الـ OMS مربوط: الاسم والسعر والمخزون للقراءة بالواجهة (بتيجي منه).
    const conn = (await prisma.omsConnection.findUnique({ where: { workspaceId: auth!.workspaceId }, select: { isActive: true } })) as { isActive: boolean } | null;
    return ok({ ...redactProductForActor(product, auth!), oms: { connected: Boolean(conn?.isActive) } });
  }
);

export const PATCH = createHandler(
  { body: productUpdateSchema, permission: "products.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const updated = await updateProduct(prisma, auth!, id, body);
    return ok(redactProductForActor(updated, auth!));
  }
);
