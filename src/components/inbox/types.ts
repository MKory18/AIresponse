export type ConversationListItem = {
  id: string;
  status: "OPEN" | "PENDING" | "RESOLVED" | "CLOSED";
  aiState: "AI_ACTIVE" | "AI_PAUSED" | "HUMAN_ACTIVE";
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  tags: string[];
  unreadCount: number;
  summary: string | null;
  lastCustomerMessageAt: string | null;
  lastAgentMessageAt: string | null;
  assignedAgentId: string | null;
  customer: { id: string; name: string | null; phone: string | null; status: string };
  channel: { type: string };
  assignedAgent: { id: string; name: string } | null;
};

export type MessageItem = {
  id: string;
  senderType: "CUSTOMER" | "AI" | "HUMAN" | "SYSTEM";
  direction: "INBOUND" | "OUTBOUND";
  type: string;
  text: string | null;
  mediaUrl: string | null;
  deliveryStatus: string;
  createdAt: string;
};

export type CustomerDetail = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  province: string | null;
  status: string;
  notes: string | null;
  tags: string[];
  identities: { id: string; channelType: string; channelExternalId: string }[];
  orders: { id: string; orderNumber: string; status: string; total: string; currency: string; createdAt: string }[];
  conversations: { id: string; status: string; aiState: string; updatedAt: string }[];
  aiSummary: string | null;
};

export const CHANNEL_LABELS: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  FACEBOOK: "Messenger",
  INSTAGRAM: "Instagram",
  TELEGRAM: "Telegram",
  WEB: "Web",
};

export const CHANNEL_ICONS: Record<string, string> = {
  WHATSAPP: "🟢",
  FACEBOOK: "🔵",
  INSTAGRAM: "🟣",
  TELEGRAM: "➤",
  WEB: "🌐",
};

export const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-emerald-50 text-emerald-700",
  PENDING: "bg-amber-50 text-amber-700",
  RESOLVED: "bg-slate-100 text-slate-600",
  CLOSED: "bg-slate-100 text-slate-500",
};
