import { redirect } from "next/navigation";
import { readSession } from "@/modules/auth/session";
import { prisma } from "@/core/db/prisma";
import { getAuthContext } from "@/modules/auth/context";
import { NAV_ITEMS } from "./nav-items";
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

  let navItems = NAV_ITEMS.map(({ href, label, icon }) => ({ href, label, icon }));
  let workspaceName = "";
  try {
    const auth = await getAuthContext();
    const workspace = await prisma.workspace.findUnique({
      where: { id: auth.workspaceId },
      select: { name: true },
    });
    workspaceName = workspace?.name ?? "";
    navItems = navItems.filter((item) =>
      hasPermission(auth.role, auth.memberPermissions, NAV_ITEMS.find((n) => n.href === item.href)!.permission)
    );
  } catch {
    // Member without active workspace still sees the shell.
  }

  return (
    <ToastProvider>
      <AppShell
        navItems={navItems}
        workspaceName={workspaceName}
        userName={user.name}
      >
        {children}
      </AppShell>
    </ToastProvider>
  );
}