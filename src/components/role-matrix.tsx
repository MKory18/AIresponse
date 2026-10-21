import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/cn";
import { hasPermission, type Permission } from "@/modules/rbac/permissions";

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
  { value: "ADMIN", label: "مدير عام" },
  { value: "MANAGER", label: "مشرف" },
  { value: "SALES_AGENT", label: "موظف مبيعات" },
  { value: "SUPPORT_AGENT", label: "موظف دعم" },
  { value: "VIEWER", label: "مشاهد" },
] as const;

/** سطر لكل دور بلغة المالك — بيظهر تحت قائمة الدور وفوق الجدول. */
export const ROLE_BLURB: Record<string, string> = {
  OWNER: "مالك — صاحب الحساب، كل شي بما فيه الفريق والإعدادات.",
  ADMIN: "مدير عام — نفس صلاحيات المالك.",
  MANAGER: "مشرف — بيدير الشغل اليومي وبيعتمد الخصم والحملات، بس ما بيدير الفريق ولا مساحة العمل.",
  SALES_AGENT: "موظف مبيعات — بيرد على العملاء وبيعدّل بياناتهم وبيكتب الطلبات وبيستلم التحويلات؛ الباقي قراءة بس.",
  SUPPORT_AGENT: "موظف دعم — بيرد على العملاء وبيعدّل بياناتهم وبيشوف الطلبات بدون تعديل؛ الباقي قراءة بس.",
  VIEWER: "مشاهد — بيشوف بس، ما بيرد ولا بيعدّل.",
};

/** الصفوف: قدرة بلغة عادية ← الصلاحية الي بتحدّدها. مرتّبة من الشغل اليومي للإدارة. */
export const CAPABILITIES: ReadonlyArray<{ label: string; perm: Permission }> = [
  { label: "يشوف المحادثات والعملاء والطلبات", perm: "conversations.read" },
  { label: "يرد على العملاء", perm: "conversations.reply" },
  { label: "يعدّل بيانات العملاء", perm: "customers.write" },
  { label: "يكتب الطلبات ويعدّلها", perm: "orders.write" },
  { label: "يعطي خصم ضمن السقف", perm: "orders.discount" },
  { label: "يعتمد خصم فوق السقف", perm: "orders.discount.approve" },
  { label: "يشوف سعر الجملة", perm: "products.wholesale" },
  { label: "يستلم التحويلات من الذكاء ويحلّها", perm: "handoffs.claim" },
  { label: "يوزّع المحادثات على الموظفين", perm: "conversations.assign" },
  { label: "يحذف المحادثات", perm: "conversations.delete" },
  { label: "يعدّل المنتجات والكتالوجات", perm: "products.write" },
  { label: "يعدّل شخصية الوكيل والمعرفة", perm: "personas.write" },
  { label: "يضبط الذكاء الاصطناعي", perm: "ai.configure" },
  { label: "يربط القنوات", perm: "channels.connect" },
  { label: "يشغّل الأتمتة والمتابعات", perm: "automation.write" },
  { label: "ينشئ الحملات", perm: "campaigns.write" },
  { label: "يعتمد الحملات وينشرها", perm: "campaigns.approve" },
  { label: "يشوف استهلاك الذكاء", perm: "usage.read" },
  { label: "يشوف أداء الموظفين", perm: "analytics.agents" },
  { label: "يغيّر الإعدادات", perm: "settings.manage" },
  { label: "يدير الفريق وصلاحياتهم", perm: "users.manage" },
  { label: "يدير مساحة العمل", perm: "workspace.manage" },
];

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
            <tr key={c.perm}>
              <th scope="row" className="sticky start-0 bg-surface-2 px-4 py-3 text-start text-[13px] font-medium text-ink">
                {c.label}
              </th>
              {ROLE_OPTIONS.map((r) => {
                const can = hasPermission(r.value, [], c.perm);
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
