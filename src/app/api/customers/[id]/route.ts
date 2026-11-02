import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { updateCustomerSchema } from "@/modules/conversations/schemas";
import { getCustomerDetail, updateCustomer } from "@/modules/customers/service";
import { hasPermission } from "@/modules/rbac/permissions";

type Params = { id: string };

export const GET = createHandler(
  { permission: "customers.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const customer = await getCustomerDetail(prisma, auth!, id);
    // P14 — الواجهة تخفي أزرار التعديل/التأكيد إلا عن المخوّل (والخادم الحارس).
    return ok({
      ...customer,
      canWrite: hasPermission(auth!.role, [], "customers.write"),
      canConfirm: hasPermission(auth!.role, [], "conversations.reply"),
      canResetMemory: hasPermission(auth!.role, [], "customers.memory.reset"),
    });
  }
);

export const PATCH = createHandler(
  { body: updateCustomerSchema, permission: "customers.write" },
  async ({ auth, body, params, req }) => {
    const { id } = params as Params;
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    const updated = await updateCustomer(prisma, ctx, id, body);
    return ok(updated);
  }
);
