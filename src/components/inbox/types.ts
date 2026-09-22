import { Facebook, Globe, Instagram, MessageCircle, Send } from "lucide-react";
import type { LucideProps } from "lucide-react";

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

export type DraftInfo = {
  id: string;
  state: string;
  productName: string | null;
  quantity: number | null;
  phone: string | null;
  rawAddress: string | null;
  province: string | null;
  missingFields: string[];
};

export const CHANNEL_LABELS: Record<string, string> = {
  FACEBOOK: "فيسبوك ماسنجر",
  INSTAGRAM: "إنستغرام",
  WHATSAPP: "واتساب",
  TELEGRAM: "تيليغرام",
  WEB: "الويب",
};

export const CHANNEL_ICONS: Record<string, React.ComponentType<LucideProps>> = {
  FACEBOOK: Facebook,
  INSTAGRAM: Instagram,
  WHATSAPP: MessageCircle,
  TELEGRAM: Send,
  WEB: Globe,
};