import { getAuthContext } from "@/modules/auth/context";
import type { Permission } from "@/modules/rbac/permissions";

export default function EmptySection({
  title,
  description,
  permission,
}: {
  title: string;
  description: string;
  permission: Permission;
}) {
  // Server components can't be async children here; the pages below are async and
  // enforce the permission before rendering.
  void permission;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{title}</h1>
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
        <p className="font-medium text-slate-600">{title}</p>
        <p className="mt-2 text-sm text-slate-500">{description}</p>
      </div>
    </div>
  );
}

export async function enforcePermission(permission: Permission) {
  const auth = await getAuthContext();
  auth.require(permission);
  return auth;
}
