import { z } from "zod";

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const conversationListQuerySchema = listQuerySchema.extend({
  status: z.enum(["OPEN", "PENDING", "RESOLVED", "CLOSED"]).optional(),
  aiState: z.enum(["AI_ACTIVE", "AI_PAUSED", "HUMAN_ACTIVE"]).optional(),
  unreadOnly: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  // P4 server-side filters (all optional; invalid values rejected, never ignored silently).
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  assignee: z.string().max(64).optional(),
  channelType: z.enum(["FACEBOOK", "INSTAGRAM", "WHATSAPP", "TELEGRAM", "WEB"]).optional(),
  /** Exact page/channel filter (id verified workspace-owned server-side). */
  channelId: z.string().min(1).max(64).optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
});

export const updateCustomerSchema = z
  .object({
    name: z.string().trim().min(1).max(200).nullable().optional(),
    phone: z.string().trim().min(5).max(32).nullable().optional(),
    email: z.string().trim().toLowerCase().email().nullable().optional(),
    address: z.string().trim().max(500).nullable().optional(),
    province: z.string().trim().max(100).nullable().optional(),
    language: z.string().trim().max(10).nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    status: z
      .enum([
        "NEW_LEAD",
        "INTERESTED",
        "CONSIDERING",
        "READY_TO_BUY",
        "ORDERED",
        "REPEAT_CUSTOMER",
        "AT_RISK",
        "BLOCKED",
      ])
      .optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

export const updateConversationSchema = z
  .object({
    status: z.enum(["OPEN", "PENDING", "RESOLVED", "CLOSED"]).optional(),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

export const postMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(4000).optional(),
    type: z.enum(["TEXT", "IMAGE", "VIDEO", "AUDIO", "DOCUMENT"]).optional(),
    mediaUrl: z.string().url().max(2048).optional(),
    /** Library asset to attach — resolved server-side, never a pasted URL. */
    mediaId: z.string().cuid().optional(),
  })
  .refine((data) => data.text || data.mediaUrl || data.mediaId, { message: "text or mediaUrl or mediaId is required" });

export const assignSchema = z.object({
  agentId: z.string().cuid().nullable().or(z.literal("@me")),
});

export const readSchema = z.object({
  isRead: z.boolean().default(true),
});

export const noteSchema = z.object({
  text: z.string().trim().min(1).max(4000),
});
