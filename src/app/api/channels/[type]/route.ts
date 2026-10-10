import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { connectChannel, disconnectChannel } from "@/modules/channels/connect";

type Params = { type: string };

const KNOWN = ["INSTAGRAM", "TELEGRAM", "WHATSAPP", "TIKTOK", "FACEBOOK"] as const;

const connectSchema = z.object({
  igId: z.string().min(1).max(64).optional(),
  token: z.string().min(8).max(2048).optional(),
  botToken: z.string().min(8).max(512).optional(),
  phoneNumberId: z.string().min(1).max(64).optional(),
});

/**
 * POST connect — validates credentials LIVE against the provider before
 * storing anything (encrypted). TIKTOK refuses until access is approved;
 * FACEBOOK points at the OAuth flow. Permission: channels.connect.
 */
export const POST = createHandler(
  { body: connectSchema, permission: "channels.connect" },
  async ({ auth, body, params, req }) => {
    const { type } = params as Params;
    if (!(KNOWN as readonly string[]).includes(type)) {
      const { AppError } = await import("@/core/errors");
      throw new AppError("Unknown channel type", 422, "INVALID_BODY");
    }
    const ctx = { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined };
    return ok(await connectChannel(prisma, ctx, { type, ...body }), 201);
  }
);

const disconnectSchema = z.object({
  externalId: z.string().max(128).optional(),
});

/** DELETE disconnect — flips status (policy gates stop sends). Credentials kept for re-link. */
export const DELETE = createHandler(
  { body: disconnectSchema, permission: "channels.connect" },
  async ({ auth, body, params, req }) => {
    const { type } = params as Params;
    const ctx = { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined };
    return ok(await disconnectChannel(prisma, ctx, { type, externalId: body.externalId }));
  }
);
