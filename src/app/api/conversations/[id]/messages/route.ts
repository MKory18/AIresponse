import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listQuerySchema, postMessageSchema } from "@/modules/conversations/schemas";
import { listMessages } from "@/modules/conversations/service";
import { sendHumanReply } from "@/modules/channels/outbound";
import { z } from "zod";

type Params = { id: string };

export const GET = createHandler(
  { query: listQuerySchema, permission: "conversations.read" },
  async ({ auth, query, params }) => {
    const { id } = params as Params;
    const result = await listMessages(prisma, auth!, id, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return ok(result);
  }
);

const humanPostSchema = postMessageSchema.and(
  z.object({ idempotencyKey: z.string().max(80).optional() })
);

export const POST = createHandler(
  { body: humanPostSchema, permission: "channels.send_human" },
  async ({ auth, body: rawBody, params, req }) => {
    const { id } = params as Params;
    const body = humanPostSchema.parse(rawBody);
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    void ctx;
    const result = await sendHumanReply(prisma, {
      workspaceId: auth!.workspaceId,
      conversationId: id,
      userId: auth!.userId,
      text: body.text ?? `[${body.type ?? "ATTACHMENT"}] ${body.mediaUrl ?? ""}`.trim(),
      idempotencyKey: body.idempotencyKey,
    });
    // Honest statuses: the UI must never show "sent" before Graph confirms it.
    if (result.deliveryStatus === "FAILED") {
      return Response.json(
        { error: "DELIVERY_FAILED", message: result.error, messageId: result.messageId, deliveryStatus: result.deliveryStatus },
        { status: 502 }
      );
    }
    if (result.deliveryStatus === "QUEUED") {
      return Response.json(
        { ...result, message: "جارٍ الإرسال" },
        { status: 202 }
      );
    }
    return ok(result, result.deliveryStatus === "SKIPPED_DUPLICATE" ? 200 : 201);
  }
);
