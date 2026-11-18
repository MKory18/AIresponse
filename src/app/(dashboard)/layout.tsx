import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { readSession } from "@/modules/auth/session";
import { prisma } from "@/core/db/prisma";
import { AuthenticationError, AuthorizationError } from "@/core/errors";
import { getAuthContext, type AuthContext } from "@/modules/auth/context";
import { decidePageAccess, PATH_HEADER } from "@/modules/auth/page-guard";
import { listWorkspacesForUser } from "@/modules/workspaces/service";
import { NAV_GROUPS, visibleGroups } from "@/lib/nav-model";
import { PERMISSIONS } from "@/modules/rbac/permissions";
import { AppShellV2 } from "@/components/shell-v2/app-shell-v2";
import { ToastProvider } from "@/components/ui/toast";
import { ForcePasswordChange } from "@/components/auth/force-password-change";
import { InactiveWorkspace } from "@/components/auth/inactive-workspace";
import { PermissionsProvider } from "@/components/auth/permissions";
import { DeniedNotice } from "@/components/auth/denied-notice";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession();
  if (!session) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { name: true, email: true, mustChangePassword: true },
  });
  if (!user) redirect("/login");

  // 4.2: كلمة مرور مؤقتة من الإدارة ← شاشة تغيير إلزامية قبل أي صفحة (بلا قشرة ولا قائمة).
  if (user.mustChangePassword) {
    return (
      <ToastProvider>
        <ForcePasswordChange userName={user.name} />
      </ToastProvider>
    );
  }

  let auth: AuthContext | null = null;
  try {
    auth = await getAuthContext();
  } catch (err) {
    if (err instanceof AuthenticationError) redirect("/login");
    // 2.2: ما إله عضوية فعّالة بالمساحة ← شاشة «حسابك مش مفعّل» (مش القائمة كاملة).
    if (!(err instanceof AuthorizationError)) throw err;
  }

  if (!auth) {
    const workspaces = await listWorkspacesForUser(session.userId);
    return (
      <ToastProvider>
        <InactiveWorkspace userName={user.name} workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))} />
      </ToastProvider>
    );
  }

  // 2.2: حارس الصفحة من الخادم — رابط صفحة ممنوعة مباشرة بيرجّع لأول صفحة مسموحة (`?denied=1`).
  const pathname = headers().get(PATH_HEADER);
  if (pathname) {
    const decision = decidePageAccess(pathname, auth.can, NAV_GROUPS);
    if (decision.kind === "redirect") redirect(decision.to);
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: auth.workspaceId },
    select: { name: true },
  });
  const groups = visibleGroups(NAV_GROUPS, auth.can);
  const permissions = PERMISSIONS.filter((p) => auth!.can(p));

  return (
    <ToastProvider>
      <PermissionsProvider permissions={permissions}>
        <AppShellV2 groups={groups} workspaceName={workspace?.name ?? ""} userName={user.name}>
          <DeniedNotice />
          {children}
        </AppShellV2>
      </PermissionsProvider>
    </ToastProvider>
  );
}
