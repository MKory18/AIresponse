import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { createHandler } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getOwnedMedia } from "@/modules/media/service";
import { getStorage } from "@/modules/media/storage";

export const runtime = "nodejs";

type Params = { key: string };

/**
 * Authenticated file streaming. The storageKey's workspace prefix is verified
 * against the caller's workspace — users can never read another workspace's
 * files by guessing IDs or URLs.
 */
export const GET = createHandler(
  { permission: "media.read" },
  async ({ auth, params }) => {
    const { key } = params as Params;
    const decoded = decodeURIComponent(key);
    const workspacePrefix = `${auth!.workspaceId}/`;
    if (!decoded.startsWith(workspacePrefix)) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    // The storageKey belongs to exactly one MediaAsset; verify it exists in DB
    // and is owned by the caller's workspace.
    const asset = await prisma.mediaAsset.findFirst({ where: { workspaceId: auth!.workspaceId, storageKey: decoded } });
    if (!asset || asset.workspaceId !== auth!.workspaceId) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    const file = await getStorage().get(decoded);
    if (!file) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

    return new NextResponse(Readable.toWeb(file.stream) as ReadableStream, {
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Length": String(file.size),
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `inline; filename="${encodeURIComponent(asset.title ?? "file")}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
);
