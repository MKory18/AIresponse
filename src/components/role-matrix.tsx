import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/cn";
import { hasPermission, type Permission } from "@/modules/rbac/permissions";
import { areaLevels } from "@/modules/rbac/areas";

/**
 * «شو بيقدر كل دور؟» — جدول للقراءة بصفحة الفريق.
 *
 * ⚠️ قبل: بتختار «مشرف» أو «مدير عام» وإنت مش شايف شو الفرق — الصلاحيات كانت بالكود بس.
 *
 * 🔧 هلأ: الخلايا محسوبة من مصفوفة `ROLE_PERMISSIONS` نفسها (`hasPermission`) — ما في
 * نسخة تانية تنحرف. هون بس الصفوف (قدرة ← صلاحية واحدة) والأسماء. الجدول للعرض؛
 * ما بيغيّر أي صلاحية. `tests/role-matrix.test.ts` بيحرس الأدوار والادّعاءات.
 */

/** الأدوار المتاحة للاختيار — مصدر واحد للأسماء (القوائم + الجدول). SUPER_ADMIN داخلي. */
export const ROLE_OPTIONS = [
  { value: "OWNER", label: "مالك" },
  { value: "ADMIN", label: "شريك إداري" },
  { value: "MANAGER", label: "مشرف" },
  { value: "SALES_AGENT", label: "موظف مبيعات" },
  { value: "SUPPORT_AGENT", label: "موظف دعم" },
  { value: "VIEWER", label: "مشاهد" },
] as const;

/** سطر لكل دور بلغة المالك — بيظهر تحت قائمة الدور وفوق الجدول. */
export const ROLE_BLURB: Record<string, string> = {
  OWNER: "مالك — كل شي، وهو الوحيد اللي بيدير المالكين وبيحذف الطلبات نهائيًا.",
  ADMIN: "شريك إداري — كل شي ما عدا إدارة المالكين والحذف النهائي للطلبات.",
  MANAGER: "مشرف — بيدير الشغل اليومي والوكيل الذكي والمتجر وبيعتمد الخصم والحملات، بلا الفريق ولا الربط ولا مساحة العمل.",
  SALES_AGENT: "موظف مبيعات — بيرد وبيستلم المحادثات وبيثبّت الطلبات وبيعدّلها وبيلغيها؛ الباقي قراءة بس.",
  SUPPORT_AGENT: "موظف دعم — بيرد وبيستلم المحادثات؛ بيشوف الطلبات بلا تعديل. الباقي قراءة بس.",
  VIEWER: "مشاهد — بيشوف بس، ما بيرد ولا بيعدّل.",
};

/**
 * الصفوف: مستوى من كل مجال (`PERMISSION_AREAS` — 04-PERMISSIONS §4.3) بدل القائمة اليدوية.
 * الدور «يقدر» بالصف لو ملك **كل** رموز المستوى. قواعد «مالك بس» صارت رموز فبتظهر صح.
 */
export const CAPABILITIES: ReadonlyArray<{ id: string; label: string; perms: readonly Permission[]; perm: Permission }> = areaLevels().map((l) => ({
  id: l.id,
  label: l.label,
  perms: l.level.perms,
  perm: l.level.perms[0]!,
}));

/** هل الدور بيملك كل رموز الصف؟ (مصدر واحد للجدول والاختبارات) */
export function roleCan(role: string, cap: { perms: readonly Permission[] }, memberPermissions: string[] = []): boolean {
  return cap.perms.every((p) => hasPermission(role, memberPermissions, p));
}

/** الأدوار بسطر لكل واحد — فوق الجدول. */
export function RoleBlurbs({ className }: { className?: string }) {
  return (
    <ul className={cn("grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2", className)}>
      {ROLE_OPTIONS.map((r) => {
        const [name, ...rest] = (ROLE_BLURB[r.value] ?? r.label).split(" — ");
        return (
          <li key={r.value} className="text-ink-muted">
            <strong className="font-bold text-ink">{name}</strong>
            {rest.length > 0 && <> — {rest.join(" — ")}</>}
          </li>
        );
      })}
    </ul>
  );
}

/** الجدول: صف لكل قدرة، عمود لكل دور. الخلية من `hasPermission` — بلا نسخة تانية. */
export function RoleMatrix({ className }: { className?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table data-role-matrix className="data-table min-w-[560px]">
        <caption className="sr-only">ما يقدر عليه كل دور بالنظام</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky start-0 bg-surface-3">
              القدرة
            </th>
            {ROLE_OPTIONS.map((r) => (
              <th key={r.value} scope="col" className="!text-center">
                {r.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CAPABILITIES.map((c) => (
            <tr key={c.id}>
              <th scope="row" className="sticky start-0 bg-surface-2 px-4 py-3 text-start text-[13px] font-medium text-ink">
                {c.label}
              </th>
              {ROLE_OPTIONS.map((r) => {
                const can = roleCan(r.value, c);
                return (
                  <td key={r.value} data-can={can ? "yes" : "no"} className="text-center">
                    {can ? (
                      <Check size={16} strokeWidth={2.5} aria-hidden className="mx-auto text-emerald-700 dark:text-emerald-400" />
                    ) : (
                      <Minus size={16} aria-hidden className="mx-auto text-ink-subtle" />
                    )}
                    <span className="sr-only">{can ? "يقدر" : "لا يقدر"}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
