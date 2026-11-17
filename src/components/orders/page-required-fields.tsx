"use client";

import { useEffect, useState } from "react";
import { GlassCard } from "@/components/ui/card";
import { api } from "@/lib/api-client";
import { OrderFieldsSection } from "./order-fields-section";

interface Row {
  id: string;
  type: string;
  displayName: string | null;
  externalId: string | null;
}

/**
 * «المطلوب لإكمال الطلب لكل صفحة» (3.5/3.6): كان جوّا بطاقة كل صفحة بـ«القنوات»، وانتقل لقواعد الطلب (مكانه المنطقي: الطلب
 * بيكتمل ببيانات). نفس القسم والمسار (`/api/channels/by-id/[id]/order-fields`) بلا تغيير سلوك.
 */
export function PageRequiredFields() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    api<{ channels: Row[] }>("/api/channels")
      .then((r) => setRows(r.channels.filter((c) => c.type !== "WEB")))
      .catch(() => setRows([]));
  }, []);

  if (!rows || rows.length === 0) return null;
  return (
    <GlassCard className="space-y-2 p-4 sm:p-5" data-page-required-fields>
      <h2 className="text-sm font-bold text-ink">المطلوب لإكمال الطلب لكل صفحة</h2>
      {rows.map((c) => (
        <div key={c.id}>
          <p className="mt-2 text-xs font-semibold text-ink-muted">{c.displayName || c.externalId || c.type}</p>
          <OrderFieldsSection channelId={c.id} />
        </div>
      ))}
    </GlassCard>
  );
}
