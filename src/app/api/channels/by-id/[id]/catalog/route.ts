import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { buildPageProductContext } from "@/modules/catalog/service";

/**
 * THE PAGE'S ACTIVE CATALOG + WHAT THE AI MAY USE FOR IT.
 *
 * One door for the channel screen (which catalog? how many products?
 * is the link healthy?) and the preview — the same function feeds the
 * reply path, so a preview showing a product the reply cannot use is
 * impossible. Prices, images, offers and stock read live from Product.
 */
export const GET = createHandler(
  { permission: "catalogs.read" },
  async ({ auth, params }) => {
    const { id } = params as { id: string };
    const channel = await prisma.channel.findFirst({
      where: { id, workspaceId: auth!.workspaceId },
      select: {
        id: true, type: true, displayName: true, externalId: true, status: true,
        account: { select: { pageName: true, externalAccountId: true } },
      },
    });
    if (!channel) return ok({ channel: null, assignment: null, catalog: null, status: "no_channel", products: [] });
    const ctx = await buildPageProductContext(prisma, auth!.workspaceId, id);
    const assignment =
      ctx.status === "ok"
        ? await prisma.catalogPageAssignment.findUnique({ where: { channelId: id } })
        : null;
    return ok({ channel, assignment, catalog: ctx.catalog, status: ctx.status, products: ctx.products });
  }
);
