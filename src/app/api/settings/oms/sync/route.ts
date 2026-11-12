import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { syncProductsFromOms } from "@/modules/oms/sync";

/**
 * آ«ط§ط³طھط¨ط¯ظ„ ط§ظ„ظ…ظ†طھط¬ط§طھ ط¨ظ…ظ†طھط¬ط§طھ ط§ظ„ظ€ OMS ظ‡ظ„ط£آ».
 * âڑ ï¸ڈ ط£ظٹ ظ…ظ†طھط¬ ظپط¹ظ‘ط§ظ„ ط¹ظ†ط¯ظ†ط§ ظ…ط´ ط¨ط§ظ„ظ€ OMS ط¨ظٹطھظˆظ‚ظپ (ظ…ط´ ط¨ظٹظ†ط­ط°ظپ â€” ط¨ظٹط±ط¬ط¹ ظ…ظ† طµظپط­طھظ‡).
 */
export const POST = createHandler(
  { permission: "settings.manage", rateLimit: { limit: 6, windowMs: 60_000 } },
  async ({ auth }) => ok(await syncProductsFromOms(prisma, { workspaceId: auth!.workspaceId, userId: auth!.userId }))
);
