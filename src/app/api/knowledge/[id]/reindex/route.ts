import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { reindexDocument } from "@/modules/knowledge/service";

type Params = { id: string };

/** POST /api/knowledge/[id]/reindex — reset to PROCESSING and re-enqueue ingestion. */
export const POST = createHandler({ permission: "knowledge.write" }, async ({ auth, params }) => {
  const { id } = params as Params;
  const updated = await reindexDocument(prisma, auth!, id);
  return ok(updated, 202);
});
