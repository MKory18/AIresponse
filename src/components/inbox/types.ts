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
  customer: {
    id: string;
    name: string | null;
    phone: string | null;
    status: string;
    avatarUrl?: string | null;
    identities?: { displayName: string | null; avatarUrl?: string | null; channelType: string }[];
  };
  channel: {
    type: string;
    displayName?: string | null;
    externalId?: string | null;
    account?: { pageName?: string | null } | null;
  };
  assignedAgent: { id: string; name: string } | null;
  lastMessage?: { text: string | null; createdAt: string } | null;
  hasOpenHandoff?: boolean;
  aiPersona?: { id: string; name: string; source: "channel" | "workspace" } | null;
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
  avatarUrl?: string | null;
  notes: string | null;
  tags: string[];
  identities: { id: string; channelType: string; channelExternalId: string; displayName?: string | null; avatarUrl?: string | null }[];
  pageName?: string | null;
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

/**
 * Display-name priority: customer.name → channel-identity displayName →
 * phone → null (UI renders the central "عميل" fallback only then).
 */
export function displayNameOf(c: {
  customer: { name: string | null; phone: string | null; identities?: { displayName: string | null }[] };
}): string | null {
  if (c.customer.name) return c.customer.name;
  const identityName = c.customer.identities?.map((i) => i.displayName).find(Boolean);
  if (identityName) return identityName;
  if (c.customer.phone) return c.customer.phone;
  return null;
}

/**
 * Avatar photo priority: customer.avatarUrl → channel-identity avatarUrl →
 * null (UI renders initials). Never a random image.
 */
export function avatarOf(c: {
  customer: { avatarUrl?: string | null; identities?: { avatarUrl?: string | null }[] };
}): string | null {
  if (c.customer.avatarUrl) return c.customer.avatarUrl;
  return c.customer.identities?.map((i) => i.avatarUrl).find(Boolean) ?? null;
}

/** Page badge text from the conversation's own channel (never message text). */
export function pageNameOf(c: {
  channel: { displayName?: string | null; externalId?: string | null; account?: { pageName?: string | null } | null };
}): string | null {
  return c.channel.account?.pageName ?? c.channel.displayName ?? null;
}