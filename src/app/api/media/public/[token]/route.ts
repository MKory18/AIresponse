import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { prisma } from "@/core/db/prisma";
import { contentDispositionInline, getStorage } from "@/modules/media/storage";
import { verifyPayload } from "@/core/crypto";

export const runtime = "nodejs";

type Params = { token: string };

/**
 * Public signed media delivery. The token contains:
 * - mediaId: the MediaAsset id
 * - workspaceId: workspace binding (for defense in depth)
 * - exp: Unix timestamp expiration
 *
 * No authentication/session required. Token is validated cryptographically.
 */
export const GET = async (
  _req: Request,
  { params }: { params: Promise<Params> }
) => {
  const { token } = await params;
  if (!token || token.length > 1024) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  // verifyPayload already enforces absolute exp; expired/tampered/malformed
  // tokens all map to 404 so validity cannot be probed via status codes, and
  // the private endpoint stays the only authenticated path.
  const payload = verifyPayload(token);
  if (!payload) {
    return NextResponse.json({ error: "INVALID_TOKEN" }, { status: 404 });
  }

  const mediaId = typeof payload.mediaId === "string" ? payload.mediaId : null;
  const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : null;
  const exp = typeof payload.exp === "number" ? payload.exp : 0;

  if (!mediaId || !workspaceId || exp === 0) {
    return NextResponse.json({ error: "INVALID_TOKEN" }, { status: 404 });
  }

  if (Math.floor(Date.now() / 1000) > exp) {
    return NextResponse.json({ error: "INVALID_TOKEN" }, { status: 404 });
  }

  const asset = await prisma.mediaAsset.findFirst({
    where: { id: mediaId, workspaceId },
    select: { id: true, mimeType: true, title: true, storageKey: true, workspaceId: true },
  });

  if (!asset || asset.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const file = await getStorage().get(asset.storageKey);
  if (!file) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  return new NextResponse(Readable.toWeb(file.stream) as ReadableStream, {
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(file.size),
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": contentDispositionInline(asset.title ?? "file"),
      "X-Content-Type-Options": "nosniff",
    },
  });
};