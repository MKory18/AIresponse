import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getOmsConnectionView, saveOmsConnection } from "@/modules/oms/connection";

const connectionSchema = z.object({
  baseUrl: z.string().url().max(500),
  // P12: التوكن اختياري بالوضع اليدوي (الـ OMS بلا باب استقبال بعد)، وحقل
  // فارغ عند التعديل = لا تغيير.
  token: z.string().min(8).max(500).optional().or(z.literal("")),
  isActive: z.boolean().optional(),
  mode: z.enum(["api", "manual"]).optional(),
  apiVersion: z.enum(["legacy", "v1"]).optional(),
  webhookSecret: z.string().max(200).optional().or(z.literal("")),
  autoHandoff: z.boolean().optional(),
  rotateWebhookKey: z.boolean().optional(),
});

/** حالة اتصال الـ OMS (بلا أي سر) + رابط الاستقبال لتسجيله بالـ OMS. */
export const GET = createHandler({ permission: "settings.manage" }, async ({ auth }) => {
  return ok(await getOmsConnectionView(prisma, auth!.workspaceId));
});

/** Saves the OMS connection — token/secret encrypted with the channel-secrets cipher. */
export const POST = createHandler(
  { body: connectionSchema, permission: "settings.manage" },
  async ({ auth, body, req }) => {
    const ctx = {
      userId: auth!.userId,
      workspaceId: auth!.workspaceId,
      ip: req.headers.get("x-forwarded-for") ?? undefined,
    };
    const view = await saveOmsConnection(prisma, ctx, {
      baseUrl: body.baseUrl,
      token: body.token || null,
      isActive: body.isActive,
      mode: body.mode,
      apiVersion: body.apiVersion,
      webhookSecret: body.webhookSecret || null,
      autoHandoff: body.autoHandoff,
      rotateWebhookKey: body.rotateWebhookKey,
    });
    return ok(view);
  }
);
