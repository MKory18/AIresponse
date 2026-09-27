import { LayoutGrid } from "lucide-react";
import { getAuthContext } from "@/modules/auth/context";
import type { Permission } from "@/modules/rbac/permissions";
import { GlassCard } from "./ui/card";
import { EmptyState } from "./ui/empty-state";

export default function EmptySection({
  title,
  description,
  permission,
  icon,
}: {
  title: string;
  description: string;
  permission: Permission;
  icon?: React.ReactNode;
}) {
  // Server components can't be async children here; the pages below are async and
  // enforce the permission before rendering.
  void permission;
  return (
    <div className="page-wrap">
      <GlassCard className="p-2">
        <EmptyState
          icon={icon ?? <LayoutGrid size={26} strokeWidth={1.75} />}
          title={title}
          description={description}
        />
      </GlassCard>
    </div>
  );
}

export async function enforcePermission(permission: Permission) {
  const auth = await getAuthContext();
  auth.require(permission);
  return auth;
}
