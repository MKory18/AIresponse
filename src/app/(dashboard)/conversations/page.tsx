import { cookies } from "next/headers";
import { Suspense } from "react";
import Inbox from "@/components/inbox/inbox";
import { prisma } from "@/core/db/prisma";
import { readSession } from "@/modules/auth/session";
import { getIntegrationSettings } from "@/modules/integrations/settings";
import { UI_VERSION_COOKIE, resolveUiVersion } from "@/lib/ui-version";
import { ConversationsView } from "./v2/conversations-view";

/**
 * `/conversations`: الشاشة الجديدة (v2) أو الوارد الحالي (v1) — حسب مفتاح الواجهة (2.3ب).
 * الوارد الحالي (`components/inbox/inbox.tsx`) بينحذف بحزمة 3.8 مع `v1`.
 */
export default async function ConversationsPage() {
  const session = await readSession();
  const settings = session?.workspaceId ? await getIntegrationSettings(prisma as never, session.workspaceId) : null;
  const version = resolveUiVersion({ cookie: cookies().get(UI_VERSION_COOKIE)?.value, setting: settings?.uiVersion });
  return version === "v2" ? (
    <Suspense fallback={null}>
      <ConversationsView />
    </Suspense>
  ) : (
    <Inbox />
  );
}
