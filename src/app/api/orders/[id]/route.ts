import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { getOwnedOrder, transitionOrder, withoutClickSecrets } from "@/modules/orders/order-service";
import { autoHandoffState } from "@/modules/oms/auto-handoff";

type Params = { id: string };

export const GET = createHandler(
  { permission: "orders.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const order = await getOwnedOrder(prisma, auth!.workspaceId, id);
    const timeline = await prisma.auditLog.findMany({
      where: { workspaceId: auth!.workspaceId, entityId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    // P12: معرّفات الإسناد المشفّرة (رمز النقرة · PSID) ما بتطلع للمتصفح أبدًا.
    const safe = withoutClickSecrets(order);
    // P12: وضع اتصال الـ OMS (بلا أي سر) لبطاقة الترحيل بصفحة الطلب.
    const oms = await prisma.omsConnection.findUnique({
      where: { workspaceId: auth!.workspaceId },
      select: { mode: true, isActive: true, autoHandoff: true, apiVersion: true },
    });
    const o = order as typeof order & { omsOrderId?: string | null; omsOrderNumber?: string | null; handoffMode?: string | null };
    // حالة الترحيل التلقائي (بانتظار · بيعيد · فشل · انرفض) — للأحمر بالبطاقة.
    const autoHandoff =
      oms?.mode === "api" ? await autoHandoffState(prisma as unknown as Db, auth!.workspaceId, id, Boolean(o.omsOrderId)) : null;
    // ربط يدوي ما طابق أحداث الـ OMS (رقم غلط على الأغلب) — من السجل، لنفس الرقم الحالي.
    const mismatch =
      o.omsOrderNumber && !o.omsOrderId
        ? timeline.find(
            (t) => t.action === "oms.manual_link_mismatch" && (t.metadata as { omsOrderNumber?: string } | null)?.omsOrderNumber === o.omsOrderNumber
          )
        : undefined;
    const linkIssue = mismatch
      ? {
          reason: String((mismatch.metadata as { reason?: string } | null)?.reason ?? "MISMATCH"),
          omsTotal: (mismatch.metadata as { omsTotal?: number | null } | null)?.omsTotal ?? null,
          omsCurrency: (mismatch.metadata as { omsCurrency?: string | null } | null)?.omsCurrency ?? null,
          at: mismatch.createdAt,
        }
      : null;
    return ok({ ...safe, timeline, oms, omsState: { autoHandoff, linkIssue }, canWrite: auth!.can("orders.write") });
  }
);

const patchSchema = z.object({
  status: z.enum(["CONFIRMATION_PENDING", "CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "FAILED", "RETURNED"]).optional(),
  notes: z.string().max(5000).optional(),
});

export const PATCH = createHandler(
  { body: patchSchema, permission: "orders.write" },
  async ({ auth, body, params, req }) => {
    const { id } = params as Params;
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    if (body.status) {
      const updated = await transitionOrder(prisma, ctx, id, body.status);
      return ok(withoutClickSecrets(updated));
    }
    // ملكية المساحة قبل أي كتابة (كان التعديل بالمعرّف بس = كتابة عبر المساحات).
    await getOwnedOrder(prisma, auth!.workspaceId, id);
    const updated = await prisma.order.update({
      where: { id },
      data: { notes: body.notes },
    });
    return ok(withoutClickSecrets(updated));
  }
);
