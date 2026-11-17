import { cookies } from "next/headers";
import { prisma } from "@/core/db/prisma";
import { readSession } from "@/modules/auth/session";
import { getIntegrationSettings } from "@/modules/integrations/settings";
import { UI_VERSION_COOKIE, resolveUiVersion } from "@/lib/ui-version";
import LegacyOrders from "./legacy-orders";
import { OrdersView } from "./v2/orders-view";

/**
 * `/orders`: الجدول الجديد (v2: تبويبات من الخادم · بحث · درج) أو الصفحة الحالية (v1) — حسب مفتاح الواجهة (2.3ب).
 * الصفحة الحالية بتنحذف بحزمة 3.8 مع `v1`.
 */
export default async function OrdersPage() {
  const session = await readSession();
  const settings = session?.workspaceId ? await getIntegrationSettings(prisma as never, session.workspaceId) : null;
  const version = resolveUiVersion({ cookie: cookies().get(UI_VERSION_COOKIE)?.value, setting: settings?.uiVersion });
  return version === "v2" ? <OrdersView /> : <LegacyOrders />;
}
