import { redirect } from "next/navigation";
import { readSession } from "@/modules/auth/session";
import { prisma } from "@/core/db/prisma";
import { getAuthContext } from "@/modules/auth/context";
import { PERMISSIONS } from "@/modules/rbac/permissions";
import { NAV_ITEMS } from "./nav-items";
import { hasPermission } from "@/modules/rbac/permissions";
import DashboardNav from "@/components/dashboard-nav";
import type { Permission } from "@/modules/rbac/permissions";


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
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-l border-slate-200 bg-white lg:flex">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-bold text-brand-600">AI Commerce Engine</p>
          {workspaceName && <p className="mt-0.5 truncate text-xs text-slate-500">{workspaceName}</p>}
        </div>
        <DashboardNav items={navItems} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <p className="text-sm font-semibold text-slate-700">لوحة التحكم</p>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="text-sm text-slate-500 hover:text-red-600">
              تسجيل الخروج ({user.name})
            </button>
          </form>
        </header>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
