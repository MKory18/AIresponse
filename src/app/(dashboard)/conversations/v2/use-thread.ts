"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import type { AssignmentActivity, CustomerDetail, MessageItem, OpenHandoff } from "@/components/inbox/types";
import { idempotencyKey, mergeMessages } from "./model";

interface Detail {
  customerId: string;
  openHandoff?: OpenHandoff;
  assignmentHistory?: AssignmentActivity[];
}

/**
 * المحادثة المفتوحة (3.1): الرسائل + العميل + التحويل المفتوح + السجل، وإرسال بمفتاح عدم تكرار وتفاؤل (optimistic)،
 * وإعادة إرسال، وملاحظة داخلية. فشل الإرسال بيظهر **جنب الرسالة** (سطر أحمر + «أعد الإرسال») مش بتوست بس.
 */
export function useThread(conversationId: string | null, onRead: (id: string) => void) {
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [openHandoff, setOpenHandoff] = useState<OpenHandoff>(null);
  const [activity, setActivity] = useState<AssignmentActivity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const current = useRef<string | null>(null);
  current.current = conversationId;

  const refreshMessages = useCallback(async (id: string) => {
    const mine = ++seq.current;
    try {
      const data = await api<{ items: MessageItem[] }>(`/api/conversations/${id}/messages`);
      if (mine !== seq.current || current.current !== id) return;
      setMessages((prev) => mergeMessages(data.items, prev));
    } catch {
      /* الاستطلاع الصامت: آخر نتيجة بتضل */
    }
  }, []);

  const loadAll = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      setOpenHandoff(null);
      setActivity([]);
      setCustomer(null);
      try {
        const [msgs, conv] = await Promise.all([api<{ items: MessageItem[] }>(`/api/conversations/${id}/messages`), api<Detail>(`/api/conversations/${id}`)]);
        if (current.current !== id) return;
        setMessages(msgs.items);
        setOpenHandoff(conv.openHandoff ?? null);
        setActivity(conv.assignmentHistory ?? []);
        api<CustomerDetail>(`/api/customers/${conv.customerId}`)
          .then((c) => current.current === id && setCustomer(c))
          .catch(() => undefined);
        onRead(id);
        void api(`/api/conversations/${id}/read`, { method: "POST", json: { isRead: true } }).catch(() => undefined);
      } catch (e) {
        if (current.current === id) setError(e instanceof Error ? e.message : "تعذّر تحميل المحادثة");
      } finally {
        if (current.current === id) setLoading(false);
      }
    },
    [onRead]
  );

  useEffect(() => {
    setMessages([]);
    if (conversationId) void loadAll(conversationId);
  }, [conversationId, loadAll]);

  const patchMessage = (id: string, patch: Partial<MessageItem>) => setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  /** إرسال رد (نص و/أو وسيط من المكتبة). بيرجّع true عند القبول. */
  const send = useCallback(
    async (text: string, mediaId?: string): Promise<boolean> => {
      const id = conversationId;
      const body = text.trim();
      if (!id || (!body && !mediaId)) return false;
      const optimistic: MessageItem = {
        id: `optimistic-${Date.now()}`,
        senderType: "HUMAN",
        direction: "OUTBOUND",
        type: mediaId ? "IMAGE" : "TEXT",
        text: body || null,
        mediaUrl: null,
        deliveryStatus: "PENDING",
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimistic]);
      try {
        const data = await api<MessageItem>(`/api/conversations/${id}/messages`, {
          method: "POST",
          json: { ...(body ? { text: body } : {}), ...(mediaId ? { mediaId } : {}), idempotencyKey: idempotencyKey(id) },
        });
        patchMessage(optimistic.id, { id: data.id ?? optimistic.id, deliveryStatus: data.deliveryStatus ?? "SENT" });
        return true;
      } catch {
        patchMessage(optimistic.id, { deliveryStatus: "FAILED" });
        return false;
      }
    },
    [conversationId]
  );

  const retry = useCallback(
    async (m: MessageItem) => {
      const id = conversationId;
      if (!id || !["FAILED", "QUEUED", "PENDING"].includes(m.deliveryStatus)) return;
      patchMessage(m.id, { deliveryStatus: "QUEUED" });
      try {
        const data = await api<{ deliveryStatus?: string }>(`/api/conversations/${id}/messages/${m.id}/retry`, { method: "POST" });
        patchMessage(m.id, { deliveryStatus: data.deliveryStatus ?? "SENT" });
      } catch {
        patchMessage(m.id, { deliveryStatus: "FAILED" });
      }
    },
    [conversationId]
  );

  const note = useCallback(
    async (text: string): Promise<boolean> => {
      const id = conversationId;
      if (!id || !text.trim()) return false;
      try {
        const data = await api<{ note: MessageItem }>(`/api/conversations/${id}/notes`, { method: "POST", json: { text: text.trim() } });
        setMessages((prev) => [...prev, { ...data.note, isNote: true }]);
        return true;
      } catch {
        return false;
      }
    },
    [conversationId]
  );

  const reload = useCallback(() => (conversationId ? refreshMessages(conversationId) : Promise.resolve()), [conversationId, refreshMessages]);

  return { messages, customer, setCustomer, openHandoff, activity, loading, error, send, retry, note, reload, refreshMessages, reloadAll: () => (conversationId ? loadAll(conversationId) : Promise.resolve()) };
}
