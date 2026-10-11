import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { buildOmsIntake, linkManualOmsOrder, unlinkManualOmsOrder } from "@/modules/oms/manual";

type Params = { orderId: string };

/** نص الإدخال الجاهز لشاشة «إدخال الطلب بالذكاء» بالـ OMS (يحوي بيانات الزبون — للموظف فقط). */
export const GET = createHandler({ permission: "orders.write" }, async ({ auth, params }) => {
  const { orderId } = params as Params;
  return ok(await buildOmsIntake(prisma, auth!.workspaceId, orderId));
});

const linkSchema = z.object({ omsOrderNumber: z.string().min(2).max(40) });

/** ربط رقم طلب الـ OMS بعد إنشائه هناك — أحداث الـ OMS بعدها تُطابق بالرقم. */
export const POST = createHandler({ body: linkSchema, permission: "orders.write" }, async ({ auth, body, params }) => {
  const { orderId } = params as Params;
  return ok(await linkManualOmsOrder(prisma, { userId: auth!.userId, workspaceId: auth!.workspaceId }, orderId, body.omsOrderNumber));
});

/** فك ربط يدوي خاطئ (فقط قبل أن يؤكده الـ OMS بأحداثه). */
export const DELETE = createHandler({ permission: "orders.write" }, async ({ auth, params }) => {
  const { orderId } = params as Params;
  await unlinkManualOmsOrder(prisma, { userId: auth!.userId, workspaceId: auth!.workspaceId }, orderId);
  return ok({ ok: true });
});
