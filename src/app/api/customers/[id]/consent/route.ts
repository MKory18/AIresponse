import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { getCustomerMarketingView, setMarketingConsent } from "@/modules/integrations/consent";

const bodySchema = z.object({ consent: z.enum(["OPTED_IN", "OPTED_OUT"]), reoptIn: z.boolean().optional() }).strict();

/** P12 — موافقة الزبون على الرسائل التسويقية + آخر مصدر إسناد (بلا معرّفات حساسة). */
export const GET = createHandler({ permission: "customers.read" }, async ({ auth, params }) => {
  return ok(await getCustomerMarketingView(prisma as unknown as Db, auth!.workspaceId, String(params.id ?? "")));
});

/** الموظف يسجّل موافقة صريحة أو إلغاء — العودة بعد إلغاء تحتاج reoptIn=true. */
export const POST = createHandler({ body: bodySchema, permission: "customers.write" }, async ({ auth, params, body }) => {
  const db = prisma as unknown as Db;
  const id = String(params.id ?? "");
  const change = await setMarketingConsent(db, { userId: auth!.userId, workspaceId: auth!.workspaceId }, id, body);
  return ok({ ...change, view: await getCustomerMarketingView(db, auth!.workspaceId, id) });
});
