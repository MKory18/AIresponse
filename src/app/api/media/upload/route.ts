import { NextRequest, NextResponse } from "next/server";
import { createHandler, ok } from "@/core/api/handler";
import { AppError } from "@/core/errors";
import { prisma } from "@/core/db/prisma";
import { uploadMedia } from "@/modules/media/service";

export const runtime = "nodejs";

const MEDIA_CATEGORIES = ["PRODUCT", "KNOWLEDGE", "FEEDBACK", "AVATAR", "BANNER", "OTHER"] as const;

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

  const categoryRaw = str("category");
  if (categoryRaw && !(MEDIA_CATEGORIES as readonly string[]).includes(categoryRaw)) {
    throw new AppError(`Invalid category: ${categoryRaw}`, 422, "VALIDATION_ERROR");
  }
  const productIdRaw = str("productId") ?? null;
  if (productIdRaw && !/^[A-Za-z0-9_-]{8,}$/.test(productIdRaw)) {
    throw new AppError("Invalid productId", 422, "VALIDATION_ERROR");
  }

  const data = Buffer.from(await file.arrayBuffer());
  // Validate real bytes, not just the client-supplied File.size.
  if (data.length !== file.size) {
    throw new AppError("File size mismatch", 422, "VALIDATION_ERROR");
  }

  const asset = await uploadMedia(prisma, auth!, {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    size: data.length,
    data,
    category: (categoryRaw as (typeof MEDIA_CATEGORIES)[number] | undefined) as never,
    productId: productIdRaw,
    title: str("title") ?? null,
    description: str("description") ?? null,
    tags: str("tags") ? str("tags")!.split(",").map((t) => t.trim()).filter(Boolean) : [],
  });

  return ok(asset, 201);
});
