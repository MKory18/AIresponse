import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getOmsConnectionView, saveOmsConnection } from "@/modules/oms/connection";

/**
 * ط±ط¨ط· ط§ظ„ظ€ OMS (ط¨ط§ط¨ /api/v1).
 *
 * GET â€” ط§ظ„ط­ط§ظ„ط© ط¨ط³ (ظˆط¬ظˆط¯ ط§ظ„طھظˆظƒظ† boolean â€” ط§ظ„ظ‚ظٹظ…ط© ظ…ط§ ط¨طھط±ط¬ط¹ ط£ط¨ط¯ظ‹ط§).
 * PUT â€” ط§ظ„ط±ط§ط¨ط· آ· ط§ظ„طھظˆظƒظ† (ظ…ط´ظپظ‘ط± آ· ط¨ظٹظ†ط¨ط¹طھ ط¨ط³ ط¹ظ†ط¯ ط§ظ„ط¥ط¯ط®ط§ظ„/ط§ظ„طھط؛ظٹظٹط±) آ· طھط´ط؛ظٹظ„ آ·
 *       ط¥ط±ط³ط§ظ„ ظƒظ„ ط·ظ„ط¨ طھظ„ظ‚ط§ط¦ظٹظ‹ط§.
 */
const bodySchema = z.object({
  baseUrl: z.string().trim().min(8).max(300),
  token: z.string().trim().min(10).max(300).optional(),
  isActive: z.boolean().optional(),
  autoHandoff: z.boolean().optional(),
});

export const GET = createHandler({ permission: "settings.manage" }, async ({ auth }) => {
  return ok(await getOmsConnectionView(prisma, auth!.workspaceId));
});

export const PUT = createHandler({ body: bodySchema, permission: "settings.manage" }, async ({ auth, body }) => {
  return ok(await saveOmsConnection(prisma, { workspaceId: auth!.workspaceId, userId: auth!.userId }, body));
});
