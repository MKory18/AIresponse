"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Sidebar, type NavEntry } from "./app-sidebar";

export function AppShell({
  navItems,
  workspaceName,
  userName,
  children,
}: {
  navItems: NavEntry[];
  workspaceName: string;
  userName: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // The inbox is a full-bleed 3-pane surface; every other page gets page padding.
  const fullBleed = pathname === "/conversations";

  return (
    <div className="min-h-screen">
      <Sidebar
        items={navItems}
        workspaceName={workspaceName}
        userName={userName}
        open={open}
        onClose={() => setOpen(false)}
      />

      {/* Main column offset for the fixed sidebar on desktop (RTL sidebar on the right) */}
      <div className="flex min-h-screen flex-col lg:ps-60">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-line bg-surface-2/80 px-4 backdrop-blur lg:px-6">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setOpen(true)}
              aria-label={t.a11y.openMenu}
              className="rounded-lg p-2 text-ink-muted transition hover:bg-surface-3 hover:text-ink lg:hidden"
            >
              <Menu size={18} />
            </button>
            <p className="text-sm font-semibold text-ink">{t.app.tagline}</p>
          </div>
          <p className="hidden text-xs text-ink-subtle sm:block">{userName}</p>
        </header>
        <main className={cn("min-w-0 flex-1", !fullBleed && "p-4 lg:p-6")}>{children}</main>
      </div>
    </div>
  );
}