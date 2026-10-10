import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listChannels } from "@/modules/channels/connect";

/** Secret-free channel overview for the management UI (channels.read). */
export const GET = createHandler(
  { permission: "channels.read" },
  async ({ auth }) => ok({ channels: await listChannels(prisma, auth!.workspaceId) })
);
