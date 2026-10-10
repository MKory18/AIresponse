"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard, PageHeader } from "@/components/ui/card";

type Member = {
  id: string;
  role: string;
  status: string;
  permissions: string[];
  expiresAt: string | null;
  user: { id: string; email: string | null; name: string | null };
};

const ROLES: Array<{ value: string; label: string }> = [
  { value: "OWNER", label: "مالك" },
  { value: "ADMIN", label: "مدير عام" },
  { value: "MANAGER", label: "مشرف" },
  { value: "SALES_AGENT", label: "موظف مبيعات" },
  { value: "SUPPORT_AGENT", label: "موظف دعم" },
  { value: "VIEWER", label: "مشاهد" },
];

const STATUS_AR: Record<string, string> = {
  ACTIVE: "نشط",
  INVITED: "مدعو",
  SUSPENDED: "موقوف",
};

const ROLE_AR: Record<string, string> = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));

async function api(path: string, method: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error((data.message as string) ?? (data.error as string) ?? "فشل الطلب");
  return data;
}

export default function TeamView() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wsName, setWsName] = useState("");
  const [wsSaving, setWsSaving] = useState(false);
  const [wsMsg, setWsMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = (await api("/api/workspaces/members", "GET")) as { members: Member[] };
      setMembers(data.members);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل التحميل");
    }
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api("/api/workspaces/members", "POST", {
        email: form.get("email"),
        role: form.get("role"),
      });
      setShowInvite(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشلت الدعوة");
    } finally {
      setBusy(false);
    }
  }

  async function change(id: string, patch: Record<string, unknown>) {
    setBusy(true);
    try {
      await api(`/api/workspaces/members/${id}`, "PATCH", patch);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشل التعديل");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("إزالة هذا العضو من مساحة العمل؟")) return;
    setBusy(true);
    try {
      await api(`/api/workspaces/members/${id}`, "DELETE");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشل الإزالة");
    } finally {
      setBusy(false);
    }
  }

  async function renameWorkspace(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setWsSaving(true);
    setWsMsg(null);
    try {
      await api("/api/workspaces", "PUT", { name: wsName });
      setWsMsg("تم حفظ اسم مساحة العمل");
      setWsName("");
    } catch (err) {
      setWsMsg(err instanceof Error ? err.message : "فشل الحفظ");
    } finally {
      setWsSaving(false);
    }
  }

  return (
    <div className="page-wrap">
      <PageHeader
        title="الفريق والصلاحيات"
        description="الأعضاء، الدعوات، الأدوار، والإيقاف — كل عملية إدارية مسجلة بسجل التدقيق."
        actions={
          <Button size="sm" onClick={() => setShowInvite(true)}>
            <Plus size={14} /> دعوة عضو
          </Button>
        }
      />
      {error && (
        <GlassCard className="mb-3 border-red-200 p-3 text-xs text-red-600 dark:border-red-900 dark:text-red-300">
          {error}
        </GlassCard>
      )}
      <GlassCard className="p-2">
        {loading ? (
          <div className="space-y-2 p-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : members.length === 0 ? (
          <EmptyState icon={<UserRound size={26} strokeWidth={1.75} />} title="لا أعضاء" description="ادعُ أول عضو في فريقك." />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>العضو</th>
                  <th>الدور</th>
                  <th>الحالة</th>
                  <th>إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="text-sm font-semibold text-ink">{m.user.name ?? "—"}</div>
                      <div className="num text-xs text-ink-subtle" dir="ltr">{m.user.email ?? ""}</div>
                      {m.status === "INVITED" && m.expiresAt && (
                        <div className="text-[11px] text-ink-subtle">
                          تنتهي الدعوة {new Date(m.expiresAt).toLocaleDateString("ar")}
                        </div>
                      )}
                    </td>
                    <td>
                      <Select
                        value={m.role}
                        disabled={busy}
                        onChange={(e) => change(m.id, { role: e.target.value })}
                        aria-label="الدور"
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <Badge tone={m.status}>{STATUS_AR[m.status] ?? m.status}</Badge>
                        <Select
                          value={m.status}
                          disabled={busy || m.status === "INVITED"}
                          onChange={(e) => change(m.id, { status: e.target.value })}
                          aria-label="الحالة"
                        >
                          <option value="ACTIVE">نشط</option>
                          <option value="SUSPENDED">موقوف</option>
                        </Select>
                      </div>
                    </td>
                    <td>
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => remove(m.id)}>
                        <Trash2 size={13} /> إزالة
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      <GlassCard className="mt-3 p-4">
        <h2 className="mb-2 text-sm font-bold text-ink">اسم مساحة العمل</h2>
        <form onSubmit={renameWorkspace} className="flex flex-col gap-2 sm:flex-row">
          <Field label="الاسم الجديد">
            <Input value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="مثال: متجر الشام" minLength={2} maxLength={100} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" size="sm" loading={wsSaving} disabled={!wsName.trim()}>
              حفظ
            </Button>
          </div>
        </form>
        {wsMsg && <p className="mt-2 text-xs text-ink-muted">{wsMsg}</p>}
      </GlassCard>

      <Dialog open={showInvite} onClose={() => setShowInvite(false)} title="دعوة عضو">
        <form onSubmit={invite} className="space-y-3">
          <Field label="البريد الإلكتروني" hint="يجب أن يكون مسجلًا مسبقًا في المنصة.">
            <Input name="email" type="email" required dir="ltr" placeholder="name@example.com" />
          </Field>
          <Field label="الدور">
            <Select name="role" defaultValue="SALES_AGENT">
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            إرسال الدعوة (صالحة 7 أيام)
          </Button>
        </form>
      </Dialog>
    </div>
  );
}
