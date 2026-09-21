import { NextRequest, NextResponse } from "next/server";
import { createHandler, ok } from "@/core/api/handler";
import { AppError } from "@/core/errors";
import { prisma } from "@/core/db/prisma";
import { uploadMedia } from "@/modules/media/service";

export const runtime = "nodejs";

const MAX_BYTES = 100 * 1024 * 1024;

/**
 * Multipart upload. Validation (mime/extension/size) happens inside
 * uploadMedia → validateUpload. Storage backend is abstracted.
 */
export const POST = createHandler({ permission: "media.write" }, async ({ auth, req }) => {
  const req2 = req as NextRequest;
  const form = await req2.formData().catch(() => {
    throw new AppError("Expected multipart/form-data", 400, "INVALID_BODY");
  });
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("file field is required", 422, "VALIDATION_ERROR");

  const str = (key: string) => {
    const v = form.get(key);
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  const asset = await uploadMedia(prisma, auth!, {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    data: Buffer.from(await file.arrayBuffer()),
    category: str("category") as never,
    productId: str("productId") ?? null,
    title: str("title") ?? null,
    description: str("description") ?? null,
    tags: str("tags") ? str("tags")!.split(",").map((t) => t.trim()).filter(Boolean) : [],
  });

  void MAX_BYTES;
  return ok(asset, 201);
});
