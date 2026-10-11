import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { AuthorizationError } from "@/core/errors";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { listAgentDrafts } from "@/modules/agent-door/drafts";

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "EDITED", "REJECTED", "EXPIRED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** P12 — طابور مسودات Hermes (مصدرها Hermes) للمراجعة. */
export const GET = createHandler({ query: querySchema }, async ({ auth, query }) => {
  if (!auth!.can("knowledge.write") && !auth!.can("campaigns.write") && !auth!.can("settings.manage")) {
    throw new AuthorizationError("Missing permission: knowledge.write or campaigns.write");
  }
  return ok(await listAgentDrafts(prisma as unknown as Db, auth!.workspaceId, query));
});
