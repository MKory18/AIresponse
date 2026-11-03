import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { normalizeOrderFields } from "@/modules/orders/required-fields";
import { telegramNotifiedDraftIds } from "@/modules/orders/ready-drafts";

const listQuerySchema = z.object({
  conversationId: z.string().cuid().optional(),
  state: z.enum(["EMPTY", "COLLECTING", "READY", "CONFIRMING", "CONFIRMED", "CONVERTED", "CANCELLED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const GET = createHandler(
  { query: listQuerySchema, permission: "orders.read" },
  async ({ auth, query }) => {
    const where: Record<string, unknown> = { workspaceId: auth!.workspaceId };
    if (query.conversationId) where.conversationId = query.conversationId;
    if (query.state) where.state = query.state;
    const drafts = await prisma.orderDraft.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: query.limit ?? 25,
    });

    // P19 — الحقول المطلوبة تتبع صفحة المحادثة (للتحقق من نسبة الاكتمال).
    const conversationIds = [...new Set(drafts.map((d) => d.conversationId))];
    const conversations = conversationIds.length
      ? await prisma.conversation.findMany({
          where: { id: { in: conversationIds }, workspaceId: auth!.workspaceId },
          select: { id: true, channelId: true },
        })
      : [];
    const channelIds = [...new Set(conversations.map((c) => c.channelId).filter((id): id is string => Boolean(id)))];
    const channels = channelIds.length
      ? await prisma.channel.findMany({
          where: { id: { in: channelIds }, workspaceId: auth!.workspaceId },
          select: { id: true, orderRequiredFields: true },
        })
      : [];
    const channelById = new Map(channels.map((c) => [c.id, c]));
    const channelIdByConversation = new Map(conversations.map((c) => [c.id, c.channelId]));

    // اسم/رقم العميل + هل انرحّلت المسودة لتلجرام فعلًا (سجل تدقيق الإرسال).
    const customerIds = [...new Set(drafts.map((d) => d.customerId).filter(Boolean))];
    const customers = customerIds.length
      ? await prisma.customer.findMany({
          where: { id: { in: customerIds }, workspaceId: auth!.workspaceId },
          select: { id: true, name: true, phone: true },
        })
      : [];
    const customerById = new Map(customers.map((c) => [c.id, c]));
    const draftIds = drafts.map((d) => d.id);
    const notifiedIds = await telegramNotifiedDraftIds(prisma, auth!.workspaceId, draftIds);

    return ok({
      items: drafts.map((d) => {
        const channelId = channelIdByConversation.get(d.conversationId);
        const channel = channelId ? channelById.get(channelId) : null;
        const customer = customerById.get(d.customerId) ?? null;
        return {
          ...d,
          requiredFields: normalizeOrderFields(
            (channel as { orderRequiredFields?: string[] } | null | undefined)?.orderRequiredFields
          ),
          customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone } : null,
          telegramNotified: notifiedIds.has(d.id),
        };
      }),
    });
  }
);
