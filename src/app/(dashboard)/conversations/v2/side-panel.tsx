"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { useRealtime } from "@/components/realtime/use-realtime";
import { useToast } from "@/components/ui/toast";
import { CustomerPanel } from "@/components/inbox/customer-panel";
import { CustomerEditCard } from "./customer-edit-card";
import type { CustomerDetail, DraftInfo } from "@/components/inbox/types";
import type { OrderCardCan } from "@/components/orders/order-card";
import type { OrderCardData } from "@/modules/orders/reader/card";

/**
 * اللوحة (3.1، 03 §5.2): بطاقة الطلب أول شي (نفس مكوّن الطلبات) + العميل + طلباته السابقة + السجل.
 * بتتحدّث لحالها بأحداث القارئ/الطلب (`reading.updated` · `order.updated` · `order.created`).
 */
export function SidePanel({
  conversationId,
  customer,
  setCustomer,
  pageName,
}: {
  conversationId: string | null;
  customer: CustomerDetail | null;
  setCustomer: (c: CustomerDetail) => void;
  pageName: string | null;
}) {
  const toast = useToast();
  const [card, setCard] = useState<{ card: OrderCardData; can: OrderCardCan } | null>(null);
  const [drafts, setDrafts] = useState<DraftInfo[]>([]);
  const current = useRef<string | null>(null);
  current.current = conversationId;

  const load = useCallback(async (id: string) => {
    try {
      const data = await api<OrderCardData & { can: OrderCardCan }>(`/api/conversations/${id}/order-card`);
      if (current.current !== id) return;
      const { can, ...c } = data;
      setCard(c.mode === "LEGACY_DRAFT" ? null : { card: c, can });
    } catch {
      if (current.current === id) setCard(null);
    }
    try {
      const d = await api<{ items?: DraftInfo[] }>(`/api/order-drafts?conversationId=${id}`);
      if (current.current === id) setDrafts((d.items ?? []).filter((x) => ["EMPTY", "COLLECTING", "READY", "CONFIRMING"].includes(x.state)));
    } catch {
      if (current.current === id) setDrafts([]);
    }
  }, []);

  useEffect(() => {
    setCard(null);
    setDrafts([]);
    if (conversationId) void load(conversationId);
  }, [conversationId, load]);

  useRealtime((change) => {
    const id = current.current;
    if (!id || (change.conversationId && change.conversationId !== id)) return;
    if (["message.inbound", "reading.updated", "order.updated", "order.created"].includes(change.type)) void load(id);
  });

  async function refreshProfile(): Promise<{ ok: boolean; message: string }> {
    if (!customer) return { ok: false, message: "ما في عميل محدد." };
    try {
      const r = await api<{ ok?: boolean; message?: string }>(`/api/customers/${customer.id}/refresh-profile`, { method: "POST" });
      if (r.ok) setCustomer(await api<CustomerDetail>(`/api/customers/${customer.id}`));
      return { ok: Boolean(r.ok), message: r.message ?? "تم التحديث." };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "تعذّر التحديث." };
    }
  }

  async function resetMemory(): Promise<void> {
    if (!conversationId) return;
    try {
      await api(`/api/conversations/${conversationId}/memory/reset`, { method: "POST" });
      toast.show("انحذفت ذاكرة المحادثة", "info");
    } catch {
      toast.show("تعذّر حذف ذاكرة المحادثة", "error");
    }
  }

  return (
    <>
      {customer && <CustomerEditCard key={customer.id} customer={customer} onSaved={setCustomer} />}
      <CustomerPanel
        customer={customer}
        orderDrafts={drafts}
        orderCard={card}
        onOrderChanged={() => conversationId && void load(conversationId)}
        pageName={pageName}
        onRefreshProfile={refreshProfile}
        onResetMemory={resetMemory}
      />
    </>
  );
}
