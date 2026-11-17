"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { Drawer } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { OrderCard, type OrderCardCan } from "@/components/orders/order-card";
import { OmsOrderCard } from "@/components/orders/oms-order-card";
import type { OrderCardData } from "@/modules/orders/reader/card";
import type { OrderRow } from "./use-orders";
import { ORDERS_STRINGS as S } from "./strings";

type CardResponse = OrderCardData & { can: OrderCardCan };

/**
 * درج الطلب (3.2، 03 §5.3): **نفس بطاقة الطلب** اللي بالمحادثات (مكوّن واحد) + وضع الـOMS + «افتح المحادثة».
 * طلب بلا محادثة (إدخال يدوي · قديم) بيعرض رابط صفحته الكاملة. الرابط الدائم `?order=<id>` بيتحكم فيه المستدعي.
 */
export function OrderDrawer({ order, onClose, onChanged }: { order: OrderRow | null; onClose: () => void; onChanged: () => void }) {
  const [card, setCard] = useState<CardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const conversationId = order?.conversationId ?? null;

  const load = useCallback(async () => {
    if (!conversationId) return;
    try {
      setCard(await api<CardResponse>(`/api/conversations/${conversationId}/order-card`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : S.loadError);
    }
  }, [conversationId]);

  useEffect(() => {
    setCard(null);
    setError(null);
    if (order) void load();
  }, [order, load]);

  return (
    <Drawer open={order !== null} onClose={onClose} title={order ? `${S.drawerTitle} ${order.orderNumber}` : S.drawerTitle}>
      {order && (
        <div className="space-y-4" data-order-drawer>
          {conversationId ? (
            <>
              {error && (
                <div role="alert" className="flex items-center justify-between gap-3 rounded-card border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-ink">
                  <span>{error}</span>
                  <Button size="sm" variant="secondary" onClick={() => void load()}>
                    {S.retry}
                  </Button>
                </div>
              )}
              {!card && !error && <Skeleton className="h-64" />}
              {card && (
                <OrderCard
                  card={card}
                  can={card.can}
                  onChanged={() => {
                    void load();
                    onChanged();
                  }}
                />
              )}
              <Link href={`/conversations?id=${conversationId}`} className="block text-sm font-semibold text-primary hover:underline">
                {S.openConversation}
              </Link>
            </>
          ) : (
            <p className="text-sm text-ink-muted">{S.noConversation}</p>
          )}
          <OmsOrderCard orderId={order.id} cancelled={order.status === "CANCELLED"} />
          <Link href={`/orders/${order.id}`} className="block text-sm font-semibold text-primary hover:underline">
            {S.openPage}
          </Link>
        </div>
      )}
    </Drawer>
  );
}
