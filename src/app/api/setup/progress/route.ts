import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { getSetupProgress } from "@/modules/setup/progress";

export const dynamic = "force-dynamic";

/**
 * خطوات البداية بالرئيسية. قراءة بس (ولا كتابة)، ومحصورة بمساحة العضو.
 * بترجّع أعلام منطقية بلا أرقام ولا أسماء — ولا شي حسّاس.
 *
 * `settings.manage`: التجهيز شغلة المالك/المدير. الموظف العادي ما بيشوف
 * البطاقة (الواجهة بتخفيها عند 403) — ولا فائدة له منها.
 */
export const GET = createHandler({ permission: "settings.manage" }, async ({ auth }) => {
  return ok(await getSetupProgress(prisma as unknown as Db, auth!.workspaceId));
});
