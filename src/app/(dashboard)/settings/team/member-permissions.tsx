"use client";

import { useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { PERMISSION_AREAS } from "@/modules/rbac/areas";
import { hasPermission, type Permission } from "@/modules/rbac/permissions";

/**
 * «صلاحيات فلان» (4.2، 04-PERMISSIONS §5.4): الدور للأغلبية، والاستثناء للعضو.
 * المفاتيح اللي من الدور معلّمة ومقفولة («من دوره»)، والباقي بيتقلّب — وبيتحفظ كإضافات بس
 * (ما في «سحب» من دور: اللي بدّه أقل بيختار دور أقل). الخادم هو الحكم: المانح لازم يملك اللي بيمنحه.
 */
export function MemberPermissionsDialog({
  open,
  onClose,
  member,
  busy,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  member: { id: string; role: string; permissions: string[]; user: { name: string | null } } | null;
  busy: boolean;
  onSave: (permissions: string[]) => void;
}) {
  const [extras, setExtras] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open && member) setExtras(new Set(member.permissions));
  }, [open, member]);

  const levels = useMemo(
    () =>
      member
        ? PERMISSION_AREAS.map((area) => ({
            area,
            levels: area.levels.map((level) => {
              const fromRole = level.perms.every((p) => hasPermission(member.role, [], p));
              const missing = level.perms.filter((p) => !hasPermission(member.role, [], p));
              return { level, fromRole, missing };
            }),
          }))
        : [],
    [member]
  );

  if (!member) return null;

  function toggle(missing: readonly Permission[], on: boolean) {
    setExtras((prev) => {
      const next = new Set(prev);
      for (const p of missing) (on ? next.add(p) : next.delete(p));
      return next;
    });
  }

  const dirty = JSON.stringify([...extras].sort()) !== JSON.stringify([...member.permissions].sort());

  return (
    <Dialog open={open} onClose={onClose} title={`صلاحيات ${member.user.name ?? "العضو"}`} className="max-w-xl">
      <div className="space-y-3" data-member-permissions>
        <p className="text-[11px] leading-relaxed text-ink-subtle">
          الدور بيعطي الأساس، وهون بتضيف استثناءات لهالعضو بس. المقفول «من دوره». لتقليل صلاحيات اختار دور أقل — وتغيير الدور بيمسح هالإضافات.
        </p>
        <div className="max-h-[55vh] space-y-3 overflow-y-auto pe-1">
          {levels.map(({ area, levels: ls }) => (
            <section key={area.key}>
              <h3 className="mb-1 text-xs font-bold text-ink">{area.label}</h3>
              <ul className="space-y-1">
                {ls.map(({ level, fromRole, missing }) => {
                  const checked = fromRole || missing.every((p) => extras.has(p));
                  return (
                    <li key={level.key}>
                      <label className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${fromRole ? "bg-surface-3/50 text-ink-muted" : "hover:bg-surface-hover"}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={fromRole || busy}
                          onChange={(e) => toggle(missing, e.target.checked)}
                          className="h-4 w-4 accent-brand-500"
                        />
                        <span className="flex-1">{level.label}</span>
                        {fromRole && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-ink-subtle">
                            <Lock size={10} /> من دوره
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button size="sm" loading={busy} disabled={!dirty} onClick={() => onSave([...extras].sort())}>
            احفظ الصلاحيات
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
