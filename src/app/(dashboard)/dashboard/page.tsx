import { cookies } from "next/headers";
import { prisma } from "@/core/db/prisma";
import { readSession } from "@/modules/auth/session";
import { getIntegrationSettings } from "@/modules/integrations/settings";
import { UI_VERSION_COOKIE, resolveUiVersion } from "@/lib/ui-version";
import LegacyDashboard from "./legacy-dashboard";
import { TodayView } from "./today/today-view";

/**
 * `/dashboard`: «اليوم» بالواجهة الجديدة (v2) أو اللوحة الحالية (v1) — حسب مفتاح الواجهة (2.3ب).
 * اللوحة الحالية بتنحذف بحزمة 3.8 مع `v1`.
 */
export default async function DashboardPage() {
  const session = await readSession();
  const settings = session?.workspaceId ? await getIntegrationSettings(prisma as never, session.workspaceId) : null;
  const version = resolveUiVersion({ cookie: cookies().get(UI_VERSION_COOKIE)?.value, setting: settings?.uiVersion });
  return version === "v2" ? <TodayView /> : <LegacyDashboard />;
}
