import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { decideAgentDraft } from "@/modules/agent-door/drafts";

const bodySchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().max(500).optional(),
    edits: z
      .object({
        question: z.string().min(3).max(500).optional(),
        answer: z.string().min(3).max(2000).optional(),
        topic: z.string().min(2).max(60).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * P12 — قرار مسودة: اعتماد (مع تعديل اختياري لقالب الرد) أو رفض.
 * الصلاحية حسب النوع: قالب رد = knowledge.write · حملة = campaigns.write.
 * اعتماد حملة ما بيرسل شي — بيعمل حملة جاهزة بانتظار اعتماد الحملات.
 */
export const POST = createHandler({ body: bodySchema }, async ({ auth, params, body }) => {
  const view = await decideAgentDraft(
    prisma as unknown as Db,
    { userId: auth!.userId, workspaceId: auth!.workspaceId, can: auth!.can },
    String(params.id ?? ""),
    { decision: body.decision, note: body.note ?? null, edits: body.edits ?? null }
  );
  return ok(view);
});
