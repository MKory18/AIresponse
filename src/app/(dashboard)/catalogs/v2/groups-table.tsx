"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import { Can } from "@/components/auth/permissions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { Menu } from "@/components/ui/menu";
import { Num } from "@/components/ui/formatted";
import { useToast } from "@/components/ui/toast";
import { RowToggle } from "../../products/v2/row-toggle";
import { GROUPS_STRINGS as S } from "./strings";
import type { Group } from "./use-groups";

/** إدارة المجموعات: اسم (رابط للتفاصيل) · منتجات · صفحات · مفتاح «شغّالة» · قائمة (احذف). الإنشاء بحوار. */
export function GroupsTable({
  groups,
  loading,
  onToggle,
  onCreate,
  onRemove,
}: {
  groups: Group[];
  loading: boolean;
  onToggle: (g: Group, next: boolean) => Promise<string | null>;
  onCreate: (name: string, description: string) => Promise<string | null>;
  onRemove: (g: Group, force: boolean) => Promise<string | null | "force">;
}) {
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const [forcing, setForcing] = useState<Group | null>(null);
  const C = S.create;

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    const err = await onCreate(name, description);
    setBusy(false);
    if (!err) {
      setCreateOpen(false);
      setName("");
      setDescription("");
    }
    toast.show(err ?? S.saved, err ? "error" : "success");
  }

  async function remove(g: Group, force: boolean) {
    setBusy(true);
    const r = await onRemove(g, force);
    setBusy(false);
    setDeleting(null);
    if (r === "force") return setForcing(g);
    setForcing(null);
    toast.show(r ?? S.saved, r ? "error" : "success");
  }

  const columns: Column<Group>[] = [
    {
      key: "name",
      header: S.nameCol,
      cell: (g) => (
        <span className="block min-w-0">
          <Link href={`/catalogs/${g.id}`} className="block truncate font-medium text-ink hover:text-primary focus-visible:outline-2 focus-visible:outline-focus">
            {g.name}
          </Link>
          {g.description && <span className="block truncate text-caption text-ink-muted">{g.description}</span>}
        </span>
      ),
    },
    { key: "products", header: S.productsCol, align: "end", cell: (g) => <Num value={g.products} /> },
    { key: "pages", header: S.pagesCountCol, align: "end", cell: (g) => <Num value={g.pages} /> },
    {
      key: "active",
      header: S.activeCol,
      cell: (g) => (
        <Can permission="catalogs.write" fallback={<span className="text-sm text-ink-muted">{g.isActive ? "شغّالة" : "متوقفة"}</span>}>
          <RowToggle
            checked={g.isActive}
            label={`${S.activeCol}: ${g.name}`}
            onChange={(next) => void onToggle(g, next).then((err) => toast.show(err ?? S.saved, err ? "error" : "success"))}
          />
        </Can>
      ),
    },
    {
      key: "actions",
      header: "",
      cell: (g) => (
        <Can permission="catalogs.write">
          <Menu label={`${S.actions}: ${g.name}`} items={[{ key: "delete", label: S.delete, icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: () => setDeleting(g) }]} />
        </Can>
      ),
    },
  ];

  return (
    <section className="space-y-2" data-groups-table>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{S.groupsTitle}</h2>
        <Can permission="catalogs.write">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} aria-hidden /> {S.addGroup}
          </Button>
        </Can>
      </div>
      <DataTable<Group>
        columns={columns}
        rows={groups}
        rowKey={(g) => g.id}
        loading={loading}
        caption={S.groupsTitle}
        empty={
          <EmptyState
            title={S.groupsEmpty}
            description={S.groupsEmptyHint}
            action={
              <Can permission="catalogs.write">
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus size={14} aria-hidden /> {S.addGroup}
                </Button>
              </Can>
            }
          />
        }
      />

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title={C.title} className="max-w-md">
        <div className="space-y-3">
          <Field label={C.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={C.namePh} maxLength={80} />
          </Field>
          <Field label={C.description}>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={C.descriptionPh} maxLength={500} />
          </Field>
          <p className="text-caption text-ink-muted">{C.hint}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {C.cancel}
            </Button>
            <Button onClick={() => void create()} disabled={!name.trim()} loading={busy}>
              {C.submit}
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog open={deleting !== null} onClose={() => setDeleting(null)} onConfirm={() => deleting && void remove(deleting, false)} title={`${S.deleteTitle} «${deleting?.name ?? ""}»`} body={S.deleteBody} confirmLabel={S.deleteConfirm} busy={busy} danger />
      <ConfirmDialog open={forcing !== null} onClose={() => setForcing(null)} onConfirm={() => forcing && void remove(forcing, true)} title={S.forceTitle} body={S.deleteBody} confirmLabel={S.forceConfirm} busy={busy} danger />
    </section>
  );
}
