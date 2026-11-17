import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/jobs/service";
import { getIntegrationSettings } from "@/modules/integrations/settings";

const log = childLogger("order-reader");

/**
 * رسالة التثبيت للعميل (§10.2) — نص **حتمي** (قالب، مش ذكاء) بمفتاح `order-confirm:{ws}:{order}`:
 *  - الموظف ماسك المحادثة (`HUMAN_ACTIVE`) ← ما بتنبعت: بتطلع ملاحظة داخلية «رد مقترح».
 *  - برا نافذة القناة أو صفحة تجميع فقط ← ما بتنبعت + ملاحظة داخلية.
 *  - `orderConfirmMessage = false` ← ولا شي.
 */
export interface ConfirmationInput {
  orderNumber: string;
  items: Array<{ name: string; quantity: number }>;
  total: number | string;
  currency: string;
  province: string | null;
  address: string | null;
  phone: string | null;
}

export function buildConfirmationText(i: ConfirmationInput): string {
  const lines = ["تم تثبيت طلبك ✅", `رقم الطلب: ${i.orderNumber}`];
  for (const it of i.items) lines.push(`${it.name} × ${it.quantity}`);
  lines.push(`الإجمالي: ${Number(i.total)} ${i.currency}`.trim());
  const where = [i.province, i.address].filter(Boolean).join(" — ");
  if (where) lines.push(`التوصيل إلى: ${where}`);
  const digits = (i.phone ?? "").replace(/\D/g, "");
  lines.push(
    digits.length >= 3
      ? `رح يتواصل معك فريقنا على الرقم المنتهي بـ ${digits.slice(-3)} لتأكيد التوصيل. لأي تعديل راسلنا هون.`
      : "رح يتواصل معك فريقنا لتأكيد التوصيل. لأي تعديل راسلنا هون."
  );
  return lines.join("\n");
}

type M = Record<string, Record<string, (a: unknown) => Promise<unknown>>>;

async function internalNote(db: Db, workspaceId: string, conversationId: string, orderId: string, text: string, kind: string) {
  const d = db as unknown as M;
  // عدم التكرار: ملاحظة وحدة لكل (نوع · طلب) حتى لو المهمة انعادت.
  const dup = (await d.message.findMany({ where: { conversationId, isNote: true }, take: 100, orderBy: { createdAt: "desc" } }).catch(() => [])) as Array<{ metadata?: { kind?: string; orderId?: string } }>;
  if (dup.some((m) => m.metadata?.kind === kind && m.metadata?.orderId === orderId)) return;
  await d.message.create({
    data: {
      conversationId,
      workspaceId,
      senderType: "SYSTEM",
      direction: "INBOUND",
      type: "TEXT",
      text,
      isNote: true,
      metadata: { kind, orderId },
    },
  });
}

export async function handleSendOrderConfirmation(
  db: Db,
  payload: Record<string, unknown>,
  workspaceId: string
): Promise<{ success: boolean; error?: string; outcome?: string }> {
  const orderId = String(payload.orderId ?? "");
  if (!orderId || !workspaceId) return { success: true, outcome: "NO_ORDER" };
  const d = db as unknown as M;
  const order = (await d.order.findUnique({ where: { id: orderId } })) as
    | (Record<string, unknown> & { workspaceId: string; conversationId: string | null; status: string; sealedAt: Date | null; orderNumber: string; total: unknown; currency: string; province: string | null; deliveryAddress: string | null; recipientPhone: string | null })
    | null;
  if (!order || order.workspaceId !== workspaceId) return { success: true, outcome: "NO_ORDER" };
  if (!order.sealedAt || order.status === "CANCELLED" || !order.conversationId) return { success: true, outcome: "NOT_SEALED" };

  const settings = await getIntegrationSettings(db, workspaceId);
  if (!settings.orderConfirmMessage) return { success: true, outcome: "DISABLED" };

  const items = (await d.orderItem.findMany({ where: { orderId } })) as Array<{ productNameSnapshot: string; quantity: number }>;
  const text = buildConfirmationText({
    orderNumber: order.orderNumber,
    items: items.map((i) => ({ name: i.productNameSnapshot, quantity: i.quantity })),
    total: order.total as number,
    currency: order.currency,
    province: order.province,
    address: order.deliveryAddress,
    phone: order.recipientPhone,
  });

  const conv = (await d.conversation.findUnique({ where: { id: order.conversationId } })) as { workspaceId: string; aiState?: string } | null;
  if (!conv || conv.workspaceId !== workspaceId) return { success: true, outcome: "NO_CONVERSATION" };
  if (conv.aiState === "HUMAN_ACTIVE") {
    await internalNote(db, workspaceId, order.conversationId, orderId, `رد مقترح — رسالة تثبيت الطلب (الموظف ماسك المحادثة، ما انبعتت):\n${text}`, "order_confirm_suggestion");
    return { success: true, outcome: "SUGGESTED_TO_STAFF" };
  }

  const { dispatchOutbound } = await import("@/modules/channels/outbound");
  const res = await dispatchOutbound(db as never, {
    workspaceId,
    conversationId: order.conversationId,
    sourceMessageId: `order-confirm:${workspaceId}:${orderId}`,
    text,
    senderType: "AI",
    automationSource: "AUTOMATION",
  });
  if (res.deliveryStatus !== "FAILED") return { success: true, outcome: "SENT" };

  const err = String(res.error ?? "");
  if (/^(POLICY_|COLLECTION_ONLY|HUMAN_ACTIVE|SEND_MODE_UNKNOWN)/.test(err)) {
    await internalNote(
      db,
      workspaceId,
      order.conversationId,
      orderId,
      `ما انبعتت رسالة تثبيت الطلب ${order.orderNumber} للعميل (${err.split(":")[0]}) — بلّغه من هون إذا لزم:\n${text}`,
      "order_confirm_blocked"
    );
    return { success: true, outcome: "BLOCKED_BY_POLICY" };
  }
  log.warn({ orderId, error: err.slice(0, 120) }, "order_confirmation_send_failed");
  return { success: false, error: err.slice(0, 120) || "SEND_FAILED", outcome: "FAILED" };
}
