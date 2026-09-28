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
      vectorStore,
    });
    return ok(result);
  }
);
