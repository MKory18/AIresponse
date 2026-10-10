import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { sendPlaygroundMessage } from "@/modules/ai/playground-service";
import { PgVectorStore } from "@/modules/knowledge/vector-store";

type Params = { id: string };

const messageSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  withOrderProposal: z.boolean().optional(),
  /** Optional display-only test name — prompt context only, never persisted as a Customer. */
  customerName: z.string().trim().max(100).optional(),
  /** P6: exercise a specific task model (default RESPONSE). */
  task: z.enum(["RESPONSE", "EXTRACTION", "SUMMARY"]).optional(),
  /** P6: test unpublished instructions (in-memory only, never saved). */
  draftInstructions: z.string().max(20000).optional(),
  /** P6: test a PersonaVersion snapshot (workspace-scoped). */
  personaVersionId: z.string().cuid().optional(),
});

/**
 * POST /api/ai/playground/sessions/[id]/messages — send an internal test
 * message. Uses the real configured AI provider against isolated playground
 * tables only. NEVER touches production conversations, customers, orders,
 * or the Facebook sender.
 */
export const POST = createHandler(
  { body: messageSchema, permission: "ai.configure", rateLimit: { limit: 20, windowMs: 60_000 } },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const vectorStore = new PgVectorStore((sql, sqlParams) =>
      (prisma.$queryRawUnsafe as (s: string, ...p: unknown[]) => Promise<Array<Record<string, unknown>>>)(
        sql,
        ...sqlParams
      )
    );
    const result = await sendPlaygroundMessage(prisma, auth!, id, body.text, {
      withOrderProposal: body.withOrderProposal,
      customerName: body.customerName,
      task: body.task,
      draftInstructions: body.draftInstructions ?? null,
      personaVersionId: body.personaVersionId ?? null,
      vectorStore,
    });
    return ok(result);
  }
);
