import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getOwnedConversation } from "@/modules/conversations/service";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { NotFoundError } from "@/core/errors";

type Params = { id: string; messageId: string };

/**
 * POST retry — resends a FAILED/QUEUED outbound message under its ORIGINAL
 * idempotency key, so the same Message row is reused and Meta never receives
 * a duplicate. SENT rows return SKIPPED_DUPLICATE.
 */
export const POST = createHandler(
  { permission: "channels.send_human" },
  async ({ auth, params }) => {
    const { id, messageId } = params as Params;
    await getOwnedConversation(prisma, auth!.workspaceId, id);
    const row = await prisma.message.findUnique({ where: { id: messageId } });
    if (!row || row.workspaceId !== auth!.workspaceId || row.conversationId !== id) {
      throw new NotFoundError("Message");
    }
    if (row.direction !== "OUTBOUND") {
      throw new NotFoundError("Message");
    }
    if (!row.outboundIdempotencyKey) {
      throw new NotFoundError("Message");
    }
    const sourceMessageId = row.outboundIdempotencyKey.slice(`${id}:`.length) || row.id;
    const meta = (row.metadata ?? {}) as { mediaId?: unknown };
    const mediaId = typeof meta.mediaId === "string" ? meta.mediaId : undefined;
    const result = await dispatchOutbound(prisma, {
      workspaceId: auth!.workspaceId,
      conversationId: id,
      sourceMessageId,
      text: row.text ?? "",
      senderType: row.senderType === "HUMAN" ? "HUMAN" : "AI",
      senderId: row.senderId ?? undefined,
      ...(mediaId ? { mediaId } : {}),
    });
    if (result.deliveryStatus === "FAILED") {
      return Response.json(
        { error: "DELIVERY_FAILED", message: result.error, messageId: result.messageId, deliveryStatus: result.deliveryStatus },
        { status: 502 }
      );
    }
    if (result.deliveryStatus === "QUEUED") {
      return Response.json({ ...result, message: "جارٍ الإرسال" }, { status: 202 });
    }
    return ok(result, result.deliveryStatus === "SKIPPED_DUPLICATE" ? 200 : 201);
  }
);
