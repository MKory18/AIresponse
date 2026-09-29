import { NextRequest, NextResponse } from "next/server";
import { createHandler, ok } from "@/core/api/handler";
import { AppError } from "@/core/errors";
import { prisma } from "@/core/db/prisma";
import { uploadMedia, validateUpload } from "@/modules/media/service";

export const runtime = "nodejs";

// Must match the Prisma MediaCategory enum — any other value fails at the DB layer.
const MEDIA_CATEGORIES = ["PRODUCT", "FEEDBACK", "TESTIMONIAL", "BRAND", "EDUCATIONAL", "OTHER"] as const;

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

  // Detect MIME type from extension if browser didn't provide a valid one.
  // Basename first so directory-like names can't confuse the fallback, and a
  // name without an extension yields "" (no guess) instead of the whole name.
  let mimeType = file.type;
  if (!mimeType || mimeType === "application/octet-stream") {
    const baseName = file.name.split(/[\\/]/).pop() ?? file.name;
    const ext = baseName.includes(".") ? baseName.split(".").pop()?.toLowerCase() ?? "" : "";
    const mimeFromExt: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
      mp4: "video/mp4",
      webm: "video/webm",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      pdf: "application/pdf",
      txt: "text/plain",
      md: "text/markdown",
      json: "application/json",
      csv: "text/csv",
    };
    if (ext && mimeFromExt[ext]) {
      mimeType = mimeFromExt[ext];
    }
  }

  // Pre-validate upload to catch issues early with a clear error
  validateUpload({ mimeType: mimeType || "application/octet-stream", filename: file.name, size: data.length });

  const asset = await uploadMedia(prisma, auth!, {
    filename: file.name,
    mimeType: mimeType || "application/octet-stream",
    size: data.length,
    data,
    category: (categoryRaw as (typeof MEDIA_CATEGORIES)[number] | undefined) as never,
    productId: productIdRaw,
    title: str("title")?.slice(0, 200) ?? null,
    description: str("description")?.slice(0, 2000) ?? null,
    tags: str("tags")
      ? str("tags")!.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30).map((t) => t.slice(0, 50))
      : [],
  });

  return ok(asset, 201);
});
