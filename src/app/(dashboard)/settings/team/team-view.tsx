"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, KeyRound, Plus, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { ROLE_BLURB, ROLE_OPTIONS as ROLES, RoleBlurbs, RoleMatrix } from "@/components/role-matrix";

type Member = {
  id: string;
  role: string;
  status: string;
  permissions: string[];
  expiresAt: string | null;
  user: { id: string; email: string | null; name: string | null };
};

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
  // تأكيدات العمليات الحساسة — بلا window.confirm الخام
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<Member | null>(null);
  // وضع فتح الحساب: دعوة حساب مسجل، أو إنشاء حساب جديد مباشرة (اسم + بريد + كلمة مرور)
  const [inviteMode, setInviteMode] = useState<"invite" | "create">("invite");
  const [inviteRole, setInviteRole] = useState("SALES_AGENT");
  // كل ما بتتفتح الدعوة بيرجع الدور الافتراضي — المنتقي والسطر الشارح لازم يتطابقوا.
  useEffect(() => {
    if (showInvite) setInviteRole("SALES_AGENT");
  }, [showInvite]);
  // إعادة تعيين كلمة مرور عضو من الإدارة
  const [pwTarget, setPwTarget] = useState<Member | null>(null);

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
    const create = inviteMode === "create";
    setBusy(true);
    try {
      await api("/api/workspaces/members", "POST", {
        email: form.get("email"),
        role: form.get("role"),
        ...(create ? { name: form.get("name"), password: form.get("password") } : {}),
      });
      setShowInvite(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشلت الدعوة");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(id: string, newPassword: string) {
    setBusy(true);
    try {
      await api(`/api/workspaces/members/${id}`, "PATCH", { newPassword });
      setPwTarget(null);
      setError(null);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشل تغيير كلمة المرور");
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
    setBusy(true);
    try {
      await api(`/api/workspaces/members/${id}`, "DELETE");
      setRemoveTarget(null);
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
          <EmptyState
            icon={<UserRound size={26} strokeWidth={1.75} />}
            title="لا أعضاء"
            description="ادعُ أول عضو في فريقك."
            action={<Button size="sm" onClick={() => setShowInvite(true)}>ادعُ عضو</Button>}
          />
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
                          onChange={(e) => {
                            if (e.target.value === "SUSPENDED") setSuspendTarget(m);
                            else void change(m.id, { status: e.target.value });
                          }}
                          aria-label="الحالة"
                        >
                          <option value="ACTIVE">نشط</option>
                          <option value="SUSPENDED">موقوف</option>
                        </Select>
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPwTarget(m)} title="تعيين كلمة مرور جديدة لهذا العضو">
                          <KeyRound size={13} /> كلمة المرور
                        </Button>
                        <Button size="sm" variant="danger" disabled={busy} onClick={() => setRemoveTarget(m)}>
                          <Trash2 size={13} /> إزالة
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      <GlassCard className="mt-3 p-4">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-bold text-ink [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-2">
              <ShieldCheck size={15} /> شو بيقدر كل دور؟
            </span>
            <ChevronDown size={16} className="shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-2 text-xs text-ink-muted">للقراءة بس — مأخوذ من صلاحيات النظام الفعلية. اختيار الدور بيتم من القوائم فوق.</p>
          <RoleBlurbs className="mt-3" />
          <RoleMatrix className="mt-3" />
        </details>
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

      <Dialog open={showInvite} onClose={() => setShowInvite(false)} title={inviteMode === "create" ? "إنشاء حساب جديد" : "دعوة عضو"}>
        <form onSubmit={invite} className="space-y-3">
          <div className="flex rounded-2xl border border-line bg-surface-2 p-1 text-xs">
            <button
              type="button"
              onClick={() => setInviteMode("invite")}
              className={`flex-1 rounded-xl px-3 py-2 font-semibold transition ${inviteMode === "invite" ? "bg-surface text-ink shadow-xs" : "text-ink-muted"}`}
            >
              دعوة حساب مسجل
            </button>
            <button
              type="button"
              onClick={() => setInviteMode("create")}
              className={`flex-1 rounded-xl px-3 py-2 font-semibold transition ${inviteMode === "create" ? "bg-surface text-ink shadow-xs" : "text-ink-muted"}`}
            >
              إنشاء حساب جديد
            </button>
          </div>
          {inviteMode === "create" && (
            <Field label="الاسم">
              <Input name="name" required minLength={2} maxLength={100} placeholder="مثال: محمد المبيعات" />
            </Field>
          )}
          <Field label="البريد الإلكتروني" hint={inviteMode === "create" ? "يُفتح الحساب فورًا بهذا البريد وكلمة المرور." : "يجب أن يكون مسجلًا مسبقًا في المنصة."}>
            <Input name="email" type="email" required dir="ltr" placeholder="name@example.com" />
          </Field>
          {inviteMode === "create" ? (
            <Field label="كلمة المرور" hint="8 أحرف على الأقل. كوّنها من الاسم والبريد (لا ترسلها بأي قناة غير آمنة).">
              <Input name="password" type="text" required minLength={8} maxLength={128} dir="ltr" autoComplete="off" className="num" />
            </Field>
          ) : null}
          <Field label="الدور" hint={ROLE_BLURB[inviteRole]}>
            <Select name="role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            {inviteMode === "create" ? "إنشاء الحساب وتنشيط العضوية" : "إرسال الدعوة (صالحة 7 أيام)"}
          </Button>
        </form>
      </Dialog>

      <Dialog open={pwTarget !== null} onClose={() => setPwTarget(null)} title="كلمة مرور جديدة">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const value = String(new FormData(e.currentTarget).get("newPassword") ?? "");
            if (pwTarget) void resetPassword(pwTarget.id, value);
          }}
          className="space-y-3"
        >
          <p className="text-xs text-ink-muted">
            لكلمة مرور جديدة لـ <span className="font-semibold text-ink">{pwTarget?.user.name}</span> ({pwTarget?.user.email}).
            أعلمها بها بصوتٍ آمن مباشرة — لا ترسلها برسالة.
          </p>
          <Field label="كلمة المرور الجديدة">
            <Input name="newPassword" type="text" required minLength={8} maxLength={128} dir="ltr" autoComplete="off" className="num" />
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            تعيين كلمة المرور
          </Button>
        </form>
      </Dialog>

      <ConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && void remove(removeTarget.id)}
        title={`إزالة العضو "${removeTarget?.user.name ?? ""}"؟`}
        body="سيفقد هذا العضو الوصول إلى مساحة العمل فورًا. لا تُحذف بياناته أو سجل تدقيقه."
        confirmLabel="إزالة العضو"
        busy={busy}
        danger
      />
      <ConfirmDialog
        open={suspendTarget !== null}
        onClose={() => setSuspendTarget(null)}
        onConfirm={() => {
          const target = suspendTarget;
          setSuspendTarget(null);
          target && void change(target.id, { status: "SUSPENDED" });
        }}
        title={`إيقاف وصول "${suspendTarget?.user.name ?? ""}"؟`}
        body="لن يستطيع العضو استخدام المنصة حتى يُعاد تفعيله. الجلسة الحالية تُبطل."
        confirmLabel="إيقاف العضو"
        busy={busy}
        danger
      />
    </div>
  );
}
