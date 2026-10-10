import { AppError, NotFoundError } from "@/core/errors";
import { encryptSecret, randomId } from "@/core/crypto";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { getInstagramClient } from "./instagram/client";
import { getTelegramClient } from "./telegram/client";
import { getWhatsAppClient } from "./whatsapp/client";

/**
 * Channel connect/disconnect service (P5). Official APIs only; every
 * credential is validated live before anything is stored, encrypted at rest
 * (AES-256-GCM), and never returned or logged. Disconnect flips status to
 * DISCONNECTED (policy gates stop sends) while keeping credentials for
 * re-link — a disconnected channel can never become active via fallback.
 */

export type ConnectableChannel = "INSTAGRAM" | "TELEGRAM" | "WHATSAPP";

export interface ConnectResult {
  channelId: string;
  type: string;
  status: string;
  /** Follow-up the operator must perform outside the app (if any). */
  nextStep?: string | null;
  webhookUrl?: string | null;
}

async function upsertChannelWithAccount(
  db: Db,
  ctx: ActorContext,
  input: {
    type: "INSTAGRAM" | "TELEGRAM" | "WHATSAPP";
    displayName: string;
    externalId: string;
    provider: string;
    externalAccountId: string;
    token: string;
    accountName?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  const tokenEncrypted = encryptSecret(input.token);
  let channel = await db.channel.findFirst({
    where: { workspaceId: ctx.workspaceId, type: input.type as never, externalId: input.externalId },
  });
  if (!channel) {
    channel = await db.channel.create({
      data: {
        workspaceId: ctx.workspaceId,
        type: input.type as never,
        status: "CONNECTED",
        displayName: input.displayName,
        externalId: input.externalId,
      },
    });
  } else {
    channel = await db.channel.update({
      where: { id: (channel as { id: string }).id },
      data: { status: "CONNECTED", displayName: input.displayName },
    });
  }
  const channelId = (channel as { id: string }).id;
  const existingAccount = await (db as any).channelAccount?.findFirst?.({
    where: { provider: input.provider, externalAccountId: input.externalAccountId },
  });
  if (existingAccount) {
    const owner = await db.channel.findUnique({ where: { id: (existingAccount as { channelId: string }).channelId }, select: { workspaceId: true } });
    if (!owner || (owner as { workspaceId: string }).workspaceId !== ctx.workspaceId) {
      // Ownership proof: the same provider account cannot serve two workspaces.
      throw new AppError("This channel account is already connected elsewhere", 409, "ACCOUNT_CONFLICT");
    }
    await (db as any).channelAccount.update({
      where: { id: (existingAccount as { id: string }).id },
      data: { channelId, encryptedCredentials: tokenEncrypted, metadata: (input.metadata ?? {}) as never, tokenExpiresAt: null },
    });
  } else {
    await (db as any).channelAccount?.create?.({
      data: {
        channelId,
        provider: input.provider,
        externalAccountId: input.externalAccountId,
        pageName: input.accountName ?? null,
        encryptedCredentials: tokenEncrypted,
        metadata: (input.metadata ?? {}) as never,
      },
    });
  }
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "channel.connected",
    entityType: "Channel",
    entityId: channelId,
    metadata: { type: input.type, externalId: input.externalId },
  });
  return channelId;
}

export async function connectChannel(
  db: Db,
  ctx: ActorContext,
  input: { type: string; [k: string]: unknown }
): Promise<ConnectResult> {
  switch (input.type) {
    case "INSTAGRAM": {
      const igId = String(input.igId ?? "");
      const token = String(input.token ?? "");
      if (!igId || !token) throw new AppError("igId and token are required", 422, "INVALID_BODY");
      const account = await getInstagramClient().getAccount(token, igId);
      const channelId = await upsertChannelWithAccount(db, ctx, {
        type: "INSTAGRAM",
        displayName: `@${account.username || igId}`,
        externalId: igId,
        provider: "INSTAGRAM",
        externalAccountId: igId,
        token,
        accountName: account.username || null,
      });
      return { channelId, type: "INSTAGRAM", status: "CONNECTED" };
    }
    case "TELEGRAM": {
      const botToken = String(input.botToken ?? "");
      if (!botToken) throw new AppError("botToken is required", 422, "INVALID_BODY");
      const me = await getTelegramClient().getMe(botToken);
      // Per-channel webhook secret (Telegram's exact-match scheme).
      const secret = randomId(24).replace(/[^A-Za-z0-9_-]/g, "x");
      const channelId = await upsertChannelWithAccount(db, ctx, {
        type: "TELEGRAM",
        displayName: `@${me.username || me.id}`,
        externalId: me.username || String(me.id),
        provider: "TELEGRAM",
        externalAccountId: String(me.id),
        token: botToken,
        accountName: me.username || null,
        metadata: { tgWebhookSecret: secret },
      });
      // Best-effort auto-registration when the app URL is public HTTPS;
      // otherwise the operator sets it (URL + secret returned, documented).
      let webhookUrl: string | null = null;
      let nextStep: string | null = null;
      try {
        const appUrl = process.env.APP_URL ?? "";
        if (/^https:\/\//.test(appUrl)) {
          webhookUrl = `${appUrl.replace(/\/+$/, "")}/api/webhooks/telegram`;
          await getTelegramClient().setWebhook(botToken, webhookUrl, secret);
        } else {
          nextStep = "APP_URL is not public HTTPS — register the webhook via setWebhook with the URL below and this secret.";
          const { getEnv } = await import("@/core/env");
          webhookUrl = `${(getEnv().APP_URL ?? "").replace(/\/+$/, "")}/api/webhooks/telegram`;
        }
      } catch {
        nextStep = "Automatic webhook registration failed — call setWebhook manually with the URL and secret below.";
      }
      return { channelId, type: "TELEGRAM", status: "CONNECTED", nextStep, webhookUrl };
    }
    case "WHATSAPP": {
      const phoneNumberId = String(input.phoneNumberId ?? "");
      const token = String(input.token ?? "");
      if (!phoneNumberId || !token) throw new AppError("phoneNumberId and token are required", 422, "INVALID_BODY");
      const number = await getWhatsAppClient().getPhoneNumber(token, phoneNumberId);
      const channelId = await upsertChannelWithAccount(db, ctx, {
        type: "WHATSAPP",
        displayName: number.displayPhoneNumber || phoneNumberId,
        externalId: phoneNumberId,
        provider: "WHATSAPP",
        externalAccountId: phoneNumberId,
        token,
        accountName: number.displayPhoneNumber || null,
      });
      return { channelId, type: "WHATSAPP", status: "CONNECTED" };
    }
    case "TIKTOK":
      // Approval-gated: storing config without approved access would imply
      // readiness we cannot prove. Explicit refusal with the reason.
      throw new AppError("TikTok connect requires approved Business Messaging access (BLOCKED)", 501, "CHANNEL_NOT_SUPPORTED");
    case "FACEBOOK":
      throw new AppError("Use the Facebook OAuth flow (/api/channels/facebook/connect)", 501, "CHANNEL_NOT_SUPPORTED");
    default:
      throw new AppError(`Unknown channel type: ${String(input.type).slice(0, 32)}`, 422, "INVALID_BODY");
  }
}

export async function disconnectChannel(
  db: Db,
  ctx: ActorContext,
  input: { type: string; externalId?: string }
): Promise<{ disconnected: number }> {
  if (!["INSTAGRAM", "TELEGRAM", "WHATSAPP", "TIKTOK", "FACEBOOK", "WEB"].includes(input.type)) {
    throw new AppError("Unknown channel type", 422, "INVALID_BODY");
  }
  const rows = (await db.channel.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      type: input.type as never,
      ...(input.externalId ? { externalId: input.externalId } : {}),
    },
    select: { id: true },
  })) as { id: string }[];
  for (const row of rows) {
    await db.channel.update({ where: { id: row.id }, data: { status: "DISCONNECTED" } });
    await recordAudit(db, {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: "channel.disconnected",
      entityType: "Channel",
      entityId: row.id,
      metadata: { type: input.type },
    });
  }
  return { disconnected: rows.length };
}

export async function listChannels(db: Db, workspaceId: string) {
  // Bounded, secret-free overview for the management UI.
  const channels = (await db.channel.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true, status: true, displayName: true, externalId: true, aiPersonaId: true, updatedAt: true },
  })) as Array<{
    id: string; type: string; status: string; displayName: string | null; externalId: string | null; aiPersonaId: string | null; updatedAt: Date | string;
  }>;
  const accounts = (await (db as any).channelAccount?.findMany?.({
    where: { channelId: { in: channels.map((c) => c.id) } },
    select: { channelId: true, tokenExpiresAt: true, lastWebhookAt: true, lastSendAt: true },
  }).catch(() => [])) as Array<{ channelId: string; tokenExpiresAt: unknown; lastWebhookAt: unknown; lastSendAt: unknown }>;
  const byChannel = new Map(accounts.map((a) => [a.channelId, a]));
  return channels.map((c) => ({
    ...c,
    hasAccount: byChannel.has(c.id),
    tokenExpiring: Boolean(byChannel.get(c.id)?.tokenExpiresAt),
    lastWebhookAt: byChannel.get(c.id)?.lastWebhookAt ?? null,
    lastSendAt: byChannel.get(c.id)?.lastSendAt ?? null,
  }));
}
