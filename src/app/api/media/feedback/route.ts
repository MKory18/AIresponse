import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { findFeedbackMedia } from "@/modules/media/service";

/**
 * APPROVED CUSTOMER-PROOF IMAGES, FOR HAND-PICKING ONLY.
 *
 * Customer reviews never go out automatically — the agent opens this list
 * from the inbox picker and chooses one by eye. Every row passed the
 * same CUSTOMER_INBOUND exclusion as the library (see findFeedbackMedia),
 * and the picker screen warns the agent to check the photo carries no
 * customer name or phone before sending.
 */
const feedbackQuerySchema = z.object({
  productId: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export const GET = createHandler(
  { query: feedbackQuerySchema, permission: "media.read" },
  async ({ auth, query }) => {
    const items = query.productId
      ? await findFeedbackMedia(prisma, auth!.workspaceId, query.productId, query.limit ?? 10)
      : await prisma.feedback.findMany({
          where: { workspaceId: auth!.workspaceId, isApproved: true, isArchived: false, mediaId: { not: null } },
          include: { media: true, product: { select: { id: true, name: true } } },
          orderBy: { createdAt: "desc" },
          take: query.limit ?? 10,
        });
    const rows = (query.productId ? items.map((m) => ({ media: m, product: null })) : items) as {
      media: { id: string; url: string; type: string; mimeType: string; size: number; title: string | null; category: string } | null;
      product: { id: string; name: string } | null;
    }[];
    return ok({
      items: rows
        .filter((r) => r.media && r.media.category !== "CUSTOMER_INBOUND")
        .map((r) => ({ ...r.media, product: r.product })),
    });
  }
);
