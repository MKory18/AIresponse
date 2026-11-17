import { cookies } from "next/headers";
import { prisma } from "@/core/db/prisma";
import { readSession } from "@/modules/auth/session";
import { getIntegrationSettings } from "@/modules/integrations/settings";
import { UI_VERSION_COOKIE, resolveUiVersion } from "@/lib/ui-version";
import LegacyAnalytics from "./legacy-analytics";
import { ReportsView } from "./v2/reports-view";

/**
 * `/analytics`: التقارير الجديدة (v2: 4 تبويبات من كتالوج المؤشرات) أو الصفحة الحالية (v1) — حسب مفتاح الواجهة.
 * الصفحة الحالية بتنحذف بحزمة 3.8 مع `v1`.
 */
export default async function AnalyticsPage() {
  const session = await readSession();
  const settings = session?.workspaceId ? await getIntegrationSettings(prisma as never, session.workspaceId) : null;
  const version = resolveUiVersion({ cookie: cookies().get(UI_VERSION_COOKIE)?.value, setting: settings?.uiVersion });
  return version === "v2" ? <ReportsView /> : <LegacyAnalytics />;
}
