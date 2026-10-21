import { redirect } from "next/navigation";
import { readSession } from "@/modules/auth/session";
import { prisma } from "@/core/db/prisma";
import { getAuthContext } from "@/modules/auth/context";
import { NAV_GROUPS, visibleGroups } from "@/lib/nav-model";
import { hasPermission } from "@/modules/rbac/permissions";
import { AppShell } from "@/components/app-shell";
import { ToastProvider } from "@/components/ui/toast";


export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession();
  if (!session) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { name: true, email: true },
  });
  if (!user) redirect("/login");

  // عضو بلا مساحة فعّالة بيشوف القشرة كاملة (نفس السلوك السابق) — الصفحات
  // نفسها بتفرض الصلاحية من الخادم، مش القائمة.
  let groups = visibleGroups(NAV_GROUPS, () => true);
  let workspaceName = "";
  try {
    const auth = await getAuthContext();
    const workspace = await prisma.workspace.findUnique({
      where: { id: auth.workspaceId },
      select: { name: true },
    });
    workspaceName = workspace?.name ?? "";
    groups = visibleGroups(NAV_GROUPS, (permission) => hasPermission(auth.role, auth.memberPermissions, permission));
  } catch {
    // Member without active workspace still sees the shell.
  }

  return (
    <ToastProvider>
      <AppShell
        groups={groups}
        workspaceName={workspaceName}
        userName={user.name}
      >
        {children}
      </AppShell>
    </ToastProvider>
  );
}