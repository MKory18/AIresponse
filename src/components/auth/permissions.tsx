"use client";

import { createContext, useContext, useMemo } from "react";
import type { Permission } from "@/modules/rbac/permissions";

/**
 * 2.2: الواجهة بتعرف صلاحيات العضو الفعلية (دور + إضافات) من الخادم، فالزر اللي ما بيقدر يستعمله
 * ما بينعرض. هاد تحسين تجربة بس — الـAPI هو الحكم، والخادم بيرفض أي استدعاء بلا صلاحية.
 */
const PermissionsContext = createContext<ReadonlySet<string> | null>(null);

export function PermissionsProvider({ permissions, children }: { permissions: readonly string[]; children: React.ReactNode }) {
  const set = useMemo(() => new Set(permissions), [permissions]);
  return <PermissionsContext.Provider value={set}>{children}</PermissionsContext.Provider>;
}

/** `can("orders.write")` — بلا مزوّد (مثلًا صفحة خارج اللوحة) بيرجّع false: الأمان قبل الراحة. */
export function useCan(): (permission: Permission) => boolean {
  const set = useContext(PermissionsContext);
  return (permission) => (set ? set.has(permission) : false);
}

/** `<Can permission="orders.write">…</Can>` — يعرض الأبناء فقط لمن يملك الصلاحية (أو `fallback`). */
export function Can({
  permission,
  anyOf,
  fallback = null,
  children,
}: {
  permission?: Permission;
  anyOf?: readonly Permission[];
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  const can = useCan();
  const allowed = anyOf ? anyOf.some(can) : permission ? can(permission) : false;
  return <>{allowed ? children : fallback}</>;
}
