import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { probeOmsConnection } from "@/modules/oms/connection";

/** آ«ط§ط®طھط¨ط± ط§ظ„ط§طھطµط§ظ„آ»: ظ‚ط±ط§ط،ط© ظ…ظ†طھط¬ ظˆط§ط­ط¯ ظ…ظ† ط¨ط§ط¨ ط§ظ„ظ€ OMS ط¨ط§ظ„طھظˆظƒظ† ط§ظ„ظ…ط­ظپظˆط¸. ظ…ط§ ط¨ظٹظƒطھط¨ ط´ظٹ. */
export const POST = createHandler(
  { permission: "settings.manage", rateLimit: { limit: 10, windowMs: 60_000 } },
  async ({ auth }) => ok(await probeOmsConnection(prisma, auth!.workspaceId))
);
