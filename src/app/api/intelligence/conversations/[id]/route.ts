import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { confirmIntelField, reanalyzeConversation } from "@/modules/intelligence/service";
import { getLabConversation } from "@/modules/intelligence/queries";
import { INTEL_FIELD_KEYS, type IntelFieldKey } from "@/modules/intelligence/fields";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reanalyze") }),
  z.object({
    action: z.literal("confirm"),
    key: z.string().refine((k) => (INTEL_FIELD_KEYS as readonly string[]).includes(k), "unknown field"),
    value: z.string().max(300).nullable(),
  }),
]);

type Params = { id: string };

/** GET /api/intelligence/conversations/[id] — الرسائل + المعلومات المستخرجة. */
export const GET = createHandler(
  { permission: "conversations.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const detail = await getLabConversation(prisma as never, {
      workspaceId: auth!.workspaceId,
      conversationId: id,
    });
    if (!detail) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    return ok(detail);
  }
);

/**
 * POST — إعادة تحليل عند فشل AI (لا تمس الرسائل ولا ترسل شيئًا)،
 * أو تأكيد/تصحيح حقل من موظف (يصبح CONFIRMED).
 */
export const POST = createHandler(
  { body: bodySchema, permission: "conversations.reply", rateLimit: { limit: 10, windowMs: 60_000 } },
  async ({ auth, params, body }) => {
    const { id } = params as Params;
    const detail = await getLabConversation(prisma as never, {
      workspaceId: auth!.workspaceId,
      conversationId: id,
    });
    if (!detail) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    if (body.action === "reanalyze") {
      const result = await reanalyzeConversation(prisma as never, {
        workspaceId: auth!.workspaceId,
        conversationId: id,
      });
      return ok(result);
    }

    const result = await confirmIntelField(prisma as never, {
      workspaceId: auth!.workspaceId,
      conversationId: id,
      key: body.key as IntelFieldKey,
      value: body.value,
      userId: auth!.userId,
    });
    if (!result.ok) return Response.json({ error: result.reason ?? "FAILED" }, { status: 400 });
    return ok({ ok: true });
  }
);
